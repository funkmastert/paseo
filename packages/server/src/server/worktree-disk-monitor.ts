import type { Dirent } from "node:fs";
import { readdir, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  buildDiskSweepReclaimedNotificationPayload,
  buildDiskSweepUnsafeOrphanNotificationPayload,
} from "@getpaseo/protocol/disk-sweep-notification";
import { getCheckoutStatus } from "../utils/checkout-git.js";
import { sampleDirectorySizeBytes } from "../utils/directory-size-sampler.js";
import { deletePaseoWorktree, getPaseoWorktreesRoot } from "../utils/worktree.js";
import {
  DiskGrowthSampler,
  formatGrowthEvidence,
  type DiskGrowthReport,
} from "./disk-growth-sampler.js";
import { type DiskRemedyReport } from "./disk-remedies.js";
import type { WorkspaceDiskUsage } from "./messages.js";
import type { PushNotificationSender, PushSendMeta } from "./push/index.js";
import { resolveDiskRemediationConfig, type RemediationConfig } from "./remediation/config.js";
import {
  NULL_REMEDIATION_SINK,
  type RemediationConditionKind,
  type RemediationSink,
  type RemedyAttempt,
  type RemedyState,
} from "./remediation/contract.js";
import { formatBytes } from "./session/doctor/helpers.js";
import {
  evaluateDeletionCandidate,
  type DeletionDecision,
  type WorktreeCheckoutStatusForSweep,
  type WorktreeRegistryState,
} from "./worktree-disk-sweep-detector.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";

const DEFAULT_SWEEP_INTERVAL_MS = 600_000; // 10 minutes
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_DELETIONS_PER_TICK = 5;
const DEFAULT_MIN_FREE_GB = 5;
const DEFAULT_SAMPLE_TIMEOUT_MS = 30_000;
// Once/day per path — an unsafe orphan usually stays unsafe for a while (see
// disk-sweep-notification.ts), so a repeated push every tick would just be noise.
const UNSAFE_ORPHAN_RENOTIFY_MS = 24 * 60 * 60 * 1000;
// The main sweep tick (10 minutes) is also the free-space sampling cadence for the fall check.
// At that cadence, six readings land inside any one-hour fallWindowMinutes, which resolves a fall
// to within one tick — good enough that a second, faster timer would only double the statfs calls
// for no earlier detection. History is capped by age rather than count so a slower or faster
// sweep interval (a live-toggleable config) never overruns a fixed-size buffer.
const FREE_SPACE_HISTORY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const GIBIBYTE = 1024 ** 3;

export interface DiskSweeperConfig {
  enabled?: boolean;
  sweepIntervalMs?: number;
  retentionDays?: number;
  maxDeletionsPerTick?: number;
  minFreeGB?: number;
  sampleTimeoutMs?: number;
}

interface ResolvedDiskSweeperConfig {
  retentionDays: number;
  maxDeletionsPerTick: number;
  minFreeGB: number;
  sampleTimeoutMs: number;
}

/** `live` if any remedy is live, `dry-run` if none is live but one can't act only because of
 * dry run, `disabled` otherwise — matches "remedy is live when at least one remedy is live, and
 * disabled when none is" (docs/plans/2026-09-24-002-feat-remediation-ladder-plan.md). */
function combinedRemedyState(states: readonly RemedyState[]): RemedyState {
  if (states.includes("live")) return "live";
  if (states.includes("dry-run")) return "dry-run";
  return "disabled";
}

function resolveConfig(config: DiskSweeperConfig | undefined): ResolvedDiskSweeperConfig {
  return {
    retentionDays: config?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    maxDeletionsPerTick: config?.maxDeletionsPerTick ?? DEFAULT_MAX_DELETIONS_PER_TICK,
    minFreeGB: config?.minFreeGB ?? DEFAULT_MIN_FREE_GB,
    sampleTimeoutMs: config?.sampleTimeoutMs ?? DEFAULT_SAMPLE_TIMEOUT_MS,
  };
}

interface WorktreeDiskMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

interface SweepResult {
  deletedCount: number;
  reclaimedBytes: number;
  unsafePaths: string[];
}

export interface WorktreeDiskMonitorOptions {
  projectRegistry: Pick<{ list(): Promise<PersistedProjectRecord[]> }, "list">;
  workspaceRegistry: Pick<{ list(): Promise<PersistedWorkspaceRecord[]> }, "list">;
  paseoHome: string;
  worktreesBaseRoot?: string;
  /** For growth-sampler root expansion (`~/...`) and its default root list. Defaults to `homedir()`. */
  homeDir?: string;
  serverId: string;
  /** Lazy: the WebSocket server (and its push sender) may not exist yet at construction time. */
  getPushNotificationSender: () => PushNotificationSender | null;
  readDaemonConfig: () => { diskSweeper?: DiskSweeperConfig; remediation?: RemediationConfig };
  logger: WorktreeDiskMonitorLogger;
  /**
   * Read once at construction, like AgentTokenBurnMonitor's `sweepIntervalMs` — every other
   * `diskSweeper` field is re-read from `readDaemonConfig()` every tick and is live-toggleable;
   * changing the interval itself takes a daemon restart.
   */
  sweepIntervalMs?: number;
  now?: () => number;
  /**
   * Injected purely for testability — there's no sane way to make a test host's disk actually
   * cross a free-space threshold. Defaults to the real `node:fs/promises.statfs`.
   */
  statfs?: (path: string) => Promise<{ bavail: number; bsize: number }>;
  /** Where rung-1 disk conditions report (docs/disk-pressure.md). Defaults to a no-op sink. */
  remediationSink?: RemediationSink;
  /**
   * Lazy like `getPushNotificationSender`: bootstrap builds the done janitor after this monitor.
   * Null means not wired yet, or off — the remedy is reported as unavailable either way.
   */
  getDoneJanitorRunner?: () => (() => Promise<DiskRemedyReport>) | null;
  /** Same laziness, for the artifact janitor's on-demand sweep (needs the shared `ps` sampler). */
  getArtifactJanitorRunner?: () => (() => Promise<DiskRemedyReport>) | null;
  /** Test seam. Defaults to a real `DiskGrowthSampler` rooted at `paseoHome`/`homeDir`. */
  diskGrowthSampler?: Pick<DiskGrowthSampler, "sample" | "isSampleDue">;
}

/**
 * Daemon-side sweeper that reclaims disk space from worktree directories the archive flow
 * failed or declined to delete, and samples on-disk size for the workspace sidebar's disk-usage
 * indicator. One unref'd timer, mirroring AgentTokenBurnMonitor's shape: a fresh config read
 * each tick (live-toggleable, see daemon-config-store.ts's `worktrees.diskSweeper` treatment)
 * and no persisted state of its own — every map here is in-memory and resets on daemon restart.
 *
 * Deletion safety is entirely owned here, not by `deletePaseoWorktree` (utils/worktree.ts),
 * which has no git-safety gate of its own. See worktree-disk-sweep-detector.ts for the actual
 * gate; this class's job is enumerating candidates, resolving their registry/git facts, and
 * wrapping every filesystem/git call so one bad candidate can't wedge the sweep or the timer.
 *
 * See docs/plans/2026-09-12-007-feat-disk-sweeper-indicator-plan.md.
 */
export class WorktreeDiskMonitor {
  private readonly projectRegistry: WorktreeDiskMonitorOptions["projectRegistry"];
  private readonly workspaceRegistry: WorktreeDiskMonitorOptions["workspaceRegistry"];
  private readonly paseoHome: string;
  private readonly worktreesBaseRoot: string | undefined;
  private readonly homeDir: string;
  private readonly serverId: string;
  private readonly getPushNotificationSender: () => PushNotificationSender | null;
  private readonly readDaemonConfig: WorktreeDiskMonitorOptions["readDaemonConfig"];
  private readonly logger: WorktreeDiskMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly statfs: (path: string) => Promise<{ bavail: number; bsize: number }>;
  private readonly remediationSink: RemediationSink;
  private readonly getDoneJanitorRunner: () => (() => Promise<DiskRemedyReport>) | null;
  private readonly getArtifactJanitorRunner: () => (() => Promise<DiskRemedyReport>) | null;
  private readonly diskGrowthSampler: Pick<DiskGrowthSampler, "sample" | "isSampleDue">;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly diskUsageByWorkspaceId = new Map<string, WorkspaceDiskUsage>();
  private readonly pendingSampleRequests = new Map<string, string>();
  private readonly firstObservedUnreferencedAtByPath = new Map<string, string>();
  private readonly lastUnsafeNotifiedAtByPathMs = new Map<string, number>();
  private rotationIndex = 0;
  private criticalActive = false;

  // Remediation-ladder state (docs/disk-pressure.md). Per condition kind: the free-space history
  // used for the falling check, whether it was active last tick (so a clear is reported exactly
  // once), and the rung-1 attempts accumulated since the episode opened.
  private readonly freeBytesHistory: Array<{ atMs: number; freeBytes: number }> = [];
  private readonly conditionWasActive = new Map<RemediationConditionKind, boolean>();
  private readonly attemptsByCondition = new Map<RemediationConditionKind, RemedyAttempt[]>();
  private lastGrowthReport: DiskGrowthReport | null = null;
  /** Fallback for a closing observation's `remedy` field when this tick ran no remedies at all. */
  private lastRemedyState: RemedyState | null = null;

  constructor(options: WorktreeDiskMonitorOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.paseoHome = options.paseoHome;
    this.worktreesBaseRoot = options.worktreesBaseRoot;
    this.homeDir = options.homeDir ?? homedir();
    this.serverId = options.serverId;
    this.getPushNotificationSender = options.getPushNotificationSender;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.statfs = options.statfs ?? statfs;
    this.remediationSink = options.remediationSink ?? NULL_REMEDIATION_SINK;
    this.getDoneJanitorRunner = options.getDoneJanitorRunner ?? (() => null);
    this.getArtifactJanitorRunner = options.getArtifactJanitorRunner ?? (() => null);
    this.diskGrowthSampler =
      options.diskGrowthSampler ??
      new DiskGrowthSampler({
        paseoHome: this.paseoHome,
        homeDir: this.homeDir,
        logger: this.logger,
      });
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Worktree disk sweep failed");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Read by WorkspaceDirectoryDeps.getDiskUsage — see workspace-directory.ts. */
  getDiskUsage(workspaceId: string): WorkspaceDiskUsage | undefined {
    return this.diskUsageByWorkspaceId.get(workspaceId);
  }

  /**
   * Fire-and-forget: queues a workspace for sampling on the next tick, outside the normal
   * once-per-tick rotation. Called from workspace-directory.ts (lazy sample on first view with
   * no existing sample) and workspace-archive-service.ts (sample at archive time). A second
   * request for the same workspace before the next tick just overwrites the queued cwd — never
   * more than one sample per workspace per drain.
   */
  requestSample(workspaceId: string, cwd: string): void {
    this.pendingSampleRequests.set(workspaceId, cwd);
  }

  async tick(): Promise<void> {
    await this.runTickPass({ isEmergencyRecheck: false });
  }

  private async runTickPass(opts: { isEmergencyRecheck: boolean }): Promise<void> {
    const rawConfig = this.readDaemonConfig().diskSweeper;
    const sweeperEnabled = rawConfig?.enabled !== false;
    const config = resolveConfig(rawConfig);
    const nowMs = this.now();

    const freeBytes = await this.readFreeBytes();
    // A statfs failure leaves every condition unreported this tick rather than guessed — reported
    // as "unknown" would need its own state, and skipping is indistinguishable from "still fine"
    // to the ladder, which only hears about a condition it is told is active.
    if (freeBytes === null) {
      if (sweeperEnabled) await this.runSweepPass(config, nowMs, opts);
      return;
    }
    this.recordFreeBytes(nowMs, freeBytes);
    const emergency = this.checkEmergency(config, freeBytes);

    let sweepResult: SweepResult = { deletedCount: 0, reclaimedBytes: 0, unsafePaths: [] };
    if (sweeperEnabled) {
      sweepResult = await this.runSweepPass(config, nowMs, opts);
    }

    if (emergency.justEntered && sweeperEnabled && !opts.isEmergencyRecheck) {
      await this.runTickPass({ isEmergencyRecheck: true });
    }

    if (!opts.isEmergencyRecheck) {
      await this.reportToRemediationLadder({
        config,
        sweeperEnabled,
        freeBytes,
        nowMs,
        sweepResult,
      }).catch((error) => {
        this.logger.warn({ err: error }, "Worktree disk sweep: remediation reporting failed");
      });
    }
  }

  private async runSweepPass(
    config: ResolvedDiskSweeperConfig,
    nowMs: number,
    opts: { isEmergencyRecheck: boolean },
  ): Promise<SweepResult> {
    const sweepResult = await this.runSweep(config, nowMs).catch((error): SweepResult => {
      this.logger.error({ err: error }, "Worktree disk sweep: sweep pass failed");
      return { deletedCount: 0, reclaimedBytes: 0, unsafePaths: [] };
    });

    if (sweepResult.deletedCount > 0) {
      await this.sendPush(
        buildDiskSweepReclaimedNotificationPayload({
          serverId: this.serverId,
          count: sweepResult.deletedCount,
          bytes: sweepResult.reclaimedBytes,
        }),
        { level: "record" },
      );
    }

    await this.notifyUnsafePaths(sweepResult.unsafePaths, nowMs).catch((error) => {
      this.logger.warn({ err: error }, "Worktree disk sweep: failed to notify unsafe orphans");
    });

    // The emergency recheck pass exists to squeeze in an extra bounded deletion pass right away
    // — sampling can wait for the next regular tick.
    if (!opts.isEmergencyRecheck) {
      await this.advanceRotation(config, nowMs).catch((error) => {
        this.logger.warn({ err: error }, "Worktree disk sweep: rotation sample failed");
      });
      await this.drainPendingSamples(config, nowMs).catch((error) => {
        this.logger.warn({ err: error }, "Worktree disk sweep: pending sample drain failed");
      });
    }

    return sweepResult;
  }

  private async readFreeBytes(): Promise<number | null> {
    try {
      const stats = await this.statfs(this.paseoHome);
      return stats.bavail * stats.bsize;
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Worktree disk sweep: failed to read free disk space; skipping this tick's checks",
      );
      return null;
    }
  }

  private recordFreeBytes(nowMs: number, freeBytes: number): void {
    this.freeBytesHistory.push({ atMs: nowMs, freeBytes });
    while (
      this.freeBytesHistory.length > 0 &&
      nowMs - this.freeBytesHistory[0].atMs > FREE_SPACE_HISTORY_MAX_AGE_MS
    ) {
      this.freeBytesHistory.shift();
    }
  }

  private checkEmergency(
    config: ResolvedDiskSweeperConfig,
    freeBytes: number,
  ): { justEntered: boolean } {
    const thresholdBytes = config.minFreeGB * GIBIBYTE;
    const isCritical = freeBytes < thresholdBytes;
    const justEntered = isCritical && !this.criticalActive;
    this.criticalActive = isCritical;
    return { justEntered };
  }

  // --- Remediation ladder (docs/disk-pressure.md) ---------------------------------------------

  /**
   * The peak free-space reading within the last `windowMinutes`, minus the current reading. A
   * peak-to-now comparison (rather than oldest-to-now) catches a fall inside the window even if
   * free space briefly recovered partway through, and is never negative when space only grew.
   */
  private peakFallBytes(nowMs: number, windowMinutes: number, currentFreeBytes: number): number {
    const windowMs = windowMinutes * 60_000;
    let peak = currentFreeBytes;
    for (const entry of this.freeBytesHistory) {
      if (nowMs - entry.atMs <= windowMs && entry.freeBytes > peak) {
        peak = entry.freeBytes;
      }
    }
    return peak - currentFreeBytes;
  }

  private buildEvidence(freeBytes: number, fallBytes: number, fallWindowMinutes: number): string {
    const lines = [`Free space: ${formatBytes(freeBytes)}.`];
    if (fallBytes > 0) {
      lines.push(`Fell ${formatBytes(fallBytes)} over the last ${fallWindowMinutes} minutes.`);
    }
    if (this.lastGrowthReport) {
      lines.push(formatGrowthEvidence(this.lastGrowthReport, this.homeDir));
    }
    return lines.join("\n");
  }

  private buildEscalationTask(
    freeBytes: number,
    fallBytes: number,
    fallWindowMinutes: number,
  ): string {
    const fallNote =
      fallBytes > 0
        ? ` It has fallen ${formatBytes(fallBytes)} in the last ${fallWindowMinutes} minutes.`
        : "";
    return (
      `Free space is ${formatBytes(freeBytes)}.${fallNote} The evidence lists the top growers ` +
      "and the remedies already tried. Find what is consuming disk space; reclaim only what is " +
      "provably safe (build outputs and caches: DerivedData of projects with no running agent, " +
      "Gradle caches, /private/tmp build junk older than a day); never delete a worktree with " +
      "uncommitted or unpushed work; report what you found and reclaimed."
    );
  }

  private async runInjectedRemedy(
    runner: (() => Promise<DiskRemedyReport>) | null,
  ): Promise<DiskRemedyReport> {
    if (!runner) {
      return { state: "disabled", detail: "not wired in this daemon" };
    }
    try {
      return await runner();
    } catch (error) {
      return {
        state: "live",
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runRemedies(input: {
    sweeperEnabled: boolean;
    sweepResult: SweepResult;
    nowMs: number;
  }): Promise<{ attempts: RemedyAttempt[]; remedy: RemedyState }> {
    const atIso = new Date(input.nowMs).toISOString();
    const sweeperReport: DiskRemedyReport = input.sweeperEnabled
      ? {
          state: "live",
          outcome: input.sweepResult.deletedCount > 0 ? "acted" : "nothing-to-do",
          detail: `deleted ${input.sweepResult.deletedCount} worktree(s), freeing ${formatBytes(input.sweepResult.reclaimedBytes)}`,
        }
      : { state: "disabled", detail: "the worktree disk sweeper is off (diskSweeper.enabled)" };
    const doneReport = await this.runInjectedRemedy(this.getDoneJanitorRunner());
    const artifactReport = await this.runInjectedRemedy(this.getArtifactJanitorRunner());

    const reports: Array<{ name: string; report: DiskRemedyReport }> = [
      { name: "disk-sweeper", report: sweeperReport },
      { name: "done-janitor", report: doneReport },
      { name: "artifact-janitor", report: artifactReport },
    ];
    return {
      attempts: reports.map(({ name, report }) => ({
        remedy: name,
        outcome: report.state === "live" ? report.outcome : "skipped",
        detail: report.detail,
        at: atIso,
      })),
      remedy: combinedRemedyState(reports.map(({ report }) => report.state)),
    };
  }

  /**
   * Calls `sink.observe()` for one condition, accumulating rung-1 attempts for the episode and
   * reporting a clear exactly once — the sink is idempotent per key, but a condition that has
   * never been active has nothing to report, and re-reporting a stale clear forever would be pure
   * waste on a quiet machine.
   */
  private async observeCondition(input: {
    kind: RemediationConditionKind;
    active: boolean;
    remedy: RemedyState | undefined;
    attempts: RemedyAttempt[] | undefined;
    title: string;
    summary: string;
    evidence: string;
    graceMs?: number;
    level: "notice" | "alert" | "urgent";
    escalationTask: string;
  }): Promise<void> {
    const wasActive = this.conditionWasActive.get(input.kind) ?? false;
    if (!input.active && !wasActive) return;

    if (input.active && input.attempts && input.attempts.length > 0) {
      const accumulated = this.attemptsByCondition.get(input.kind) ?? [];
      this.attemptsByCondition.set(input.kind, [...accumulated, ...input.attempts]);
    }

    await this.remediationSink.observe({
      key: input.kind,
      kind: input.kind,
      active: input.active,
      remedy: input.remedy ?? this.lastRemedyState ?? "disabled",
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
      attempts: this.attemptsByCondition.get(input.kind),
      graceMs: input.graceMs,
      level: input.level,
      escalation: { task: input.escalationTask, taskClass: "standard" },
    });

    this.conditionWasActive.set(input.kind, input.active);
    if (!input.active) {
      this.attemptsByCondition.delete(input.kind);
    }
  }

  private async reportToRemediationLadder(input: {
    config: ResolvedDiskSweeperConfig;
    sweeperEnabled: boolean;
    freeBytes: number;
    nowMs: number;
    sweepResult: SweepResult;
  }): Promise<void> {
    const remediation = resolveDiskRemediationConfig(this.readDaemonConfig().remediation);
    if (!remediation.enabled) return;

    const { config, sweeperEnabled, freeBytes, nowMs, sweepResult } = input;
    const fallBytes = this.peakFallBytes(nowMs, remediation.fallWindowMinutes, freeBytes);

    const criticalActive = freeBytes < config.minFreeGB * GIBIBYTE;
    const lowActive = freeBytes < remediation.lowFreeBytes;
    const fallingActive = fallBytes >= remediation.fallBytes;
    const anyActive = criticalActive || lowActive || fallingActive;

    const growthDue = await this.diskGrowthSampler
      .isSampleDue({
        conditionActive: anyActive,
        sampleIntervalMinutes: remediation.sampleIntervalMinutes,
      })
      .catch(() => false);
    if (growthDue) {
      try {
        this.lastGrowthReport = await this.diskGrowthSampler.sample({
          roots: remediation.growthRoots,
          timeoutMs: remediation.sampleTimeoutMs,
          referenceWindowMs: remediation.fallWindowMinutes * 60_000,
        });
      } catch (error) {
        this.logger.warn({ err: error }, "Worktree disk sweep: growth sample failed");
      }
    }

    let remedyResult: { attempts: RemedyAttempt[]; remedy: RemedyState } | undefined;
    if (anyActive) {
      remedyResult = await this.runRemedies({ sweeperEnabled, sweepResult, nowMs });
      this.lastRemedyState = remedyResult.remedy;
    }

    const evidence = this.buildEvidence(freeBytes, fallBytes, remediation.fallWindowMinutes);
    const escalationTask = this.buildEscalationTask(
      freeBytes,
      fallBytes,
      remediation.fallWindowMinutes,
    );

    await this.observeCondition({
      kind: "disk-critical",
      active: criticalActive,
      remedy: remedyResult?.remedy,
      attempts: remedyResult?.attempts,
      title: "Disk space critical",
      summary: `Free space is ${formatBytes(freeBytes)}, below the ${config.minFreeGB} GB floor.`,
      evidence,
      graceMs: 0,
      level: "urgent",
      escalationTask,
    });

    await this.observeCondition({
      kind: "disk-low",
      active: lowActive,
      remedy: remedyResult?.remedy,
      attempts: remedyResult?.attempts,
      title: "Disk space low",
      summary: `Free space is ${formatBytes(freeBytes)}, below the ${formatBytes(remediation.lowFreeBytes)} threshold.`,
      evidence,
      level: "alert",
      escalationTask,
    });

    await this.observeCondition({
      kind: "disk-falling",
      active: fallingActive,
      remedy: remedyResult?.remedy,
      attempts: remedyResult?.attempts,
      title: "Disk space falling fast",
      summary: `Free space fell ${formatBytes(fallBytes)} in the last ${remediation.fallWindowMinutes} minutes.`,
      evidence,
      level: "alert",
      escalationTask,
    });
  }

  private async runSweep(config: ResolvedDiskSweeperConfig, nowMs: number): Promise<SweepResult> {
    const [projects, workspaces] = await Promise.all([
      this.projectRegistry.list(),
      this.workspaceRegistry.list(),
    ]);

    // Active references win outright — CRITICAL: a directory backing any active workspace
    // record, from any project, is never even considered a candidate. Archived references are
    // kept as the retention clock's reference point, using the most recent archivedAt among
    // workspaces sharing a directory (a shared-cwd fan-out, see workspace-directory.ts's
    // `workspaceIdsOnCheckout`) so retention waits for all of them.
    const activePaths = new Set<string>();
    const archivedReferenceAtByPath = new Map<string, string>();
    for (const workspace of workspaces) {
      if (workspace.kind !== "worktree") continue;
      const backingPath = resolve(workspace.worktreeRoot ?? workspace.cwd);
      if (!workspace.archivedAt) {
        activePaths.add(backingPath);
        continue;
      }
      const existing = archivedReferenceAtByPath.get(backingPath);
      if (!existing || Date.parse(workspace.archivedAt) > Date.parse(existing)) {
        archivedReferenceAtByPath.set(backingPath, workspace.archivedAt);
      }
    }
    for (const activePath of activePaths) {
      archivedReferenceAtByPath.delete(activePath);
    }

    const result: SweepResult = { deletedCount: 0, reclaimedBytes: 0, unsafePaths: [] };

    for (const project of projects) {
      if (result.deletedCount >= config.maxDeletionsPerTick) break;
      await this.sweepProject({
        project,
        activePaths,
        archivedReferenceAtByPath,
        config,
        nowMs,
        result,
      });
    }

    return result;
  }

  private async sweepProject(input: {
    project: PersistedProjectRecord;
    activePaths: ReadonlySet<string>;
    archivedReferenceAtByPath: ReadonlyMap<string, string>;
    config: ResolvedDiskSweeperConfig;
    nowMs: number;
    result: SweepResult;
  }): Promise<void> {
    const { project, activePaths, archivedReferenceAtByPath, config, nowMs, result } = input;

    let worktreesRootForProject: string;
    try {
      worktreesRootForProject = await getPaseoWorktreesRoot(
        project.rootPath,
        this.paseoHome,
        this.worktreesBaseRoot,
      );
    } catch (error) {
      this.logger.warn(
        { err: error, projectId: project.projectId },
        "Worktree disk sweep: failed to resolve worktrees root; skipping project",
      );
      return;
    }

    let entries: Dirent[];
    try {
      entries = await readdir(worktreesRootForProject, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          { err: error, worktreesRootForProject },
          "Worktree disk sweep: failed to list worktrees directory; skipping project",
        );
      }
      return;
    }

    for (const entry of entries) {
      if (result.deletedCount >= config.maxDeletionsPerTick) break;
      if (!entry.isDirectory()) continue;

      const candidatePath = resolve(worktreesRootForProject, entry.name);
      if (activePaths.has(candidatePath)) continue;

      try {
        const outcome = await this.evaluateAndMaybeDelete({
          candidatePath,
          projectRootCwd: project.rootPath,
          worktreesRootForProject,
          archivedReferenceAtByPath,
          config,
          nowMs,
        });
        if (outcome.decision === "delete") {
          result.deletedCount += 1;
          result.reclaimedBytes += outcome.bytesReclaimed ?? 0;
        } else if (outcome.decision === "keep-unsafe") {
          result.unsafePaths.push(candidatePath);
        }
      } catch (error) {
        this.logger.warn(
          { err: error, candidatePath },
          "Worktree disk sweep: failed to evaluate candidate; skipping",
        );
      }
    }
  }

  private async evaluateAndMaybeDelete(input: {
    candidatePath: string;
    projectRootCwd: string;
    worktreesRootForProject: string;
    archivedReferenceAtByPath: ReadonlyMap<string, string>;
    config: ResolvedDiskSweeperConfig;
    nowMs: number;
  }): Promise<{ decision: DeletionDecision; bytesReclaimed?: number }> {
    const {
      candidatePath,
      projectRootCwd,
      worktreesRootForProject,
      archivedReferenceAtByPath,
      config,
      nowMs,
    } = input;

    const archivedReferenceAt = archivedReferenceAtByPath.get(candidatePath);
    const registryState: WorktreeRegistryState = archivedReferenceAt
      ? { kind: "archived", referenceAt: archivedReferenceAt }
      : {
          kind: "unknown",
          referenceAt: this.resolveFirstObservedUnreferenced(candidatePath, nowMs),
        };

    let checkoutStatus: WorktreeCheckoutStatusForSweep;
    try {
      const status = await getCheckoutStatus(candidatePath);
      checkoutStatus = status.isGit
        ? { isGit: true, isDirty: status.isDirty, aheadOfOrigin: status.aheadOfOrigin }
        : { isGit: false };
    } catch (error) {
      this.logger.warn(
        { err: error, candidatePath },
        "Worktree disk sweep: failed to read checkout status; treating as unresolvable",
      );
      checkoutStatus = { isGit: false };
    }

    const decision = evaluateDeletionCandidate({
      onDiskPath: candidatePath,
      registryState,
      retentionDays: config.retentionDays,
      checkoutStatus,
      nowMs,
    });

    if (decision !== "delete") {
      return { decision };
    }

    // Sample before delete so the "reclaimed" notification has a real number even though the
    // directory won't exist to sample afterward.
    const bytesReclaimed = await sampleDirectorySizeBytes(candidatePath, {
      timeoutMs: config.sampleTimeoutMs,
    });

    try {
      await deletePaseoWorktree({
        cwd: projectRootCwd,
        worktreePath: candidatePath,
        teardownCwds: [],
        worktreesRoot: worktreesRootForProject,
        paseoHome: this.paseoHome,
        worktreesBaseRoot: this.worktreesBaseRoot,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, candidatePath },
        "Worktree disk sweep: git-safe candidate failed to delete",
      );
      return { decision: "keep-unsafe" };
    }

    this.firstObservedUnreferencedAtByPath.delete(candidatePath);
    this.lastUnsafeNotifiedAtByPathMs.delete(candidatePath);
    return { decision: "delete", bytesReclaimed: bytesReclaimed ?? 0 };
  }

  private resolveFirstObservedUnreferenced(path: string, nowMs: number): string {
    const existing = this.firstObservedUnreferencedAtByPath.get(path);
    if (existing) return existing;
    const iso = new Date(nowMs).toISOString();
    this.firstObservedUnreferencedAtByPath.set(path, iso);
    return iso;
  }

  private async notifyUnsafePaths(unsafePaths: readonly string[], nowMs: number): Promise<void> {
    for (const path of unsafePaths) {
      const lastNotifiedMs = this.lastUnsafeNotifiedAtByPathMs.get(path);
      if (lastNotifiedMs !== undefined && nowMs - lastNotifiedMs < UNSAFE_ORPHAN_RENOTIFY_MS) {
        continue;
      }
      this.lastUnsafeNotifiedAtByPathMs.set(path, nowMs);
      this.logger.warn(
        { path },
        "Worktree disk sweep: worktree has uncommitted or unpushed work; not auto-deleting",
      );
      await this.sendPush(
        buildDiskSweepUnsafeOrphanNotificationPayload({ serverId: this.serverId, path }),
        // `record`, not `notice`: the work-at-risk sweep (docs/work-snapshots.md) already snapshots
        // and escalates an orphan holding uncommitted work for judgement, so this is a ledger
        // entry, not something that still needs its own push.
        { level: "record", dedupeKey: `disk-unsafe-orphan:${path}` },
      );
    }
  }

  private async advanceRotation(config: ResolvedDiskSweeperConfig, nowMs: number): Promise<void> {
    const workspaces = await this.workspaceRegistry.list();
    const activeWorktrees = workspaces
      .filter((workspace) => workspace.kind === "worktree" && !workspace.archivedAt)
      .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    if (activeWorktrees.length === 0) return;

    const index = this.rotationIndex % activeWorktrees.length;
    this.rotationIndex = (this.rotationIndex + 1) % activeWorktrees.length;
    const workspace = activeWorktrees[index];
    await this.sampleWorkspace(
      workspace.workspaceId,
      workspace.worktreeRoot ?? workspace.cwd,
      config,
      nowMs,
    );
  }

  private async drainPendingSamples(
    config: ResolvedDiskSweeperConfig,
    nowMs: number,
  ): Promise<void> {
    if (this.pendingSampleRequests.size === 0) return;
    const requests = Array.from(this.pendingSampleRequests.entries());
    this.pendingSampleRequests.clear();
    // Own tiny sequential queue — deliberately not the git process limiter (utils/run-git-command.js),
    // and deliberately sequential rather than Promise.all so a backlog of requests can't fan out
    // into a burst of concurrent `du`/`git` processes.
    for (const [workspaceId, cwd] of requests) {
      try {
        await this.sampleWorkspace(workspaceId, cwd, config, nowMs);
      } catch (error) {
        this.logger.warn(
          { err: error, workspaceId },
          "Worktree disk sweep: failed to sample requested workspace",
        );
      }
    }
  }

  private async sampleWorkspace(
    workspaceId: string,
    dirPath: string,
    config: ResolvedDiskSweeperConfig,
    nowMs: number,
  ): Promise<void> {
    const bytes = await sampleDirectorySizeBytes(dirPath, { timeoutMs: config.sampleTimeoutMs });
    if (bytes === undefined) {
      // A hiccup, not evidence the workspace shrank to nothing — leave any prior sample in
      // place. Its `sampledAt` staleness stays visible to the client either way.
      return;
    }
    this.diskUsageByWorkspaceId.set(workspaceId, {
      bytes,
      sampledAt: new Date(nowMs).toISOString(),
    });
  }

  private async sendPush(
    payload: {
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
    meta: PushSendMeta,
  ): Promise<void> {
    const sender = this.getPushNotificationSender();
    if (!sender) return;
    try {
      await sender.send(payload, meta);
    } catch (error) {
      this.logger.warn({ err: error }, "Worktree disk sweep: failed to send push notification");
    }
  }
}
