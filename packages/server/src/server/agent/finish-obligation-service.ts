import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { buildFinishReportNotificationPayload } from "@getpaseo/protocol/finish-report-notification";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { PushNotificationSender } from "../push/index.js";
import {
  getMigratedToFromLabels,
  HANDOFF_FROM_LABEL,
  isLimitShapedError,
} from "./account-failover-detector.js";
import { findExistingSuccessor } from "./account-failover-migration.js";
import {
  formatFinishNotificationBody,
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  setupFinishNotification,
} from "./agent-prompt.js";
import { pacedResume, type PaceResume } from "./resume-pacer.js";
import {
  armObligation,
  canPassToSuccessor,
  clearParked,
  DEFAULT_FINISH_REPORT_LADDER,
  escalateObligation,
  isUnresolved,
  markParked,
  markTransferred,
  planObligationStep,
  recordDeliveryAttempt,
  recordOperatorPush,
  recordOutcome,
  releaseObligation,
  summarizeOwedFinishReport,
  type AgentPresence,
  type FinishObligation,
  type FinishOutcomeReason,
  type FinishReportLadderConfig,
  type ObligationContext,
  type ObligationStep,
} from "./finish-obligation.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** Ceiling on steps one advance takes, so a planning bug cannot spin; the ladder needs about 5. */
const MAX_STEPS_PER_ADVANCE = 8;
/** Ceiling on the parent-label walk that finds an orchestrator; a real tree is a few deep. */
const MAX_ANCESTOR_HOPS = 32;

export interface FinishObligationServiceOptions {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  serverId: string;
  logger: Logger;
  /** Whether account failover will move an agent that hit a cap. Words the "errored" report. */
  isAccountFailoverEnabled?: () => boolean;
  /**
   * Whether restart recovery has claimed this agent to resume it (docs/restart-recovery.md). An
   * obligation whose child or owner is claimed is left alone until recovery lets go: a park, a
   * report or a wake then would race recovery's own resume prompt.
   */
  isClaimedByRestartRecovery?: (agentId: string) => boolean;
  /**
   * Whether a child's turn is held for an admission slot: in line, or read back from the queue
   * file after a restart and not yet re-sent. Such a child is pending, not stopped.
   */
  isTurnHeld?: (agentId: string) => boolean;
  /**
   * The daemon's shared ResumePacer. After a restart every parked child reports "stopped before
   * reporting" in the same sweep, and each report can start a turn in its owner; those go through
   * the pacer. Reports of an outcome seen live are not paced. Unset sends immediately.
   */
  paceResume?: PaceResume;
  sweepIntervalMs?: number;
  ladder?: Partial<FinishReportLadderConfig>;
  now?: () => number;
}

interface ChildPresence extends AgentPresence {
  parentAgentId: string | null;
  record: StoredAgentRecord | null;
  live: ManagedAgent | null;
}

/**
 * The durable half of notify-on-finish (docs/finish-reports.md).
 *
 * `setupFinishNotification` notices a child's outcome in memory; this service records what the
 * child owes on its stored record, delivers it through a bounded ladder (owner, retried; then the
 * nearest live agent above the owner; then a push), and re-arms from the records when the daemon
 * starts. The obligation is derived from the parent label plus notifyOnFinish, so an agent does
 * not have to cooperate for its parent to hear back.
 *
 * `index` mirrors every stored obligation and is the only writer of them: each change lands in
 * the index synchronously (so watchers can ask whether they are current) and is then written
 * through `AgentStorage.updateFinishObligations`, whose per-agent queue keeps writes in order.
 */
export class FinishObligationService {
  private readonly options: FinishObligationServiceOptions;
  private readonly ladder: FinishReportLadderConfig;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly index = new Map<string, FinishObligation[]>();
  /** Live watchers by `child|owner|generation`. */
  private readonly watchers = new Map<string, number>();
  /** Obligations a watcher saw running in this process, by `child|owner|generation`. */
  private readonly ranThisBoot = new Set<string>();
  /** `child|owner` pairs an advance is working on. */
  private readonly advancing = new Set<string>();
  /** Pairs asked to advance while one was in flight; the running advance goes round again. */
  private readonly advanceAgain = new Set<string>();
  /** Children whose obligations could not be written yet (no record) or failed to write. */
  private readonly dirty = new Set<string>();
  private readonly successorChecked = new Set<string>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private pushNotificationSender: PushNotificationSender | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private shuttingDown = false;
  private initialized = false;

  constructor(options: FinishObligationServiceOptions) {
    this.options = options;
    this.ladder = { ...DEFAULT_FINISH_REPORT_LADDER, ...options.ladder };
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /**
   * Rebuild the index from the stored records and start listening. Run once agent storage is
   * loaded and before anything can arm, so a restart knows every report still owed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const records = await this.options.agentStorage.list();
    let owed = 0;
    for (const record of records) {
      if (!record.finishObligations?.length) continue;
      this.index.set(record.id, [...record.finishObligations]);
      owed += record.finishObligations.filter(isUnresolved).length;
    }
    this.unsubscribe = this.options.agentManager.subscribe((event) => this.onEvent(event), {
      replayState: false,
    });
    this.options.logger.info(
      { owed, agentsWithObligations: this.index.size },
      "Finish reports re-armed from agent records",
    );
  }

  /** Start sweeping. The push sender exists only once the WebSocket server does. */
  start(input: { pushNotificationSender: PushNotificationSender }): void {
    this.pushNotificationSender = input.pushNotificationSender;
    if (this.timer || this.shuttingDown) return;
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Finish report sweep failed");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  /**
   * Called before the daemon closes every agent. Those closures are not outcomes: a watcher that
   * sees one leaves its report owed, and the next daemon to start picks it up.
   */
  prepareForShutdown(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async stop(): Promise<void> {
    this.prepareForShutdown();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await Promise.allSettled(this.pendingWrites);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** The obligations recorded for an agent, for tests and diagnostics. */
  getObligations(agentId: string): readonly FinishObligation[] {
    return this.index.get(agentId) ?? [];
  }

  /** Arm the report `ownerAgentId` is owed when `childAgentId` next reaches an outcome. */
  arm(input: {
    childAgentId: string;
    ownerAgentId: string;
    requireParentOwnership?: boolean;
    inheritedFrom?: string;
  }): number {
    const { obligations, armed } = armObligation(this.index.get(input.childAgentId) ?? [], {
      ownerAgentId: input.ownerAgentId,
      requireParentOwnership: input.requireParentOwnership,
      inheritedFrom: input.inheritedFrom,
      nowMs: this.now(),
    });
    this.index.set(input.childAgentId, obligations);
    this.persist(input.childAgentId);
    return armed.generation;
  }

  /** Whether a watcher armed under `generation` is still the one that reports. */
  isCurrent(childAgentId: string, ownerAgentId: string, generation: number): boolean {
    return this.find(childAgentId, ownerAgentId)?.generation === generation;
  }

  /** Registers a live watcher; returns its release function. */
  noteWatcher(childAgentId: string, ownerAgentId: string, generation: number): () => void {
    const key = watcherKey(childAgentId, ownerAgentId, generation);
    this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1);
    const live = this.options.agentManager.getAgent(childAgentId);
    if (live?.lifecycle === "running") this.ranThisBoot.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.watchers.get(key) ?? 1) - 1;
      if (remaining > 0) this.watchers.set(key, remaining);
      else this.watchers.delete(key);
    };
  }

  /** A watcher saw the child reach an outcome. Records it, then starts delivery. */
  async settle(input: {
    childAgentId: string;
    ownerAgentId: string;
    generation: number;
    reason: FinishOutcomeReason;
  }): Promise<void> {
    const message = await this.options.agentManager.getLastAssistantMessage(input.childAgentId);
    const current = this.find(input.childAgentId, input.ownerAgentId);
    if (!current) return;
    const next = recordOutcome(current, {
      generation: input.generation,
      reason: input.reason,
      nowMs: this.now(),
      message,
    });
    if (!next || !this.commit(input.childAgentId, current, next)) return;
    this.options.logger.info(
      { childAgentId: input.childAgentId, ownerAgentId: input.ownerAgentId, reason: input.reason },
      "Finish report owed",
    );
    await this.advance(input.childAgentId, input.ownerAgentId);
  }

  /**
   * Restart recovery told `ownerAgentId` that it could not bring `childAgentId` back
   * (docs/restart-recovery.md). That notice is the report, so the ladder's "stopped before
   * reporting" would say the same thing a second time. Releases the child's unresolved
   * obligations to that owner and returns how many. An owner the notice did not reach, such as
   * one further down the tree than the parent recovery resumed, still hears from the ladder.
   */
  releaseToldByRestartRecovery(input: { childAgentId: string; ownerAgentId: string }): number {
    let released = 0;
    // commit() swaps in a new array, so this one is safe to walk while releasing.
    for (const obligation of this.index.get(input.childAgentId) ?? []) {
      if (!isUnresolved(obligation) || obligation.ownerAgentId !== input.ownerAgentId) continue;
      const next = releaseObligation(obligation, {
        nowMs: this.now(),
        resolution: "restart recovery told the owner it could not resume the agent",
      });
      if (this.commit(input.childAgentId, obligation, next)) released += 1;
    }
    if (released > 0) {
      this.options.logger.info(
        { childAgentId: input.childAgentId, ownerAgentId: input.ownerAgentId },
        "Finish report released: restart recovery already told the owner",
      );
    }
    return released;
  }

  /**
   * An agent resumes work it had already reported as unfinished — account failover moved it to
   * another account and sent it a resume prompt. Its owner was told "errored"; re-arm so the
   * owner also hears when it actually finishes.
   */
  carryOver(agentId: string): void {
    for (const obligation of this.index.get(agentId) ?? []) {
      if (isUnresolved(obligation) || !canPassToSuccessor(obligation)) continue;
      this.arm({
        childAgentId: agentId,
        ownerAgentId: obligation.ownerAgentId,
        requireParentOwnership: obligation.requireParentOwnership,
        inheritedFrom: obligation.inheritedFrom,
      });
      this.options.logger.info(
        { agentId, ownerAgentId: obligation.ownerAgentId },
        "Finish report re-armed: the agent resumed unfinished work",
      );
    }
    this.ensureWatchers(agentId);
  }

  /** Runs one sweep; a call while another sweep is in flight returns without sweeping. */
  async tick(): Promise<void> {
    if (this.sweepInFlight || this.shuttingDown) return;
    this.sweepInFlight = true;
    try {
      await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<void> {
    for (const agentId of this.dirty) {
      this.persist(agentId);
    }
    await this.passObligationsToSuccessors();
    for (const [childAgentId, obligations] of this.index) {
      for (const obligation of obligations) {
        if (!isUnresolved(obligation)) continue;
        await this.advance(childAgentId, obligation.ownerAgentId);
      }
    }
  }

  private onEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_state") return;
    const agent = event.agent;
    this.checkForPredecessor(agent);
    const obligations = this.index.get(agent.id);
    if (!obligations) return;
    if (this.dirty.has(agent.id)) this.persist(agent.id);
    if (agent.lifecycle === "running") {
      let changed = false;
      const next = obligations.map((obligation) => {
        if (obligation.state !== "pending") return obligation;
        this.ranThisBoot.add(watcherKey(agent.id, obligation.ownerAgentId, obligation.generation));
        if (!obligation.parkedSince) return obligation;
        changed = true;
        return clearParked(obligation);
      });
      if (changed) {
        this.index.set(agent.id, next);
        this.persist(agent.id);
      }
      this.ensureWatchers(agent.id);
    }
    // Deferred out of this dispatch: a state emitted from inside it would reach the subscribers
    // after this one before the event being dispatched does — a child's watcher would see the
    // mirror update's snapshot, whose turnCanceled has already been consumed, and report a
    // cancelled turn as finished.
    const report = summarizeOwedFinishReport(this.index.get(agent.id));
    queueMicrotask(() => this.options.agentManager.setOwedFinishReport(agent.id, report));
  }

  /**
   * Attach a watcher to each pending obligation that has none — one re-armed after a restart,
   * inherited by a successor, or carried over after a move. Only a loaded agent can be watched;
   * an unloaded one is the sweep's, through parked detection.
   */
  private ensureWatchers(agentId: string): void {
    if (this.shuttingDown || !this.options.agentManager.getAgent(agentId)) return;
    for (const obligation of this.index.get(agentId) ?? []) {
      if (obligation.state !== "pending") continue;
      const key = watcherKey(agentId, obligation.ownerAgentId, obligation.generation);
      if ((this.watchers.get(key) ?? 0) > 0) continue;
      setupFinishNotification({
        agentManager: this.options.agentManager,
        agentStorage: this.options.agentStorage,
        childAgentId: agentId,
        callerAgentId: obligation.ownerAgentId,
        requireParentOwnership: obligation.requireParentOwnership,
        rearmedGeneration: obligation.generation,
        logger: this.options.logger,
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Successors

  /** Fast path: a successor announces itself with `handoff-from` on its first snapshot. */
  private checkForPredecessor(agent: ManagedAgent): void {
    const predecessorId = agent.labels[HANDOFF_FROM_LABEL]?.trim();
    if (!predecessorId || predecessorId === agent.id) return;
    if (this.successorChecked.has(agent.id)) return;
    if (!this.index.get(predecessorId)?.some(canPassToSuccessor)) return;
    this.successorChecked.add(agent.id);
    void this.passToSuccessor(predecessorId, agent.id).catch((error) => {
      this.options.logger.error(
        { err: error, predecessorId, successorId: agent.id },
        "Failed to pass a finish report to a successor",
      );
    });
  }

  /**
   * Slow path, every sweep: any agent that still owes work its successor carries on. Uses the
   * account-failover successor lookup, so a successor made by hand with `paseo import` counts
   * whether or not it carries the label.
   */
  private async passObligationsToSuccessors(): Promise<void> {
    const predecessors = [...this.index].filter(([, obligations]) =>
      obligations.some(canPassToSuccessor),
    );
    if (predecessors.length === 0) return;
    const records = await this.options.agentStorage.list();
    const byId = new Map(records.map((record) => [record.id, record]));
    for (const [predecessorId] of predecessors) {
      const predecessor = byId.get(predecessorId);
      if (!predecessor) continue;
      const successor = findExistingSuccessor(predecessor, records);
      if (!successor || successor.archivedAt) continue;
      await this.passToSuccessor(predecessorId, successor.id);
    }
  }

  private async passToSuccessor(predecessorId: string, successorId: string): Promise<void> {
    const successor = await this.options.agentStorage.get(successorId);
    if (!successor || successor.archivedAt) return;
    const successorParent = getParentAgentIdFromLabels(successor.labels);
    for (const obligation of this.index.get(predecessorId) ?? []) {
      if (!canPassToSuccessor(obligation) || obligation.ownerAgentId === successorId) continue;
      this.arm({
        childAgentId: successorId,
        ownerAgentId: obligation.ownerAgentId,
        // Kept only when the successor has the same parent. A successor made by hand often
        // lacks the label, and the rule would release the report the moment it was inherited.
        requireParentOwnership:
          obligation.requireParentOwnership && successorParent === obligation.ownerAgentId,
        inheritedFrom: predecessorId,
      });
      const current = this.find(predecessorId, obligation.ownerAgentId);
      if (current) {
        this.commit(
          predecessorId,
          current,
          markTransferred(current, { successorId, nowMs: this.now() }),
        );
      }
      this.options.logger.info(
        { predecessorId, successorId, ownerAgentId: obligation.ownerAgentId },
        "Finish report passed to the successor carrying on the work",
      );
    }
    this.ensureWatchers(successorId);
  }

  // ---------------------------------------------------------------------------------------------
  // The ladder

  private async advance(childAgentId: string, ownerAgentId: string): Promise<void> {
    const key = `${childAgentId}|${ownerAgentId}`;
    if (this.advancing.has(key)) {
      this.advanceAgain.add(key);
      return;
    }
    this.advancing.add(key);
    try {
      do {
        this.advanceAgain.delete(key);
        await this.advanceSteps(childAgentId, ownerAgentId);
      } while (this.advanceAgain.has(key));
    } finally {
      this.advancing.delete(key);
    }
  }

  private async advanceSteps(childAgentId: string, ownerAgentId: string): Promise<void> {
    for (let step = 0; step < MAX_STEPS_PER_ADVANCE; step += 1) {
      if (this.shuttingDown) return;
      const obligation = this.find(childAgentId, ownerAgentId);
      if (!obligation || !isUnresolved(obligation)) return;
      const claimed = this.options.isClaimedByRestartRecovery;
      if (claimed?.(childAgentId) || claimed?.(ownerAgentId)) return;
      const context = await this.buildContext(childAgentId, obligation);
      const plan = planObligationStep(obligation, context);
      if (plan.kind === "none") return;
      const progressed = await this.execute(childAgentId, obligation, plan, context);
      if (!progressed) return;
    }
  }

  /** Carries out one step. False when nothing moved and the advance should end. */
  private async execute(
    childAgentId: string,
    obligation: FinishObligation,
    plan: Exclude<ObligationStep, { kind: "none" }>,
    context: ObligationContext,
  ): Promise<boolean> {
    const nowMs = this.now();
    const log = { childAgentId, ownerAgentId: obligation.ownerAgentId };
    switch (plan.kind) {
      case "park":
        this.options.logger.info(log, "Agent is parked: stopped while still owing a finish report");
        this.commit(childAgentId, obligation, markParked(obligation, nowMs));
        return false;
      case "unpark":
        this.commit(childAgentId, obligation, clearParked(obligation));
        return false;
      case "settle": {
        const next = recordOutcome(obligation, {
          generation: obligation.generation,
          reason: plan.reason,
          nowMs,
          message: await this.options.agentManager.getLastAssistantMessage(childAgentId),
        });
        if (!next) return false;
        this.options.logger.info(
          { ...log, reason: plan.reason },
          "Finish report owed by a parked agent; the sweep reports for it",
        );
        return this.commit(childAgentId, obligation, next);
      }
      case "release":
        this.options.logger.info(
          { ...log, resolution: plan.resolution },
          "Finish report released: nobody is owed it any more",
        );
        this.commit(
          childAgentId,
          obligation,
          releaseObligation(obligation, { nowMs, resolution: plan.resolution }),
        );
        return false;
      case "escalate":
        this.options.logger.warn(
          { ...log, to: plan.to, why: plan.why },
          "Finish report escalated up the ladder",
        );
        return this.commit(
          childAgentId,
          obligation,
          escalateObligation(obligation, { to: plan.to, why: plan.why, nowMs }),
        );
      case "deliver":
        return await this.deliver(childAgentId, obligation, plan, context);
      case "push":
        await this.pushToOperator(childAgentId, obligation);
        return false;
    }
  }

  private async deliver(
    childAgentId: string,
    obligation: FinishObligation,
    plan: Extract<ObligationStep, { kind: "deliver" }>,
    context: ObligationContext,
  ): Promise<boolean> {
    // The target is not always the stored owner advanceSteps checked: resolveOwner follows
    // `migrated-to` to a successor, and the orchestrator rung walks up the tree. A target restart
    // recovery has claimed waits for it to let go, like a claimed owner; nothing is recorded.
    const claimed = this.options.isClaimedByRestartRecovery;
    if (claimed?.(plan.targetAgentId)) return false;
    let deferredToRecovery = false;
    let error: string | null = null;
    try {
      const report = await this.buildReport(childAgentId, obligation, context);
      const body =
        plan.rung === "orchestrator" ? await this.wrapForOrchestrator(obligation, report) : report;
      const send = async (): Promise<void> => {
        // Again at the moment of sending: a paced send can wait while an apply claims the target.
        if (claimed?.(plan.targetAgentId)) {
          deferredToRecovery = true;
          return;
        }
        await sendPromptToAgent({
          agentManager: this.options.agentManager,
          agentStorage: this.options.agentStorage,
          agentId: plan.targetAgentId,
          prompt: formatSystemNotificationPrompt(body),
          // Decided by gateDelivery before we got here: "steer" joins a running turn, and on an
          // idle or closed agent it starts one, which is the point of a report.
          activeTurnBehavior: "steer",
          unarchive: false,
          logger: this.options.logger,
        });
      };
      if (obligation.outcome?.reason === "stopped before reporting" && this.options.paceResume) {
        // After a restart the owner is usually not loaded yet; its record has the same labels.
        const labels =
          this.options.agentManager.getAgent(plan.targetAgentId)?.labels ??
          (await this.options.agentStorage.get(plan.targetAgentId))?.labels;
        await this.options.paceResume(
          pacedResume(plan.targetAgentId, labels, "restart-report"),
          send,
        );
      } else {
        await send();
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (deferredToRecovery) return false;
    const nowMs = this.now();
    const next = recordDeliveryAttempt(obligation, {
      rung: plan.rung,
      targetAgentId: plan.targetAgentId,
      error,
      nowMs,
      config: this.ladder,
    });
    const logContext = {
      childAgentId,
      ownerAgentId: obligation.ownerAgentId,
      targetAgentId: plan.targetAgentId,
      rung: plan.rung,
      gate: plan.gate,
      attempts: next.attempts,
    };
    if (error === null) {
      this.options.logger.info(logContext, "Finish report delivered");
    } else {
      this.options.logger.warn({ ...logContext, err: error }, "Finish report delivery failed");
    }
    this.commit(childAgentId, obligation, next);
    // A failure that moved the report up a rung is worth acting on now; a retry waits its turn.
    return error !== null && next.rung !== obligation.rung;
  }

  private async pushToOperator(childAgentId: string, obligation: FinishObligation): Promise<void> {
    const [child, owner] = await Promise.all([
      this.options.agentStorage.get(childAgentId),
      this.options.agentStorage.get(obligation.ownerAgentId),
    ]);
    let error: string | null = null;
    const sender = this.pushNotificationSender;
    if (!sender) {
      error = "no push sender";
    } else {
      try {
        await sender.send(
          buildFinishReportNotificationPayload({
            serverId: this.options.serverId,
            workspaceId: child?.workspaceId,
            agentId: childAgentId,
            agentTitle: child?.title,
            ownerAgentId: obligation.ownerAgentId,
            ownerTitle: owner?.title,
            outcome: obligation.outcome?.reason ?? "finished",
          }),
          { level: "urgent", dedupeKey: `finish-report:${childAgentId}` },
        );
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
    // The badge a person sees in the app. Our own push says what happened, so no second one.
    this.options.agentManager.flagUndeliveredDelegatedOutcome(childAgentId, "finished", {
      push: false,
    });
    this.options.logger.error(
      { childAgentId, ownerAgentId: obligation.ownerAgentId, pushError: error },
      "Finish report reached no agent; escalated to the operator",
    );
    this.commit(
      childAgentId,
      obligation,
      recordOperatorPush(obligation, { nowMs: this.now(), error }),
    );
  }

  private async buildReport(
    childAgentId: string,
    obligation: FinishObligation,
    context: ObligationContext,
  ): Promise<string> {
    const record = await this.options.agentStorage.get(childAgentId);
    const reason = (obligation.outcome?.reason ?? "finished") as FinishOutcomeReason;
    const notes: string[] = [];
    if (
      reason === "errored" &&
      isLimitShapedError(context.child.lastError) &&
      (this.options.isAccountFailoverEnabled?.() ?? false)
    ) {
      notes.push(
        "It hit its account's usage cap. Account failover moves it to another account and " +
          "resumes it, and you get another report when it finishes. Do not create another " +
          "agent for the same task.",
      );
    }
    return formatFinishNotificationBody({
      childAgentId,
      title: record?.title ?? childAgentId,
      reason,
      lastAssistantMessage:
        (await this.options.agentManager.getLastAssistantMessage(childAgentId)) ??
        obligation.outcome?.message ??
        null,
      inheritedFrom: obligation.inheritedFrom,
      notes,
    });
  }

  private async wrapForOrchestrator(obligation: FinishObligation, report: string): Promise<string> {
    const owner = await this.options.agentStorage.get(obligation.ownerAgentId);
    const ownerLabel = owner?.title
      ? `${obligation.ownerAgentId} (${owner.title})`
      : obligation.ownerAgentId;
    return (
      `This report was owed to ${ownerLabel}, which could not be told` +
      `${obligation.lastError ? ` (${obligation.lastError})` : ""}. You are the nearest live ` +
      `agent above it, so it comes to you: act on it, or pass it on when ${obligation.ownerAgentId} ` +
      `is reachable again.\n\n${report}`
    );
  }

  // ---------------------------------------------------------------------------------------------
  // State

  private async buildContext(
    childAgentId: string,
    obligation: FinishObligation,
  ): Promise<ObligationContext> {
    const [child, owner] = await Promise.all([
      this.presenceOf(childAgentId),
      this.resolveOwner(obligation.ownerAgentId),
    ]);
    const ran = this.ranThisBoot.has(
      watcherKey(childAgentId, obligation.ownerAgentId, obligation.generation),
    );
    const orchestrator =
      obligation.state === "owed" && obligation.rung === "orchestrator"
        ? await this.findOrchestrator(owner)
        : null;
    return {
      nowMs: this.now(),
      // A loaded idle agent that never ran in this process did not finish: it was loaded after
      // a restart. Present it as closed so the sweep reports it as stopped, not finished.
      child: ran || child.lifecycle !== "idle" ? child : { ...child, lifecycle: null },
      owner,
      orchestrator,
      config: this.ladder,
    };
  }

  private async presenceOf(agentId: string): Promise<ChildPresence> {
    const record = await this.options.agentStorage.get(agentId);
    const live = this.options.agentManager.getAgent(agentId);
    if (!record && !live) {
      return {
        exists: false,
        archived: false,
        lifecycle: null,
        parentAgentId: null,
        record: null,
        live: null,
      };
    }
    return {
      exists: true,
      archived: Boolean(record?.archivedAt),
      lifecycle: live?.lifecycle ?? null,
      lastError: live?.lastError ?? record?.lastError ?? null,
      hasPendingPermission: (live?.pendingPermissions.size ?? 0) > 0,
      turnHeld: this.options.isTurnHeld?.(agentId) ?? false,
      parentAgentId: getParentAgentIdFromLabels(live?.labels ?? record?.labels),
      record,
      live,
    };
  }

  /**
   * The agent that answers for `ownerAgentId`. Account failover retires an owner it imports into
   * a new agent (`migrated-to`) without archiving it; a report sent to the retired handle would
   * wake a conversation on the capped account that nobody reads. Follow the chain to the live end.
   */
  private async resolveOwner(ownerAgentId: string): Promise<ChildPresence & { agentId: string }> {
    const seen = new Set<string>();
    let agentId = ownerAgentId;
    let presence = await this.presenceOf(agentId);
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
      seen.add(agentId);
      const next = getMigratedToFromLabels(presence.live?.labels ?? presence.record?.labels);
      if (!next || seen.has(next)) break;
      const nextPresence = await this.presenceOf(next);
      if (!nextPresence.exists || nextPresence.archived) break;
      agentId = next;
      presence = nextPresence;
    }
    return { ...presence, agentId };
  }

  /** The nearest non-archived agent above the owner, walking parent labels. */
  private async findOrchestrator(
    owner: ChildPresence,
  ): Promise<{ agentId: string; presence: AgentPresence } | null> {
    const seen = new Set<string>();
    let nextId = owner.parentAgentId;
    for (let hop = 0; nextId && hop < MAX_ANCESTOR_HOPS && !seen.has(nextId); hop += 1) {
      seen.add(nextId);
      const presence = await this.presenceOf(nextId);
      if (!presence.exists) return null;
      if (!presence.archived) return { agentId: nextId, presence };
      nextId = presence.parentAgentId;
    }
    return null;
  }

  private find(childAgentId: string, ownerAgentId: string): FinishObligation | undefined {
    return this.index.get(childAgentId)?.find((entry) => entry.ownerAgentId === ownerAgentId);
  }

  /**
   * Replace `before` with `after`, unless something else changed the obligation in the meantime
   * (a re-arm, a transfer) — then the newer state stands and this result is dropped. True when
   * the write happened.
   */
  private commit(childAgentId: string, before: FinishObligation, after: FinishObligation): boolean {
    const obligations = this.index.get(childAgentId);
    if (!obligations?.includes(before)) return false;
    this.index.set(
      childAgentId,
      obligations.map((entry) => (entry === before ? after : entry)),
    );
    this.persist(childAgentId);
    return true;
  }

  private persist(agentId: string): void {
    const write = this.write(agentId).catch((error) => {
      this.dirty.add(agentId);
      this.options.logger.error({ err: error, agentId }, "Failed to write finish obligations");
    });
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
  }

  private async write(agentId: string): Promise<void> {
    const written = await this.options.agentStorage.updateFinishObligations(
      agentId,
      () => this.index.get(agentId) ?? [],
    );
    if (!written) {
      // Armed before the child's first snapshot was written. The next event or sweep retries.
      this.dirty.add(agentId);
      return;
    }
    this.dirty.delete(agentId);
    const report = summarizeOwedFinishReport(this.index.get(agentId));
    if (this.options.agentManager.getAgent(agentId)) {
      this.options.agentManager.setOwedFinishReport(agentId, report);
    } else {
      await this.options.agentManager.broadcastStoredAgentState(agentId);
    }
  }
}

function watcherKey(childAgentId: string, ownerAgentId: string, generation: number): string {
  return `${childAgentId}|${ownerAgentId}|${generation}`;
}
