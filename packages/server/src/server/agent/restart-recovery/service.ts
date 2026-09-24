import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import pLimit from "p-limit";
import type { Logger } from "pino";

import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  RestartRecoveryCheck,
  RestartRecoveryEntry,
  RestartRecoveryMode,
  RestartRecoveryPlan,
  RestartRecoveryReadiness,
  RestartRecoveryState,
} from "@getpaseo/protocol/restart-recovery/rpc-schemas";

import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import {
  formatSystemNotificationPrompt,
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "../agent-prompt.js";
import { isLimitShapedError } from "../account-failover-detector.js";
import { unpacedResume, type PaceResume } from "../resume-pacer.js";
import { isRunMarkerOpen, settleRunMarker } from "./run-marker.js";
import {
  computeRecoveryDepths,
  groupByDepth,
  isResumable,
  nearestRecoveringAncestor,
  orderForRecovery,
  rollUpReadiness,
  type AgentLineage,
} from "./plan.js";
import {
  buildRecoveryResumePrompt,
  buildUnrecoveredChildrenNotice,
  type RecoveryPeer,
} from "./envelope.js";

export interface RestartRecoveryConfig {
  /** `off`: nothing at boot. `plan` (default): surface the plan. `resume`: resume at boot. */
  mode?: "off" | "plan" | "resume";
}

export const DEFAULT_RESTART_RECOVERY_MODE = "plan";
const RESUME_CONCURRENCY = 4;

export class RestartRecoveryBusyError extends Error {
  constructor() {
    super("Restart recovery is already resuming agents; try again when it finishes");
    this.name = "RestartRecoveryBusyError";
  }
}

/** One run the previous daemon left open, as read at boot. */
interface InterruptedRun {
  agentId: string;
  runStartedAt: string;
  title: string | null;
  provider: string;
  cwd: string;
  workspaceId: string | null;
  parentAgentId: string | null;
}

interface Outcome {
  state: RestartRecoveryState;
  detail: string | null;
  resolvedAt: string | null;
  readiness: RestartRecoveryReadiness;
  checks: RestartRecoveryCheck[];
}

export interface RestartRecoveryServiceOptions {
  agentStorage: AgentStorage;
  agentManager: AgentManager;
  config: RestartRecoveryConfig | undefined;
  logger: Logger;
  now?: () => Date;
  /**
   * The previous daemon's shutdown receipt, read once at boot: `crash`, `clean` or `unknown`.
   * OR-C11 (W1.1) owns the receipt; until it lands every stop reads as `unknown`, which changes
   * nothing here: a mid-turn agent was interrupted whichever way the daemon went down.
   */
  readPreviousShutdown?: () => Promise<string>;
  /**
   * Whether child admission holds this agent's turn: queued for a slot when the daemon stopped,
   * and re-sent by admission after the restart (docs/resource-monitor.md). Such a turn never
   * reached the provider, so it was not cut off; admission owns it and recovery leaves it out.
   */
  isTurnHeld?: (agentId: string) => boolean;
  /** The daemon's shared ResumePacer; every resume prompt recovery sends goes through it. */
  paceResume?: PaceResume;
}

/**
 * Finds the agents a daemon stop cut off mid-turn and resumes them, leaders first. Reads the run
 * markers once, at construction, before anything can load or prompt an agent; every plan after
 * that re-reads the records, so it reflects what happened since. See docs/restart-recovery.md.
 *
 * Boot order with durable finish reports: recovery decides who was mid-turn and resumes them;
 * finish reports decide who is owed a wake. `isAboutToResume` is the seam: the finish-report
 * sweep must not park, report on, or wake an agent while it returns true.
 */
export class RestartRecoveryService {
  private readonly mode: RestartRecoveryMode;
  private readonly capturedAt: string;
  private readonly outcomes = new Map<string, Outcome>();
  private readonly resuming = new Set<string>();
  private queued = new Set<string>();
  private previousShutdown = "unknown";
  private applying = false;
  private stopped = false;

  private constructor(
    private readonly options: RestartRecoveryServiceOptions,
    private readonly episode: readonly InterruptedRun[],
  ) {
    this.mode = options.config?.mode ?? DEFAULT_RESTART_RECOVERY_MODE;
    this.capturedAt = this.nowIso();
    if (this.mode === "resume") {
      // Claimed from the first instant, so a finish-report sweep that runs before the boot apply
      // reaches an agent already sees it as recovery's.
      this.queued = new Set(episode.map((run) => run.agentId));
    }
  }

  /** Read the markers. Call after agent storage is loaded and before anything loads an agent. */
  static async capture(options: RestartRecoveryServiceOptions): Promise<RestartRecoveryService> {
    const records = await options.agentStorage.list();
    const episode = records
      .filter((record) => !record.archivedAt && !record.internal)
      .filter((record) => isRunMarkerOpen(record.runMarker))
      .filter((record) => !options.isTurnHeld?.(record.id))
      .map(
        (record): InterruptedRun => ({
          agentId: record.id,
          runStartedAt: record.runMarker!.startedAt,
          title: record.title ?? null,
          provider: record.provider,
          cwd: record.cwd,
          workspaceId: record.workspaceId ?? null,
          parentAgentId: getParentAgentIdFromLabels(record.labels),
        }),
      );
    return new RestartRecoveryService(options, episode);
  }

  /** Whether recovery has claimed this agent and has not finished with it yet. */
  isAboutToResume(agentId: string): boolean {
    return this.queued.has(agentId);
  }

  /** Log the plan, and in `resume` mode start resuming. Never throws. */
  start(): void {
    if (this.episode.length === 0) return;
    const logger = this.options.logger;
    void (async () => {
      this.previousShutdown =
        (await this.options.readPreviousShutdown?.().catch(() => "unknown")) ?? "unknown";
      if (this.mode === "off") {
        logger.info(
          { interrupted: this.episode.length },
          "Restart recovery is off; agents cut off mid-turn stay closed",
        );
        return;
      }
      const plan = await this.getPlan();
      for (const entry of plan.entries) {
        logger.info(
          {
            agentId: entry.agentId,
            depth: entry.depth,
            readiness: entry.readiness,
            runStartedAt: entry.runStartedAt,
            checks: entry.checks.filter((result) => result.status !== "green"),
          },
          "Restart recovery: agent was mid-turn when the daemon stopped",
        );
      }
      if (this.mode === "resume") {
        await this.apply({ trigger: "boot" });
      }
    })().catch((error) => {
      this.queued.clear();
      logger.error({ err: error }, "Restart recovery failed at boot");
    });
  }

  /** Stop before the next wave. A resume already dispatched is not taken back. */
  stop(): void {
    this.stopped = true;
    this.queued.clear();
  }

  async getPlan(): Promise<RestartRecoveryPlan> {
    const records = await this.options.agentStorage.list();
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const lineage = toLineage(records);
    const depths = computeRecoveryDepths(new Set(this.episode.map((run) => run.agentId)), lineage);
    const entries = await Promise.all(
      this.episode.map((run) =>
        this.describe(run, recordsById.get(run.agentId) ?? null, depths.get(run.agentId) ?? 0),
      ),
    );
    return {
      mode: this.mode,
      capturedAt: this.capturedAt,
      previousShutdown: this.previousShutdown,
      applying: this.applying,
      entries: orderForRecovery(entries),
    };
  }

  /**
   * Resume the selected entries (all of them when `agentIds` is omitted), leaders first: each
   * depth waits until every agent in the one before it has started its run. An entry that is not
   * restorable is recorded as `not_attempted` with the red checks as the reason. A failed resume
   * is reported as `failed` and never falls back to a fresh agent.
   */
  async apply(input: {
    agentIds?: readonly string[];
    trigger: "boot" | "request";
  }): Promise<RestartRecoveryPlan> {
    if (this.applying) throw new RestartRecoveryBusyError();
    this.applying = true;
    try {
      const plan = await this.getPlan();
      const wanted = input.agentIds ? new Set(input.agentIds) : null;
      const open = plan.entries.filter(
        (entry) =>
          (entry.state === "pending" || entry.state === "failed") &&
          (!wanted || wanted.has(entry.agentId)),
      );
      for (const entry of open) {
        if (isResumable(entry.readiness)) continue;
        this.record(entry, "not_attempted", describeRedChecks(entry.checks));
      }
      const toResume = open.filter((entry) => isResumable(entry.readiness));
      this.queued = new Set(toResume.map((entry) => entry.agentId));
      this.options.logger.info(
        { trigger: input.trigger, resuming: toResume.map((entry) => entry.agentId) },
        "Restart recovery: resuming agents cut off mid-turn, leaders first",
      );

      const records = await this.options.agentStorage.list();
      const lineage = toLineage(records);
      const resumingIds = new Set(toResume.map((entry) => entry.agentId));
      const limit = pLimit(RESUME_CONCURRENCY);
      for (const wave of groupByDepth(toResume)) {
        if (this.stopped) break;
        await Promise.all(
          wave.map((entry) =>
            limit(() => this.resumeOne(entry, { toResume, resumingIds, lineage })),
          ),
        );
      }
      await this.noticeUnrecoveredChildren(lineage);
    } finally {
      this.applying = false;
      this.queued.clear();
    }
    return await this.getPlan();
  }

  /** Settle the selected pending entries so no later daemon offers them again. */
  async dismiss(input: { agentIds?: readonly string[] }): Promise<RestartRecoveryPlan> {
    if (this.applying) throw new RestartRecoveryBusyError();
    const plan = await this.getPlan();
    const wanted = input.agentIds ? new Set(input.agentIds) : null;
    for (const entry of plan.entries) {
      if (entry.state !== "pending" && entry.state !== "failed") continue;
      if (wanted && !wanted.has(entry.agentId)) continue;
      const endedAt = this.nowIso();
      await this.options.agentStorage.updateRunMarker(entry.agentId, (current) =>
        current?.startedAt === entry.runStartedAt
          ? settleRunMarker(current, endedAt, "dismissed")
          : current,
      );
      this.record(entry, "dismissed", "dismissed; the agent stays closed until someone opens it");
      this.options.logger.info({ agentId: entry.agentId }, "Restart recovery: entry dismissed");
    }
    return await this.getPlan();
  }

  private async resumeOne(
    entry: RestartRecoveryEntry,
    context: {
      toResume: readonly RestartRecoveryEntry[];
      resumingIds: ReadonlySet<string>;
      lineage: readonly AgentLineage[];
    },
  ): Promise<void> {
    const { agentStorage, agentManager, logger } = this.options;
    const agentId = entry.agentId;
    this.resuming.add(agentId);
    try {
      const parentId = nearestRecoveringAncestor(agentId, context.resumingIds, context.lineage);
      const parentEntry = context.toResume.find((candidate) => candidate.agentId === parentId);
      const children = context.toResume.filter(
        (candidate) =>
          nearestRecoveringAncestor(candidate.agentId, context.resumingIds, context.lineage) ===
          agentId,
      );
      const prompt = buildRecoveryResumePrompt({
        agentId,
        runStartedAt: entry.runStartedAt,
        daemonStartedAt: this.capturedAt,
        recoveringParent:
          parentEntry && this.outcomes.get(parentEntry.agentId)?.state === "resumed"
            ? toPeer(parentEntry)
            : null,
        recoveringChildren: children.map(toPeer),
      });
      // A bulk resume: paced with every other one, roots first. A child still asks admission
      // for a slot, and waitForAgentRunStart counts a queued turn as started.
      const pace = this.options.paceResume ?? unpacedResume;
      await pace(
        { agentId, root: entry.parentAgentId === null, source: "restart-recovery" },
        () =>
          sendPromptToAgent({
            agentManager,
            agentStorage,
            agentId,
            prompt: formatSystemNotificationPrompt(prompt),
            messageId: randomUUID(),
            unarchive: false,
            logger,
          }),
      );
      try {
        await waitForAgentRunStartWithTimeout(agentManager, agentId);
      } catch (error) {
        // A run fast enough to finish before this wait begins has no pending run left to wait
        // on. It did start; anything else is a real failure.
        if (!/no pending run/.test(getErrorMessage(error))) throw error;
      }
      this.record(entry, "resumed", null);
      logger.info({ agentId, depth: entry.depth }, "Restart recovery: agent resumed");
    } catch (error) {
      this.record(entry, "failed", getErrorMessage(error));
      logger.warn(
        { err: error, agentId },
        "Restart recovery: resume failed; the agent stays closed",
      );
    } finally {
      this.resuming.delete(agentId);
      this.queued.delete(agentId);
    }
  }

  /**
   * Once per apply, tell each resumed parent which of its mid-turn children did not come back,
   * so it does not wait on them.
   */
  private async noticeUnrecoveredChildren(lineage: readonly AgentLineage[]): Promise<void> {
    const plan = await this.getPlan();
    const ids = new Set(plan.entries.map((entry) => entry.agentId));
    const byParent = new Map<string, (RecoveryPeer & { reason: string })[]>();
    for (const entry of plan.entries) {
      if (entry.state !== "failed" && entry.state !== "not_attempted") continue;
      const parentId = nearestRecoveringAncestor(entry.agentId, ids, lineage);
      if (!parentId || this.outcomes.get(parentId)?.state !== "resumed") continue;
      const list = byParent.get(parentId) ?? [];
      list.push({ ...toPeer(entry), reason: entry.detail ?? entry.state });
      byParent.set(parentId, list);
    }
    for (const [parentId, children] of byParent) {
      try {
        await sendPromptToAgent({
          agentManager: this.options.agentManager,
          agentStorage: this.options.agentStorage,
          agentId: parentId,
          prompt: formatSystemNotificationPrompt(buildUnrecoveredChildrenNotice(children)),
          activeTurnBehavior: "steer",
          unarchive: false,
          logger: this.options.logger,
        });
      } catch (error) {
        this.options.logger.warn(
          { err: error, parentId },
          "Restart recovery: failed to tell a parent about children it could not resume",
        );
      }
    }
  }

  private async describe(
    run: InterruptedRun,
    record: StoredAgentRecord | null,
    depth: number,
  ): Promise<RestartRecoveryEntry> {
    const base = {
      agentId: run.agentId,
      title: record?.title ?? run.title,
      provider: record?.provider ?? run.provider,
      cwd: record?.cwd ?? run.cwd,
      workspaceId: record?.workspaceId ?? run.workspaceId,
      parentAgentId: record ? getParentAgentIdFromLabels(record.labels) : run.parentAgentId,
      depth,
      runStartedAt: run.runStartedAt,
    };
    const outcome = this.outcomes.get(run.agentId);
    if (outcome && outcome.state !== "failed") {
      return { ...base, ...outcome };
    }
    const settled = settledElsewhere(run, record);
    if (settled) {
      return { ...base, readiness: "unknown", checks: [], resolvedAt: null, ...settled };
    }
    const checks = await this.probe(record!);
    return {
      ...base,
      readiness: rollUpReadiness(checks),
      checks,
      state: this.resuming.has(run.agentId) ? "resuming" : (outcome?.state ?? "pending"),
      detail: outcome?.detail ?? null,
      resolvedAt: outcome?.resolvedAt ?? null,
    };
  }

  /**
   * OR-C4's restore check, narrowed to what Paseo can prove: reachability, not continuity. Each
   * probe that throws reports `unknown` rather than failing the plan.
   */
  private async probe(record: StoredAgentRecord): Promise<RestartRecoveryCheck[]> {
    const { agentManager } = this.options;
    const handle = record.persistence ?? null;
    const checks = await Promise.all([
      check("session", async () =>
        handle?.sessionId
          ? green(`provider session ${handle.sessionId}`)
          : red("no provider session to resume"),
      ),
      check("workspace", async () => {
        try {
          const info = await stat(record.cwd);
          return info.isDirectory() ? green(record.cwd) : red(`${record.cwd} is not a directory`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return red(`working directory ${record.cwd} is gone`);
          }
          throw error;
        }
      }),
      check("provider", async () => {
        const availability = await agentManager.getProviderAvailability(record.provider);
        return availability.available
          ? green(`${record.provider} is available`)
          : red(`${record.provider} is not available: ${availability.error ?? "no reason given"}`);
      }),
      check("transcript", async () => {
        if (!handle) return red("no session handle");
        const reachable = await agentManager.canProviderResumeSession(record.provider, handle);
        if (reachable === null) {
          return unknown(`${record.provider} cannot tell whether it can read the session`);
        }
        return reachable
          ? green(`${record.provider} can read session ${handle.sessionId}`)
          : red(`${record.provider} cannot read session ${handle.sessionId} from its account`);
      }),
      check("account", async () =>
        isLimitShapedError(record.lastError)
          ? yellow(
              `its last error was a usage limit (${record.lastError}); account failover moves it ` +
                "if the resumed turn hits the limit again",
            )
          : green("no usage-limit error on record"),
      ),
      check("live", async () => {
        const live = agentManager.getAgent(record.id);
        if (live?.lifecycle === "running") return red("already running in this daemon");
        return green(live ? `loaded, ${live.lifecycle}` : "not loaded");
      }),
    ]);
    return checks;
  }

  private record(entry: RestartRecoveryEntry, state: RestartRecoveryState, detail: string | null) {
    this.outcomes.set(entry.agentId, {
      state,
      detail,
      resolvedAt: this.nowIso(),
      readiness: entry.readiness,
      checks: entry.checks,
    });
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

/** What happened to a run without recovery acting on it, or null while it is still open. */
function settledElsewhere(
  run: InterruptedRun,
  record: StoredAgentRecord | null,
): { state: RestartRecoveryState; detail: string; resolvedAt?: string | null } | null {
  if (!record) return { state: "not_attempted", detail: "its record is gone" };
  if (record.archivedAt) {
    return { state: "not_attempted", detail: `archived at ${record.archivedAt}` };
  }
  const marker = record.runMarker;
  if (!marker || marker.startedAt !== run.runStartedAt) {
    return {
      state: "not_attempted",
      detail: marker
        ? `it ran again outside recovery (run started ${marker.startedAt})`
        : "its run marker is gone",
    };
  }
  if (marker.endedAt === undefined) return null;
  if (marker.endedBy === "dismissed") {
    return { state: "dismissed", detail: "dismissed", resolvedAt: marker.endedAt };
  }
  return {
    state: "not_attempted",
    detail: `the run settled (${marker.endedBy ?? "unknown"}) at ${marker.endedAt}`,
    resolvedAt: marker.endedAt,
  };
}

function toLineage(records: readonly StoredAgentRecord[]): AgentLineage[] {
  return records.map((record) => ({ id: record.id, labels: record.labels }));
}

function toPeer(entry: RestartRecoveryEntry): RecoveryPeer {
  return { agentId: entry.agentId, title: entry.title };
}

function describeRedChecks(checks: readonly RestartRecoveryCheck[]): string {
  const reasons = checks.filter((entry) => entry.status === "red").map((entry) => entry.detail);
  return reasons.length > 0 ? `not restorable: ${reasons.join("; ")}` : "not restorable";
}

type CheckResult = Omit<RestartRecoveryCheck, "id">;

async function check(id: string, run: () => Promise<CheckResult>): Promise<RestartRecoveryCheck> {
  try {
    return { id, ...(await run()) };
  } catch (error) {
    return { id, status: "unknown", detail: `probe failed: ${getErrorMessage(error)}` };
  }
}

function green(detail: string): CheckResult {
  return { status: "green", detail };
}
function yellow(detail: string): CheckResult {
  return { status: "yellow", detail };
}
function red(detail: string): CheckResult {
  return { status: "red", detail };
}
function unknown(detail: string): CheckResult {
  return { status: "unknown", detail };
}
