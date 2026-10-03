import os from "node:os";
import {
  buildRemediationEscalatedNotificationPayload,
  buildRemediationRecordNotificationPayload,
  describeRemediationAttempts,
  type RemediationRecordEvent,
} from "@getpaseo/protocol/remediation-notification";
import type { Logger } from "pino";

import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import { MonitorModeLog } from "../monitor-mode-log.js";
import { levelRank, type NotifyLevel } from "../notify-policy/levels.js";
import type { NotifyDeliveryPreview } from "../notify-policy/notify-policy.js";
import type { PushNotificationSender } from "../push/index.js";
import {
  isNotifyRungEnabled,
  resolveRemediationEscalationConfig,
  type RemediationConditionOverride,
  type RemediationConfig,
  type ResolvedRemediationEscalationConfig,
} from "./config.js";
import type { RemediationObservation, RemediationSink } from "./contract.js";
import {
  buildAdviceNotificationPayload,
  buildRemediationAgentTitle,
  buildRemediationPrompt,
  parseAdviceReport,
  parseRemediationReport,
} from "./escalation.js";
import {
  decideTriageAction,
  describePersonSkip,
  erroredTriage,
  formatConfidence,
  MAX_DEFER_MS,
  shouldTriage,
  willEscalationPush,
  type EscalationTriage,
  type RemediationAgentEndCause,
  type RemediationTriageEvent,
} from "./jev-triage.js";
import {
  emptyLadderState,
  loadLadderState,
  saveLadderState,
  type LadderEpisode,
  type LadderState,
} from "./ladder-state.js";

const MINUTE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = MINUTE_MS;
/**
 * The ladder's own bound on a triage, past the service's 5-second deadline. The ladder is
 * serialized, so a triage that never settles must not hold every queued observation.
 */
const DEFAULT_TRIAGE_TIMEOUT_MS = 8_000;

/** What rung 2 asks the create path for. The classifier decides model, thinking and account. */
export interface RemediationAgentRequest {
  provider: string;
  title: string;
  prompt: string;
  cwd: string;
  labels: Record<string, string>;
  /**
   * Always true. No person watches a remediation agent, so a permission prompt would only run
   * out its clock (week review D1b-03: 5 of 9 timed out on one). The create path turns it into
   * the provider's unattended mode.
   */
  unattended: true;
}

/** The create-path input for a remediation agent: a root, background, unattended agent. */
export function remediationCreateAgentInput(
  request: RemediationAgentRequest,
): CreateAgentFromMcpInput {
  return {
    kind: "mcp",
    provider: request.provider,
    title: request.title,
    initialPrompt: request.prompt,
    promptFailure: "throw",
    cwd: request.cwd,
    labels: request.labels,
    unattended: request.unattended,
    background: true,
    notifyOnFinish: false,
  };
}

/**
 * One read of a remediation agent. `unloaded`: the agent exists on disk but not in memory, which
 * is how a restart leaves one; the ladder keeps waiting on it until its timeout.
 */
export type RemediationAgentView =
  | { status: "running"; totalTokens?: number; model?: string | null }
  | { status: "idle"; finalText: string | null; totalTokens?: number; model?: string | null }
  | { status: "error"; error: string }
  | { status: "unloaded" }
  | { status: "gone" };

export interface RemediationLadderDependencies {
  createAgent(request: RemediationAgentRequest): Promise<{ agentId: string }>;
  inspectAgent(agentId: string): Promise<RemediationAgentView>;
  cancelAgent(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  /** Why no account can run an agent for this provider, or null when one can. */
  findAccountBlocker(provider: string): Promise<string | null>;
  /**
   * Feature 3a (docs/jev.md): JEV's view of whether an agent is the right next step, asked once
   * per episode after every other gate passed. Absent, throwing or slow: the agent starts.
   */
  triageEscalation?(input: {
    episodeKey: string;
    observation: RemediationObservation;
  }): Promise<EscalationTriage>;
  /** The feature 3a measurement record. Never throws. */
  recordTriage?(event: RemediationTriageEvent): void;
}

export interface RemediationLadderOptions {
  dependencies: RemediationLadderDependencies;
  getPushNotificationSender: () => PushNotificationSender;
  serverId: string;
  readDaemonConfig: () => { remediation?: RemediationConfig };
  /** `$PASEO_HOME/remediation/state.json`. */
  statePath: string;
  logger: Logger;
  now?: () => number;
  pollIntervalMs?: number;
  /**
   * The notify policy's preview of a push (`NotifyPolicy.previewDelivery`): read to decide whether
   * a rung 3 push would reach a phone now. Absent or throwing: it would not, so no answer ever
   * skips the agent on a guess.
   */
  previewPush?: (meta: { level: NotifyLevel; dedupeKey: string }) => NotifyDeliveryPreview;
  triageTimeoutMs?: number;
}

interface ResolvedCondition {
  escalation: ResolvedRemediationEscalationConfig;
  graceMs: number;
  /** Rung 3 goes to a person; false sends it to the ledger only. */
  notify: boolean;
  escalate: boolean;
}

/**
 * The config's `graceMinutes` replaces the observation's `graceMs`; the sender's own hold is added
 * on top of either, so rung 2 never starts before the sender has acted.
 */
function resolveGraceMs(
  override: RemediationConditionOverride | undefined,
  observation: RemediationObservation,
): number {
  const graceMs =
    override?.graceMinutes !== undefined
      ? override.graceMinutes * MINUTE_MS
      : (observation.graceMs ?? 0);
  return graceMs + (observation.holdMs ?? 0);
}

/**
 * The remediation ladder (docs/remediation.md). Monitors report conditions through `observe`;
 * the ladder keeps one episode per key, starts at most one bounded agent for it, and tells a
 * person once when neither the remedy nor the agent could fix it. Every change is written to
 * `statePath` before the call returns, so a restart resumes rather than repeats.
 */
export class RemediationLadder implements RemediationSink {
  private readonly deps: RemediationLadderDependencies;
  private readonly getPushNotificationSender: () => PushNotificationSender;
  private readonly serverId: string;
  private readonly readDaemonConfig: () => { remediation?: RemediationConfig };
  private readonly statePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly previewPush:
    | ((meta: { level: NotifyLevel; dedupeKey: string }) => NotifyDeliveryPreview)
    | undefined;
  private readonly triageTimeoutMs: number;
  private readonly modeLog: MonitorModeLog;
  private state: LadderState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  /** Serializes observe and poll: both read and write the same episodes. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RemediationLadderOptions) {
    this.deps = options.dependencies;
    this.getPushNotificationSender = options.getPushNotificationSender;
    this.serverId = options.serverId;
    this.readDaemonConfig = options.readDaemonConfig;
    this.statePath = options.statePath;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.previewPush = options.previewPush;
    this.triageTimeoutMs = options.triageTimeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS;
    this.modeLog = new MonitorModeLog(options.logger);
  }

  /** Loads the state file and reconciles in-flight agents before the first timer tick. */
  async start(): Promise<void> {
    if (this.timer) return;
    this.reportMode(this.readDaemonConfig().remediation);
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Remediation ladder poll failed");
      });
    }, this.pollIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
    await this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async observe(observation: RemediationObservation): Promise<void> {
    try {
      await this.serialize(() => this.handleObservation(observation));
    } catch (error) {
      // The contract says observe never throws: a monitor's sweep must not fail on the ladder.
      this.logger.error({ err: error, key: observation.key }, "Remediation ladder: observe failed");
    }
  }

  /** Polls every in-flight agent once. No overlapping ticks. */
  async tick(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.serialize(() => this.pollAgents());
    } finally {
      this.pollInFlight = false;
    }
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async loadState(): Promise<LadderState> {
    if (!this.state) {
      this.state = await loadLadderState(this.statePath, this.logger);
    }
    return this.state;
  }

  private async save(): Promise<void> {
    await saveLadderState(this.statePath, this.state ?? emptyLadderState());
  }

  private reportMode(config: RemediationConfig | undefined): void {
    const escalation = resolveRemediationEscalationConfig(config);
    this.modeLog.report([
      { monitor: "remediation-escalation", enabled: escalation.enabled },
      { monitor: "remediation-notify", enabled: isNotifyRungEnabled(config) },
    ]);
  }

  private resolveCondition(
    config: RemediationConfig | undefined,
    observation: RemediationObservation,
  ): ResolvedCondition {
    const override: RemediationConditionOverride | undefined =
      config?.conditions?.[observation.kind];
    const base = resolveRemediationEscalationConfig(config);
    return {
      escalation: {
        ...base,
        taskClass: override?.taskClass ?? base.taskClass,
        budgetTokens:
          override?.budgetTokens ?? observation.escalation?.budgetTokens ?? base.budgetTokens,
        timeoutMinutes: observation.escalation?.timeoutMinutes ?? base.timeoutMinutes,
        cooldownMinutes: override?.cooldownMinutes ?? base.cooldownMinutes,
      },
      graceMs: resolveGraceMs(override, observation),
      notify: isNotifyRungEnabled(config) && override?.notify !== false,
      escalate: base.enabled && override?.escalate !== false,
    };
  }

  private async handleObservation(observation: RemediationObservation): Promise<void> {
    const state = await this.loadState();
    const config = this.readDaemonConfig().remediation;
    this.reportMode(config);
    const nowMs = this.now();
    const open = state.episodes.find((e) => e.key === observation.key && !e.closedAt);

    if (!observation.active) {
      if (!open) return;
      open.closedAt = new Date(nowMs).toISOString();
      open.observation = { ...open.observation, attempts: [...(observation.attempts ?? [])] };
      this.recordClosed(open, nowMs);
      await this.record(open, "resolved", describeRemediationAttempts(observation.attempts ?? []));
      // An agent still running finishes; its report still counts (see pollAgents).
      if (!open.agent) state.episodes = state.episodes.filter((e) => e !== open);
      await this.save();
      return;
    }

    let episode: LadderEpisode;
    if (open) {
      episode = open;
      episode.observation = toStoredObservation(observation);
    } else {
      const cooldownUntil = state.cooldowns[observation.key];
      episode = {
        key: observation.key,
        openedAt: new Date(nowMs).toISOString(),
        openedInCooldown: cooldownUntil !== undefined && Date.parse(cooldownUntil) > nowMs,
        observation: toStoredObservation(observation),
      };
      state.episodes.push(episode);
      await this.record(episode, "opened", observation.summary);
    }
    await this.evaluate(episode, config, nowMs);
    await this.save();
  }

  /** Decides what an open, active episode needs now: wait, an agent, or a person. */
  private async evaluate(
    episode: LadderEpisode,
    config: RemediationConfig | undefined,
    nowMs: number,
  ): Promise<void> {
    if (episode.escalatedAt || episode.agent) return;
    const observation = fromStoredObservation(episode.observation);
    const condition = this.resolveCondition(config, observation);

    if (observation.remedy === "disabled") {
      await this.escalate(
        episode,
        condition,
        "The automatic remedy is turned off, so nothing acted.",
      );
      return;
    }
    if (observation.remedy === "dry-run") {
      await this.escalate(
        episode,
        condition,
        "The automatic remedy is in dry run, so nothing acted.",
      );
      return;
    }
    if (observation.remedy === "none" && !observation.escalation) {
      await this.escalate(episode, condition, "There is no automatic remedy for this.");
      return;
    }

    const graceUntil = episode.fixedGraceUntil
      ? Date.parse(episode.fixedGraceUntil)
      : Date.parse(episode.openedAt) + condition.graceMs;
    if (nowMs < graceUntil) return;
    if (isHeld(episode, observation, nowMs)) return;

    if (episode.fixedLine) {
      await this.escalate(
        episode,
        condition,
        `The agent reported "${episode.fixedLine}", but the condition still holds.`,
      );
      return;
    }
    if (!observation.escalation) {
      await this.escalate(
        episode,
        condition,
        "The remedy did not clear it, and no agent can help.",
      );
      return;
    }
    await this.startAgent(episode, observation, condition, nowMs);
  }

  private async startAgent(
    episode: LadderEpisode,
    observation: RemediationObservation,
    condition: ResolvedCondition,
    nowMs: number,
  ): Promise<void> {
    const state = await this.loadState();
    const { escalation } = condition;
    if (!condition.escalate) {
      await this.escalate(episode, condition, "Escalation to an agent is turned off.");
      return;
    }
    if (episode.openedInCooldown) {
      await this.escalate(
        episode,
        condition,
        `An agent already tried within the ${escalation.cooldownMinutes}-minute cooldown.`,
      );
      return;
    }
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (state.daily.day !== day) state.daily = { day, count: 0 };
    if (state.daily.count >= escalation.maxPerDay) {
      await this.escalate(
        episode,
        condition,
        `The daily cap of ${escalation.maxPerDay} remediation agents is spent.`,
      );
      return;
    }
    const inFlight = state.episodes.filter((e) => e.agent).length;
    // Waiting for a slot is not a failure: the next observation tries again.
    if (inFlight >= escalation.maxConcurrent) return;

    const blocker = await this.deps.findAccountBlocker(escalation.provider);
    if (blocker) {
      await this.escalate(episode, condition, `No agent could run: ${blocker}.`);
      return;
    }
    if (await this.routeElsewhere(episode, observation, condition, nowMs)) return;

    const request: RemediationAgentRequest = {
      provider: escalation.provider,
      title: buildRemediationAgentTitle(observation),
      prompt: buildRemediationPrompt({
        observation,
        task: observation.escalation!.task,
        timeoutMinutes: escalation.timeoutMinutes,
        budgetTokens: escalation.budgetTokens,
      }),
      cwd: observation.escalation?.cwd ?? os.homedir(),
      labels: {
        "paseo.task-class": observation.escalation?.taskClass ?? escalation.taskClass,
        "paseo.budget": String(escalation.budgetTokens),
        "paseo.remediation": observation.kind,
        "paseo.remediation-key": observation.key,
        "paseo.agent-type": "worker",
      },
      unattended: true,
    };
    let agentId: string;
    try {
      ({ agentId } = await this.deps.createAgent(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, key: episode.key }, "Remediation ladder: agent create failed");
      await this.escalate(episode, condition, `The remediation agent could not start: ${message}.`);
      return;
    }
    const startedAt = new Date(nowMs).toISOString();
    episode.agent = { id: agentId, startedAt };
    episode.lastAgentId = agentId;
    state.daily.count += 1;
    state.cooldowns[episode.key] = new Date(
      nowMs + escalation.cooldownMinutes * MINUTE_MS,
    ).toISOString();
    this.logger.info({ key: episode.key, agentId }, "Remediation ladder: started an agent");
    await this.record(episode, "agent_started", `Agent ${agentId} is on it.`);
  }

  /**
   * The last step before rung 2: a person-first steer, then JEV's triage (docs/jev.md, Feature
   * 3a). True when the agent is not started now, because the episode went to a person or is held
   * once while its live remedy acts. Both send it to a person only when the push reaches a phone
   * now; otherwise the agent starts, as it did before either existed.
   */
  private async routeElsewhere(
    episode: LadderEpisode,
    observation: RemediationObservation,
    condition: ResolvedCondition,
    nowMs: number,
  ): Promise<boolean> {
    const level = observation.level ?? "alert";
    // The push `escalate` would send, previewed with the same level and dedupe key.
    const pushPreview = condition.notify
      ? this.safePreview({ level, dedupeKey: remediationDedupeKey(episode) })
      : null;
    const willPush = willEscalationPush({ notify: condition.notify, level, preview: pushPreview });

    const personFirst = observation.escalation?.personFirst;
    if (personFirst) {
      this.emitTriage({
        type: "person-first",
        at: new Date(nowMs).toISOString(),
        episode: episodeId(episode),
        key: episode.key,
        kind: observation.kind,
        willPush,
        pushPreview,
        reason: personFirst.reason,
        confidence: personFirst.confidence,
        skipped: willPush,
      });
      if (willPush) {
        await this.escalate(
          episode,
          condition,
          `No agent started: the stall judgment says a person is needed (${personFirst.reason}, ${formatConfidence(personFirst.confidence)}).`,
        );
        return true;
      }
    }

    if (!this.deps.triageEscalation || episode.jevTriage || !shouldTriage(observation)) {
      return false;
    }
    const triage = await this.askTriage(episode, observation);
    const decision = decideTriageAction(triage, {
      willPush,
      graceMs: condition.graceMs,
      remedy: observation.remedy,
    });
    episode.jevTriage = {
      at: new Date(nowMs).toISOString(),
      callId: triage.callId ?? "",
      outcome: triage.outcome,
      ...(triage.route !== null ? { route: triage.route } : {}),
      ...(triage.routeConfidence !== null ? { confidence: triage.routeConfidence } : {}),
      ...(triage.evidenceCurrent !== null ? { evidenceCurrent: triage.evidenceCurrent } : {}),
      action: decision.wouldBe,
      applied: decision.applied,
      level,
    };
    this.emitTriage({
      type: "triage",
      at: new Date(nowMs).toISOString(),
      episode: episodeId(episode),
      key: episode.key,
      kind: observation.kind,
      level,
      willPush,
      pushPreview,
      linkedAgentId: observation.link?.agentId ?? null,
      triage,
      decision,
    });
    this.logger.info(
      {
        key: episode.key,
        callId: triage.callId,
        outcome: triage.outcome,
        wouldBe: decision.wouldBe,
        action: decision.action,
      },
      "Remediation ladder: triaged",
    );

    if (decision.action === "person") {
      await this.escalate(episode, condition, describePersonSkip(triage));
      return true;
    }
    if (decision.action === "defer") {
      episode.jevDeferredUntil = new Date(nowMs + decision.deferMs).toISOString();
      return true;
    }
    return false;
  }

  /** Never rejects and never outlasts `triageTimeoutMs`: an error or a timeout starts the agent. */
  private async askTriage(
    episode: LadderEpisode,
    observation: RemediationObservation,
  ): Promise<EscalationTriage> {
    const triageEscalation = this.deps.triageEscalation;
    if (!triageEscalation) return erroredTriage("absent");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<EscalationTriage>((resolve) => {
      timer = setTimeout(() => resolve(erroredTriage("timeout")), this.triageTimeoutMs);
    });
    try {
      return await Promise.race([
        triageEscalation({ episodeKey: episode.key, observation }).catch(() =>
          erroredTriage("threw"),
        ),
        timeout,
      ]);
    } catch {
      return erroredTriage("threw");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private safePreview(meta: {
    level: NotifyLevel;
    dedupeKey: string;
  }): NotifyDeliveryPreview | null {
    if (!this.previewPush) return null;
    try {
      return this.previewPush(meta);
    } catch (error) {
      // Unknown delivery: assume it reaches nobody, so JEV never skips an agent on a guess.
      this.logger.warn({ err: error }, "Remediation ladder: push preview failed");
      return null;
    }
  }

  private emitTriage(event: RemediationTriageEvent): void {
    try {
      this.deps.recordTriage?.(event);
    } catch (error) {
      this.logger.warn({ err: error }, "Remediation ladder: triage record failed");
    }
  }

  /** Measurement only: every episode that ran an agent or was triaged gets a `closed` line. */
  private recordClosed(episode: LadderEpisode, nowMs: number): void {
    if (!episode.jevTriage && !episode.lastAgentId) return;
    const triageAt = episode.jevTriage ? Date.parse(episode.jevTriage.at) : null;
    const duringDeferral = episode.jevDeferredUntil !== undefined && nowMs < holdEndMs(episode);
    const agentRan = episode.lastAgentId !== undefined;
    this.emitTriage({
      type: "closed",
      at: new Date(nowMs).toISOString(),
      episode: episodeId(episode),
      key: episode.key,
      kind: episode.observation.kind,
      minutesOpen: minutesBetween(Date.parse(episode.openedAt), nowMs),
      minutesSinceTriage: triageAt === null ? null : minutesBetween(triageAt, nowMs),
      duringDeferral,
      clearedDuringHold: duringDeferral && episode.observation.remedy === "live" && !agentRan,
      agentRan,
      escalated: episode.escalatedAt !== undefined,
      ...triageJoin(episode),
    });
  }

  private async pollAgents(): Promise<void> {
    const state = await this.loadState();
    const config = this.readDaemonConfig().remediation;
    this.reportMode(config);
    const nowMs = this.now();
    let changed = false;
    // The loop reassigns state.episodes (filter), never mutates it, so the original is safe to walk.
    for (const episode of state.episodes) {
      if (!episode.agent) continue;
      const condition = this.resolveCondition(config, fromStoredObservation(episode.observation));
      const outcome = await this.readAgentOutcome({
        agent: episode.agent,
        escalation: condition.escalation,
        nowMs,
        advice: episode.observation.escalation?.advice === true,
      });
      if (outcome.kind === "pending") continue;
      changed = true;
      const agentId = episode.agent.id;
      this.emitTriage({
        type: "agent-ended",
        at: new Date(nowMs).toISOString(),
        episode: episodeId(episode),
        key: episode.key,
        kind: episode.observation.kind,
        agentId,
        result: outcome.kind,
        cause: outcome.cause,
        agentTotalTokens: outcome.totalTokens,
        agentModel: outcome.model,
        minutesRunning: minutesBetween(Date.parse(episode.agent.startedAt), nowMs),
        ...triageJoin(episode),
      });
      episode.agent = undefined;

      if (outcome.kind === "fixed") {
        await this.deps.archiveAgent(agentId).catch((error: unknown) => {
          this.logger.warn({ err: error, agentId }, "Remediation ladder: archive failed");
        });
        await this.record(episode, "fixed", outcome.line);
        if (!episode.closedAt) {
          // The condition may clear on the monitor's next sweep; give it one more window.
          episode.fixedLine = outcome.line;
          episode.fixedGraceUntil = new Date(nowMs + condition.graceMs).toISOString();
        }
      } else {
        await this.escalate(episode, condition, outcome.line);
      }
      if (episode.closedAt) state.episodes = state.episodes.filter((e) => e !== episode);
    }
    // A hold that lapsed while its monitor went quiet: evaluate would otherwise wait for an
    // observation that may never come, and the fix the hold delayed would never start.
    for (const episode of state.episodes) {
      if (!isLapsedHold(episode, nowMs)) continue;
      changed = true;
      await this.evaluate(episode, config, nowMs);
    }
    if (changed) await this.save();
  }

  private async readAgentOutcome(input: {
    agent: NonNullable<LadderEpisode["agent"]>;
    escalation: ResolvedRemediationEscalationConfig;
    nowMs: number;
    /** An advisory agent: its report is a recommendation line and is never FIXED. */
    advice: boolean;
  }): Promise<{ kind: "pending" } | AgentEnd> {
    const { agent, escalation, nowMs } = input;
    const view = await this.deps.inspectAgent(agent.id);
    const measured = {
      totalTokens: "totalTokens" in view ? (view.totalTokens ?? null) : null,
      model: "model" in view ? (view.model ?? null) : null,
    };
    if (view.status === "idle") {
      const report = input.advice
        ? parseAdviceReport(view.finalText)
        : parseRemediationReport(view.finalText);
      return { kind: report.outcome, line: report.line, cause: "report", ...measured };
    }
    if (view.status === "error") {
      return {
        kind: "not-fixed",
        line: `The remediation agent failed: ${view.error}`,
        cause: "error",
        ...measured,
      };
    }
    if (view.status === "gone") {
      return {
        kind: "not-fixed",
        line: "The remediation agent was archived or removed before it reported.",
        cause: "gone",
        ...measured,
      };
    }
    if (
      view.status === "running" &&
      view.totalTokens !== undefined &&
      view.totalTokens > escalation.budgetTokens
    ) {
      await this.cancel(agent.id);
      return {
        kind: "not-fixed",
        line: `The remediation agent passed its token budget (${view.totalTokens.toLocaleString("en-US")} of ${escalation.budgetTokens.toLocaleString("en-US")}) and was cancelled.`,
        cause: "budget",
        ...measured,
      };
    }
    if (nowMs - Date.parse(agent.startedAt) >= escalation.timeoutMinutes * MINUTE_MS) {
      await this.cancel(agent.id);
      return {
        kind: "not-fixed",
        line: `The remediation agent did not report within ${escalation.timeoutMinutes} minutes and was cancelled.`,
        cause: "timeout",
        ...measured,
      };
    }
    return { kind: "pending" };
  }

  private async cancel(agentId: string): Promise<void> {
    await this.deps.cancelAgent(agentId).catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "Remediation ladder: cancel failed");
    });
  }

  /** Rung 3: once per episode, to a person unless the notify rung or the condition says ledger. */
  private async escalate(
    episode: LadderEpisode,
    condition: ResolvedCondition,
    outcome: string,
  ): Promise<void> {
    if (episode.escalatedAt) return;
    episode.escalatedAt = new Date(this.now()).toISOString();
    const observation = episode.observation;
    const payload = observation.escalation?.advice
      ? buildAdviceNotificationPayload({
          serverId: this.serverId,
          key: episode.key,
          kind: observation.kind,
          title: observation.title,
          summary: observation.summary,
          recommendation: outcome,
          agentId: episode.lastAgentId,
        })
      : buildRemediationEscalatedNotificationPayload({
          serverId: this.serverId,
          key: episode.key,
          kind: observation.kind,
          title: observation.title,
          summary: observation.summary,
          attempts: observation.attempts ?? [],
          outcome,
          ...this.link(episode),
        });
    this.logger.info({ key: episode.key, outcome }, "Remediation ladder: escalated to a person");
    await this.send(
      payload,
      condition.notify
        ? { level: observation.level ?? "alert", dedupeKey: remediationDedupeKey(episode) }
        : { level: "record" },
    );
  }

  private async record(
    episode: LadderEpisode,
    event: RemediationRecordEvent,
    detail: string,
  ): Promise<void> {
    await this.send(
      buildRemediationRecordNotificationPayload({
        serverId: this.serverId,
        key: episode.key,
        kind: episode.observation.kind,
        title: episode.observation.title,
        event,
        detail,
        ...this.link(episode),
      }),
      { level: "record" },
    );
  }

  /** The remediation agent when there is one: it is left unarchived so the push can open it. */
  private link(episode: LadderEpisode): { agentId?: string; workspaceId?: string } {
    const agentId = episode.lastAgentId ?? episode.observation.link?.agentId;
    const workspaceId = episode.lastAgentId ? undefined : episode.observation.link?.workspaceId;
    return {
      ...(agentId ? { agentId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  }

  private async send(
    payload: Parameters<PushNotificationSender["send"]>[0],
    meta: Parameters<PushNotificationSender["send"]>[1],
  ): Promise<void> {
    try {
      await this.getPushNotificationSender().send(payload, meta);
    } catch (error) {
      this.logger.warn({ err: error }, "Remediation ladder: push failed");
    }
  }
}

interface AgentEnd {
  kind: "fixed" | "not-fixed";
  line: string;
  cause: RemediationAgentEndCause;
  totalTokens: number | null;
  model: string | null;
}

/** The dedupe key rung 3 pushes under; the push preview asks about the same one. */
function remediationDedupeKey(episode: LadderEpisode): string {
  return `remediation:${episode.key}`;
}

/** When an episode's JEV hold ends: its deferral, capped at MAX_DEFER_MS after the triage. */
function holdEndMs(episode: LadderEpisode): number {
  const until = episode.jevDeferredUntil ? Date.parse(episode.jevDeferredUntil) : Number.NaN;
  const triageAt = episode.jevTriage ? Date.parse(episode.jevTriage.at) : Number.NaN;
  const ceiling = Number.isFinite(triageAt) ? triageAt + MAX_DEFER_MS : until;
  const end = Math.min(until, ceiling);
  return Number.isFinite(end) ? end : 0;
}

/** A JEV hold is on rung 2 until it ends, or until the observation's level rises past the triage's. */
function isHeld(
  episode: LadderEpisode,
  observation: RemediationObservation,
  nowMs: number,
): boolean {
  if (!episode.jevDeferredUntil || nowMs >= holdEndMs(episode)) return false;
  const heldAt = readLevel(episode.jevTriage?.level) ?? "alert";
  return levelRank(observation.level ?? "alert") <= levelRank(heldAt);
}

/** An open episode whose hold ran out before any agent started or anyone was told. */
function isLapsedHold(episode: LadderEpisode, nowMs: number): boolean {
  return (
    episode.jevDeferredUntil !== undefined &&
    !episode.closedAt &&
    !episode.escalatedAt &&
    !episode.agent &&
    episode.lastAgentId === undefined &&
    nowMs >= holdEndMs(episode)
  );
}

function readLevel(value: string | undefined): NotifyLevel | null {
  return value === "notice" || value === "alert" || value === "urgent" ? value : null;
}

/** Joins an episode's measurement lines: its key and when it opened. */
function episodeId(episode: LadderEpisode): string {
  return `${episode.key}@${episode.openedAt}`;
}

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.round(((toMs - fromMs) / MINUTE_MS) * 10) / 10;
}

function triageJoin(episode: LadderEpisode): {
  triageCallId: string | null;
  triageWouldBe: string | null;
  triageApplied: boolean | null;
} {
  const triage = episode.jevTriage;
  return {
    triageCallId: triage?.callId || null,
    triageWouldBe: triage?.action ?? null,
    triageApplied: triage?.applied ?? null,
  };
}

function toStoredObservation(observation: RemediationObservation): LadderEpisode["observation"] {
  return { ...observation, attempts: observation.attempts ? [...observation.attempts] : undefined };
}

/** The state file keeps `kind` as a plain string so an unknown kind never voids the whole file. */
function fromStoredObservation(stored: LadderEpisode["observation"]): RemediationObservation {
  return stored as RemediationObservation;
}
