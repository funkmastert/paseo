import type { Dirent } from "node:fs";
import { readdir, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildDiskSpaceCriticalNotificationPayload,
  buildDiskSweepReclaimedNotificationPayload,
  buildDiskSweepUnsafeOrphanNotificationPayload,
} from "@getpaseo/protocol/disk-sweep-notification";
import { getCheckoutStatus } from "../utils/checkout-git.js";
import { sampleDirectorySizeBytes } from "../utils/directory-size-sampler.js";
import { deletePaseoWorktree, getPaseoWorktreesRoot } from "../utils/worktree.js";
import type { WorkspaceDiskUsage } from "./messages.js";
import type { PushNotificationSender, PushSendMeta } from "./push/index.js";
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
  serverId: string;
  /** Lazy: the WebSocket server (and its push sender) may not exist yet at construction time. */
  getPushNotificationSender: () => PushNotificationSender | null;
  readDaemonConfig: () => { diskSweeper?: DiskSweeperConfig };
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
  private readonly serverId: string;
  private readonly getPushNotificationSender: () => PushNotificationSender | null;
  private readonly readDaemonConfig: () => { diskSweeper?: DiskSweeperConfig };
  private readonly logger: WorktreeDiskMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly statfs: (path: string) => Promise<{ bavail: number; bsize: number }>;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly diskUsageByWorkspaceId = new Map<string, WorkspaceDiskUsage>();
  private readonly pendingSampleRequests = new Map<string, string>();
  private readonly firstObservedUnreferencedAtByPath = new Map<string, string>();
  private readonly lastUnsafeNotifiedAtByPathMs = new Map<string, number>();
  private rotationIndex = 0;
  private criticalActive = false;

  constructor(options: WorktreeDiskMonitorOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workspaceRegistry = options.workspaceRegistry;
    this.paseoHome = options.paseoHome;
    this.worktreesBaseRoot = options.worktreesBaseRoot;
    this.serverId = options.serverId;
    this.getPushNotificationSender = options.getPushNotificationSender;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.statfs = options.statfs ?? statfs;
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
    if (rawConfig?.enabled === false) {
      return;
    }
    const config = resolveConfig(rawConfig);
    const nowMs = this.now();

    const emergency = await this.checkEmergency(config);

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

    if (emergency.justEntered && !opts.isEmergencyRecheck) {
      await this.runTickPass({ isEmergencyRecheck: true });
    }
  }

  private async checkEmergency(
    config: ResolvedDiskSweeperConfig,
  ): Promise<{ justEntered: boolean }> {
    let freeBytes: number;
    try {
      const stats = await this.statfs(this.paseoHome);
      freeBytes = stats.bavail * stats.bsize;
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Worktree disk sweep: failed to read free disk space; skipping emergency check",
      );
      return { justEntered: false };
    }

    const thresholdBytes = config.minFreeGB * 1024 ** 3;
    const isCritical = freeBytes < thresholdBytes;
    const justEntered = isCritical && !this.criticalActive;
    this.criticalActive = isCritical;

    if (justEntered) {
      await this.sendPush(
        buildDiskSpaceCriticalNotificationPayload({
          serverId: this.serverId,
          freeBytes,
          minFreeGB: config.minFreeGB,
        }),
        { level: "urgent", dedupeKey: "disk-space-critical" },
      );
    }

    return { justEntered };
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
        { level: "notice", dedupeKey: `disk-unsafe-orphan:${path}` },
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
