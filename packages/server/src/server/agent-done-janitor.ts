import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Logger } from "pino";

import { buildDoneJanitorNotificationPayload } from "@getpaseo/protocol/done-janitor-notification";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AgentManager, DoneJanitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent/agent-prompt.js";
import { isLimitShapedError } from "./agent/account-failover-detector.js";
import {
  buildDoneQuestion,
  formatDuration,
  isDoneAnswer,
  listDescendants,
  listRootCandidates,
  nextAskAllowedAtMs,
  recordProbeOutcome,
  describeUnread,
  treeNotDeadReason,
  treeNotDoneReason,
  type DoneJanitorAgentView,
  type DoneJanitorMemory,
  type ProbeOutcome,
} from "./agent/done-janitor-detector.js";
import type { WorktreeDeletionSafety } from "./done-janitor-worktree.js";
import type { PushNotificationSender } from "./push/index.js";
import type {
  WorktreeSnapshotOffsite,
  WorktreeSnapshotRequest,
  WorktreeSnapshotResult,
} from "./remediation/contract.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { isRealpathInsideRoot } from "../utils/path.js";

const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60_000;
/**
 * Three days. Tyler leaves agents idle overnight and over a weekend and comes back to them, so an
 * idle agent is not a finished one: Friday evening to Monday morning is about 64 hours, and the
 * quiet period has to outlast it. Asking costs a turn, so being early is not free either.
 */
const DEFAULT_QUIET_HOURS = 72;
const DEFAULT_MAX_QUESTIONS_PER_SWEEP = 1;
const DEFAULT_MAX_ARCHIVES_PER_SWEEP = 3;
const DEFAULT_ANSWER_TIMEOUT_MINUTES = 10;
/**
 * A dead agent waits as long as an idle one does, for the same reason: a daemon restart closes
 * every agent, so `closed` on Friday evening is not a session Tyler has given up on by Monday
 * morning. Its own timer, because nothing is asked and nothing is resumed, so it can be
 * shortened once a dry run has shown what it would take.
 */
const DEFAULT_DEAD_QUIET_HOURS = 72;
/** Archiving is a soft delete and cheap, so this is generous next to the question budget. */
const DEFAULT_MAX_DEAD_ARCHIVES_PER_SWEEP = 10;
/**
 * A project this young may be one someone is adding right now, before its first workspace
 * exists. Fixed, not configurable: the rule has no other knob.
 */
const EMPTY_PROJECT_MIN_AGE_MS = 60 * 60_000;
/**
 * Removing a project record is cheap and re-adding the project undoes it, so it does not spend
 * the archive budget. The cap is a blast-radius limit for the one way the rule can be wrong at
 * scale: a volume that is not mounted makes every project on it read as ENOENT. 50 is twice the
 * backlog that motivated the rule, and a larger one drains over the next sweeps.
 */
const MAX_PROJECT_REMOVALS_PER_SWEEP = 50;

export interface DoneJanitorConfig {
  enabled?: boolean;
  dryRun?: boolean;
  quietHours?: number;
  maxQuestionsPerSweep?: number;
  maxArchivesPerSweep?: number;
  answerTimeoutMinutes?: number;
  reclaimWorkspaces?: boolean;
  /** Archive agents that are dead and unpinned. Default true. */
  archiveDead?: boolean;
  deadQuietHours?: number;
  maxDeadArchivesPerSweep?: number;
  /** Ask idle live agents whether they are finished. Default true. */
  askFinished?: boolean;
}

interface ResolvedDoneJanitorConfig {
  dryRun: boolean;
  quietMs: number;
  maxQuestionsPerSweep: number;
  maxArchivesPerSweep: number;
  answerTimeoutMs: number;
  reclaimWorkspaces: boolean;
  archiveDead: boolean;
  deadQuietMs: number;
  maxDeadArchivesPerSweep: number;
  askFinished: boolean;
}

function resolveConfig(config: DoneJanitorConfig): ResolvedDoneJanitorConfig {
  return {
    dryRun: config.dryRun ?? false,
    quietMs: (config.quietHours ?? DEFAULT_QUIET_HOURS) * 60 * 60_000,
    maxQuestionsPerSweep: config.maxQuestionsPerSweep ?? DEFAULT_MAX_QUESTIONS_PER_SWEEP,
    maxArchivesPerSweep: config.maxArchivesPerSweep ?? DEFAULT_MAX_ARCHIVES_PER_SWEEP,
    answerTimeoutMs: (config.answerTimeoutMinutes ?? DEFAULT_ANSWER_TIMEOUT_MINUTES) * 60_000,
    reclaimWorkspaces: config.reclaimWorkspaces ?? true,
    archiveDead: config.archiveDead ?? true,
    deadQuietMs: (config.deadQuietHours ?? DEFAULT_DEAD_QUIET_HOURS) * 60 * 60_000,
    maxDeadArchivesPerSweep: config.maxDeadArchivesPerSweep ?? DEFAULT_MAX_DEAD_ARCHIVES_PER_SWEEP,
    askFinished: config.askFinished ?? true,
  };
}

export type DoneJanitorWorkspace = Pick<
  PersistedWorkspaceRecord,
  | "workspaceId"
  | "projectId"
  | "kind"
  | "cwd"
  | "displayName"
  | "title"
  | "worktreeRoot"
  | "isPaseoOwnedWorktree"
  | "mainRepoRoot"
  | "baseBranch"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "pinnedAt"
>;

export type DoneJanitorProject = Pick<
  PersistedProjectRecord,
  "projectId" | "rootPath" | "projectKey" | "createdAt" | "updatedAt" | "archivedAt"
>;

/** `missing` is ENOENT and nothing else: any other failure to stat is `unknown` and spares the project. */
export type ProjectRootProbe =
  | { kind: "exists" }
  | { kind: "missing" }
  | { kind: "unknown"; error: string };

export type AskAgentResult =
  | { kind: "answered"; reply: string; usedTools: boolean }
  | { kind: "permission" }
  | { kind: "timeout" }
  | { kind: "failed"; error: string };

export type ProviderHealth = { askable: true } | { askable: false; reason: string };

/**
 * Everything the janitor touches, as seams. Production wiring is `createDoneJanitor` in
 * bootstrap.ts; tests hand in fakes so no real agent is ever asked and no real directory is deleted.
 */
export interface DoneJanitorDependencies {
  listLiveAgents(): DoneJanitorAgentSummary[];
  listStoredAgents(): Promise<StoredAgentRecord[]>;
  listWorkspaces(): Promise<DoneJanitorWorkspace[]>;
  /** Agents a schedule or heartbeat that is not completed still targets. */
  listScheduledAgentIds(): Promise<ReadonlySet<string>>;
  getProviderHealth(provider: string): Promise<ProviderHealth>;
  askAgent(input: { agentId: string; prompt: string; timeoutMs: number }): Promise<AskAgentResult>;
  archiveAgent(agentId: string): Promise<void>;
  countTerminals(workspaceId: string): Promise<number>;
  isPaseoOwnedWorktreePath(path: string): Promise<boolean>;
  checkWorktree(input: {
    worktreePath: string;
    baseBranch: string | null;
  }): Promise<WorktreeDeletionSafety>;
  measureBytes(path: string): Promise<number | undefined>;
  /** Archives the workspace record and deletes its worktree: archive-by-scope, the same path a person's archive takes. */
  reclaimWorkspace(workspaceId: string): Promise<{ removedDirectory: boolean }>;
  /**
   * Snapshots a worktree's uncommitted and unpushed work under `refs/backup/` without touching
   * it (docs/work-snapshots.md). Called before a dead agent is archived and before any worktree
   * is deleted.
   */
  snapshotWorktree(request: WorktreeSnapshotRequest): Promise<WorktreeSnapshotResult>;
  listProjects(): Promise<DoneJanitorProject[]>;
  probeProjectRoot(rootPath: string): Promise<ProjectRootProbe>;
  /**
   * Removes the project record and its custom icon, the same two steps a person's project
   * removal takes. Every connected client's sidebar follows from the registry's mutation
   * subscription, not from this call.
   */
  removeProject(projectId: string): Promise<void>;
}

export interface AgentDoneJanitorOptions {
  dependencies: DoneJanitorDependencies;
  getPushNotificationSender: () => PushNotificationSender | null;
  serverId: string;
  readDaemonConfig: () => { doneJanitor?: DoneJanitorConfig };
  logger: Logger;
  sweepIntervalMs?: number;
  now?: () => number;
}

type WorkspacePlan =
  | { kind: "reclaim"; workspace: DoneJanitorWorkspace; path: string; branch: string | null }
  | { kind: "keep"; workspace: DoneJanitorWorkspace | null; reason: string };

/** One line of a sweep's report: what was (or, in a dry run, would be) done, and why. */
export interface DoneJanitorReportEntry {
  action:
    | "not-done"
    | "cannot-ask"
    | "would-ask"
    | "asked"
    | "would-archive"
    | "archived"
    | "would-delete"
    | "deleted"
    | "kept-workspace"
    | "kept-agent"
    | "snapshotted"
    | "would-remove-project"
    | "removed-project"
    | "kept-project";
  agentId?: string;
  title?: string | null;
  workspaceId?: string;
  projectId?: string;
  path?: string;
  bytes?: number;
  reason: string;
}

export interface DoneJanitorSweepReport {
  dryRun: boolean;
  /** Empty projects removed this sweep; a dry run removes none. */
  removedProjectCount: number;
  entries: DoneJanitorReportEntry[];
}

/**
 * Archives root agents that are definitely finished, then reclaims their worktrees. Same shape as
 * AccountFailoverMonitor and the build-daemon reaper: an unref'd timer, config re-read every
 * sweep (live-toggleable), a sweep never overlapping the last, and memory that a restart only
 * ever makes more cautious. See docs/done-janitor.md.
 *
 * "Finished" takes three proofs, in order, and the expensive one last: every mechanical check in
 * done-janitor-detector.ts holds for the agent and its whole tree; the agent itself answers the
 * strict one-word `DONE`; and, before its worktree is deleted, done-janitor-worktree.ts proves
 * nothing in it exists nowhere else.
 */
export class AgentDoneJanitor {
  private readonly options: AgentDoneJanitorOptions;
  private readonly deps: DoneJanitorDependencies;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private readonly memory: DoneJanitorMemory = new Map();
  /** The last report logged per subject, so an unchanged verdict is not logged every sweep. */
  private readonly lastLogged = new Map<string, string>();
  /**
   * This sweep's failed snapshots of work at risk, by worktree path. Each spares its worktree
   * from reclamation until the next sweep tries again.
   */
  private readonly snapshotFailures = new Map<string, string>();

  constructor(options: AgentDoneJanitorOptions) {
    this.options = options;
    this.deps = options.dependencies;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Done janitor sweep failed");
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

  /** Runs one sweep; returns null when disabled or when another sweep is in flight. */
  async tick(): Promise<DoneJanitorSweepReport | null> {
    if (this.sweepInFlight) return null;
    this.sweepInFlight = true;
    try {
      return await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<DoneJanitorSweepReport | null> {
    const raw = this.options.readDaemonConfig().doneJanitor;
    if (raw?.enabled !== true) return null;
    const config = resolveConfig(raw);
    const nowMs = this.now();
    const report: DoneJanitorSweepReport = {
      dryRun: config.dryRun,
      removedProjectCount: 0,
      entries: [],
    };
    this.snapshotFailures.clear();

    let views = await this.loadViews();
    let workspaces = await this.deps.listWorkspaces();

    // Dead agents first: they are archived without being asked, and they are not the ones the
    // question budget is for.
    const dead = config.archiveDead
      ? await this.sweepDeadAgents(report, views, workspaces, config, nowMs)
      : { archivedAgentCount: 0, deletedWorkspaceIds: new Set<string>() };
    if (dead.archivedAgentCount > 0) {
      views = await this.loadViews();
      workspaces = await this.deps.listWorkspaces();
    }

    const askable: Array<{ root: DoneJanitorAgentView; plan: WorkspacePlan; quietForMs: number }> =
      [];
    for (const root of config.askFinished ? listRootCandidates(views) : []) {
      // Asking a closed agent resumes it at cache-cold prices. With the dead pass on, a closed
      // agent is the dead pass's to archive or spare, never the question's.
      if (config.archiveDead && !root.live) continue;
      const verdict = await this.evaluateRoot(root, views, workspaces, config, nowMs);
      if (verdict.kind !== "ask") {
        report.entries.push({
          ...describeAgent(root),
          action: verdict.kind,
          reason: verdict.reason,
        });
        continue;
      }
      askable.push({ root, plan: verdict.plan, quietForMs: verdict.quietForMs });
    }

    // Most disk per question first, then the longest quiet: asking costs a turn.
    askable.sort(
      (a, b) =>
        Number(b.plan.kind === "reclaim") - Number(a.plan.kind === "reclaim") ||
        b.quietForMs - a.quietForMs,
    );
    const budget = Math.min(config.maxQuestionsPerSweep, config.maxArchivesPerSweep);
    const reclaimedWorkspaceIds = new Set<string>(dead.deletedWorkspaceIds);
    let archivedCount = 0;
    for (const [index, candidate] of askable.entries()) {
      const { root } = candidate;
      if (index >= budget) {
        report.entries.push({
          ...describeAgent(root),
          action: "not-done",
          reason: "eligible, but this sweep's question budget is spent; next sweep",
        });
        continue;
      }
      if (config.dryRun) {
        this.reportDryRunCandidate(report, candidate, views);
        continue;
      }
      const archived = await this.askAndArchive(report, candidate, config);
      if (!archived) continue;
      archivedCount += 1;
      // The archive changed the fleet; plan the workspace against what is true now.
      views = await this.loadViews();
      workspaces = await this.deps.listWorkspaces();
      if (!root.workspaceId || reclaimedWorkspaceIds.has(root.workspaceId)) continue;
      const plan = await this.planWorkspace(root.workspaceId, views, workspaces, new Set(), config);
      if (await this.reclaim(report, plan, `its agent ${root.id} answered DONE`)) {
        reclaimedWorkspaceIds.add(root.workspaceId);
      }
    }

    await this.sweepOrphanWorkspaces(
      report,
      views,
      workspaces,
      config,
      nowMs,
      reclaimedWorkspaceIds,
      config.maxArchivesPerSweep - archivedCount - dead.deletedWorkspaceIds.size,
    );

    await this.sweepEmptyProjects(report, config);

    this.logReport(report);
    if (!config.dryRun) await this.notify(report, archivedCount, dead.archivedAgentCount);
    return report;
  }

  /**
   * Removes projects that are sidebar clutter: no workspace of any kind, and a root that is
   * gone. Runs last so a workspace reclaimed earlier this sweep, which stays on the registry as
   * archived, keeps its project. Each removal is decided on freshly read state.
   */
  private async sweepEmptyProjects(
    report: DoneJanitorSweepReport,
    config: ResolvedDoneJanitorConfig,
  ): Promise<void> {
    const { logger } = this.options;
    try {
      const candidates = await this.listEmptyProjectCandidates();
      for (const [index, candidate] of candidates.entries()) {
        if (index >= MAX_PROJECT_REMOVALS_PER_SWEEP) {
          report.entries.push({
            action: "kept-project",
            reason: `${describeProjectBacklog(candidates.length - index)} for the next sweep`,
          });
          return;
        }
        if (config.dryRun) {
          report.entries.push(describeEmptyProject(candidate, "would-remove-project"));
          continue;
        }
        await this.removeEmptyProject(report, candidate);
      }
    } catch (error) {
      logger.warn({ err: error }, "Done janitor: the empty project pass failed");
    }
  }

  private async listEmptyProjectCandidates(): Promise<DoneJanitorProject[]> {
    const [projects, workspaces] = await Promise.all([
      this.deps.listProjects(),
      this.deps.listWorkspaces(),
    ]);
    const candidates: DoneJanitorProject[] = [];
    for (const project of projects) {
      if (emptyProjectBlocker(project, workspaces, this.now())) continue;
      if ((await this.deps.probeProjectRoot(project.rootPath)).kind === "missing") {
        candidates.push(project);
      }
    }
    return candidates;
  }

  /**
   * Re-reads the project, its workspaces and its root, so a project someone created, or whose
   * worktree is being created, since the sweep's read is left alone. The registry has no
   * conditional remove, so a workspace created in the milliseconds after this check still loses
   * its project record; the project comes back with the next `project.add`.
   */
  private async removeEmptyProject(
    report: DoneJanitorSweepReport,
    candidate: DoneJanitorProject,
  ): Promise<void> {
    const { logger } = this.options;
    const fresh = (await this.deps.listProjects()).find(
      (project) => project.projectId === candidate.projectId,
    );
    // Removed by someone else in the meantime: nothing left to do, nothing to report.
    if (!fresh) return;
    const workspaces = await this.deps.listWorkspaces();
    const changed =
      emptyProjectBlocker(fresh, workspaces, this.now()) ??
      describeRootProbe(await this.deps.probeProjectRoot(fresh.rootPath));
    if (changed) {
      report.entries.push({
        ...describeEmptyProject(fresh, "kept-project"),
        reason: `it was empty and its directory was gone, but then ${changed}`,
      });
      return;
    }
    try {
      await this.deps.removeProject(fresh.projectId);
    } catch (error) {
      logger.warn(
        { err: error, projectId: fresh.projectId },
        "Done janitor: removing an empty project failed",
      );
      report.entries.push({
        ...describeEmptyProject(fresh, "kept-project"),
        reason: `removal failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    report.removedProjectCount += 1;
    report.entries.push(describeEmptyProject(fresh, "removed-project"));
  }

  /**
   * Archives every root whose whole tree is dead, then reclaims the worktrees they leave empty.
   * Roots first, worktrees second: a workspace shared by several dead roots is planned once,
   * after the last of them is archived, so it is judged on what is true then. A dry run reports
   * the same two steps against the archives it would make.
   */
  private async sweepDeadAgents(
    report: DoneJanitorSweepReport,
    views: readonly DoneJanitorAgentView[],
    workspaces: readonly DoneJanitorWorkspace[],
    config: ResolvedDoneJanitorConfig,
    nowMs: number,
  ): Promise<{ archivedAgentCount: number; deletedWorkspaceIds: Set<string> }> {
    const eligible = this.listDeadRoots(report, views, config, nowMs);
    const archivedRoots: DoneJanitorAgentView[] = [];
    const archivingIds = new Set<string>();
    let archivedAgentCount = 0;
    for (const [index, root] of eligible.entries()) {
      if (index >= config.maxDeadArchivesPerSweep) {
        report.entries.push({
          ...describeAgent(root),
          action: "kept-agent",
          reason: "dead, but this sweep's archive budget is spent; next sweep",
        });
        continue;
      }
      const tree = [root, ...listDescendants(root.id, views)];
      const detail = describeDeadRoot(root, tree, nowMs);
      if (config.dryRun) {
        report.entries.push({ ...describeAgent(root), action: "would-archive", reason: detail });
        for (const view of tree) archivingIds.add(view.id);
      } else if (!(await this.archiveDeadRoot(report, root, detail, config))) {
        continue;
      }
      archivedRoots.push(root);
      archivedAgentCount += tree.length;
    }

    const deletedWorkspaceIds = await this.reclaimDeadWorkspaces(
      report,
      archivedRoots,
      { views, workspaces, archivingIds },
      config,
    );
    return { archivedAgentCount, deletedWorkspaceIds };
  }

  /** The roots whose whole tree is dead, longest dead first; a dead-looking root that is spared is reported. */
  private listDeadRoots(
    report: DoneJanitorSweepReport,
    views: readonly DoneJanitorAgentView[],
    config: ResolvedDoneJanitorConfig,
    nowMs: number,
  ): DoneJanitorAgentView[] {
    const eligible: DoneJanitorAgentView[] = [];
    for (const root of listRootCandidates(views)) {
      // A live agent that is not in error is not a candidate at all, and is not reported: the
      // fleet is mostly those, and the done check is what decides them.
      if (root.live && root.lifecycle !== "error") continue;
      const reason = treeNotDeadReason(root, views, nowMs, config.deadQuietMs);
      if (reason) {
        report.entries.push({ ...describeAgent(root), action: "kept-agent", reason });
      } else {
        eligible.push(root);
      }
    }
    return eligible.sort((a, b) => (a.lastActivityAtMs ?? 0) - (b.lastActivityAtMs ?? 0));
  }

  /** Archives one dead root against freshly read state; false when it was spared or the archive failed. */
  private async archiveDeadRoot(
    report: DoneJanitorSweepReport,
    root: DoneJanitorAgentView,
    detail: string,
    config: ResolvedDoneJanitorConfig,
  ): Promise<boolean> {
    const { logger } = this.options;
    // A person may have opened it since the views were read; the archive is decided on now.
    const fresh = await this.loadViews();
    const freshRoot = fresh.find((view) => view.id === root.id);
    const changed = freshRoot
      ? treeNotDeadReason(freshRoot, fresh, this.now(), config.deadQuietMs)
      : "disappeared";
    if (changed) {
      report.entries.push({
        ...describeAgent(root),
        action: "kept-agent",
        reason: `dead, but then ${changed}`,
      });
      return false;
    }
    // Before the archive: once archived, nothing else watches this agent's work.
    const cwds = new Set([freshRoot, ...listDescendants(root.id, fresh)].map((view) => view?.cwd));
    for (const cwd of cwds) {
      if (cwd)
        await this.snapshot(report, cwd, `done janitor, before archiving dead agent ${root.id}`);
    }
    try {
      await this.deps.archiveAgent(root.id);
    } catch (error) {
      logger.warn({ err: error, agentId: root.id }, "Done janitor: archive of a dead agent failed");
      report.entries.push({
        ...describeAgent(root),
        action: "kept-agent",
        reason: `archive failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
    report.entries.push({ ...describeAgent(root), action: "archived", reason: detail });
    logger.info(
      { agentId: root.id, title: root.title, workspaceId: root.workspaceId },
      "Done janitor: archived a dead agent",
    );
    return true;
  }

  /**
   * Plans each archived root's workspace once. A live sweep plans against fresh state; a dry run
   * against the state as it is, with `archivingIds` standing in for the archives it did not make.
   */
  private async reclaimDeadWorkspaces(
    report: DoneJanitorSweepReport,
    archivedRoots: readonly DoneJanitorAgentView[],
    dryRunState: {
      views: readonly DoneJanitorAgentView[];
      workspaces: readonly DoneJanitorWorkspace[];
      archivingIds: ReadonlySet<string>;
    },
    config: ResolvedDoneJanitorConfig,
  ): Promise<Set<string>> {
    const deletedWorkspaceIds = new Set<string>();
    if (archivedRoots.length === 0) return deletedWorkspaceIds;
    const views = config.dryRun ? dryRunState.views : await this.loadViews();
    const workspaces = config.dryRun ? dryRunState.workspaces : await this.deps.listWorkspaces();
    const why = "every agent in it is dead or archived";
    let deletions = 0;
    const planned = new Set<string>();
    for (const root of archivedRoots) {
      const workspaceId = root.workspaceId;
      if (!workspaceId || planned.has(workspaceId)) continue;
      planned.add(workspaceId);
      const plan = await this.planWorkspace(
        workspaceId,
        views,
        workspaces,
        dryRunState.archivingIds,
        config,
      );
      if (plan.kind === "reclaim" && deletions >= config.maxArchivesPerSweep) {
        // Left for the orphan sweep, which sees it next sweep with a fresh budget.
        report.entries.push({
          action: "kept-workspace",
          workspaceId,
          path: plan.path,
          reason: "its agents are archived, but this sweep's deletion budget is spent; next sweep",
        });
      } else if (config.dryRun) {
        report.entries.push(this.describePlan(plan, true, why));
        if (plan.kind === "reclaim") deletions += 1;
      } else if (await this.reclaim(report, plan, why)) {
        deletedWorkspaceIds.add(workspaceId);
        deletions += 1;
      }
    }
    return deletedWorkspaceIds;
  }

  private async evaluateRoot(
    root: DoneJanitorAgentView,
    views: readonly DoneJanitorAgentView[],
    workspaces: readonly DoneJanitorWorkspace[],
    config: ResolvedDoneJanitorConfig,
    nowMs: number,
  ): Promise<
    | { kind: "not-done" | "cannot-ask"; reason: string }
    | { kind: "ask"; plan: WorkspacePlan; quietForMs: number }
  > {
    const notDone = treeNotDoneReason(root, views, nowMs, config.quietMs, config.quietMs);
    if (notDone) return { kind: "not-done", reason: notDone };
    const record = this.memory.get(root.id);
    const nextAskAtMs = nextAskAllowedAtMs(record, config.quietMs);
    if (record && nowMs < nextAskAtMs) {
      return {
        kind: "not-done",
        reason: `asked ${formatDuration(nowMs - record.askedAtMs)} ago (${record.outcome}); asks again in ${formatDuration(nextAskAtMs - nowMs)}`,
      };
    }
    // Leave it and say so: an agent that cannot answer has not said it is done.
    if (!root.hasSession)
      return { kind: "cannot-ask", reason: "has no provider session to resume" };
    const health = await this.deps.getProviderHealth(root.provider);
    if (!health.askable) return { kind: "cannot-ask", reason: health.reason };
    const treeIds = new Set([root.id, ...listDescendants(root.id, views).map((view) => view.id)]);
    const plan = root.workspaceId
      ? await this.planWorkspace(root.workspaceId, views, workspaces, treeIds, config)
      : { kind: "keep" as const, workspace: null, reason: "the agent has no workspace" };
    return { kind: "ask", plan, quietForMs: nowMs - (root.lastActivityAtMs ?? nowMs) };
  }

  private reportDryRunCandidate(
    report: DoneJanitorSweepReport,
    candidate: { root: DoneJanitorAgentView; plan: WorkspacePlan; quietForMs: number },
    views: readonly DoneJanitorAgentView[],
  ): void {
    const { root, plan } = candidate;
    const subagents = listDescendants(root.id, views).length;
    report.entries.push({
      ...describeAgent(root),
      action: "would-ask",
      reason: `every mechanical check passed; quiet for ${formatDuration(candidate.quietForMs)}`,
    });
    report.entries.push({
      ...describeAgent(root),
      action: "would-archive",
      reason:
        subagents > 0
          ? `if it answers DONE (with ${subagents} subagent(s) by cascade)`
          : "if it answers DONE",
    });
    report.entries.push(this.describePlan(plan, true));
  }

  /** Asks one agent, and archives it only on a strict DONE that still holds a moment later. */
  private async askAndArchive(
    report: DoneJanitorSweepReport,
    candidate: { root: DoneJanitorAgentView; quietForMs: number },
    config: ResolvedDoneJanitorConfig,
  ): Promise<boolean> {
    const { root } = candidate;
    const { logger } = this.options;
    const askedAtMs = this.now();
    const result = await this.deps.askAgent({
      agentId: root.id,
      prompt: buildDoneQuestion(candidate.quietForMs),
      timeoutMs: config.answerTimeoutMs,
    });
    const outcome = readOutcome(result);
    report.entries.push({
      ...describeAgent(root),
      action: "asked",
      reason: describeOutcome(result),
    });
    logger.info(
      { agentId: root.id, title: root.title, workspaceId: root.workspaceId, outcome },
      "Done janitor: asked an agent whether it is finished",
    );
    if (outcome !== "done") {
      recordProbeOutcome(this.memory, root.id, askedAtMs, outcome);
      return false;
    }

    // The answer is the newest activity, so the root's quiet check is replaced by the rest of
    // the checks against fresh state. Its subagents were not asked and keep theirs.
    const fresh = await this.loadViews();
    const freshRoot = fresh.find((view) => view.id === root.id);
    const changed = freshRoot
      ? treeNotDoneReason(freshRoot, fresh, this.now(), null, config.quietMs)
      : "disappeared";
    if (changed) {
      recordProbeOutcome(this.memory, root.id, askedAtMs, "changed-after-answer");
      report.entries.push({
        ...describeAgent(root),
        action: "not-done",
        reason: `answered DONE, but then ${changed}`,
      });
      return false;
    }

    try {
      await this.deps.archiveAgent(root.id);
    } catch (error) {
      recordProbeOutcome(this.memory, root.id, askedAtMs, "failed");
      logger.warn({ err: error, agentId: root.id }, "Done janitor: archive failed");
      return false;
    }
    recordProbeOutcome(this.memory, root.id, askedAtMs, "done");
    report.entries.push({ ...describeAgent(root), action: "archived", reason: "answered DONE" });
    logger.info(
      { agentId: root.id, title: root.title, workspaceId: root.workspaceId },
      "Done janitor: archived a finished agent",
    );
    return true;
  }

  /**
   * Workspaces nobody will ever ask about: every agent in them is already archived, by a person
   * or by an earlier sweep whose reclaim failed. Archiving an agent never archives its
   * workspace, so without this they accumulate forever.
   */
  private async sweepOrphanWorkspaces(
    report: DoneJanitorSweepReport,
    views: readonly DoneJanitorAgentView[],
    workspaces: readonly DoneJanitorWorkspace[],
    config: ResolvedDoneJanitorConfig,
    nowMs: number,
    alreadyReclaimed: ReadonlySet<string>,
    budget: number,
  ): Promise<void> {
    if (!config.reclaimWorkspaces) return;
    let remaining = budget;
    for (const workspace of workspaces) {
      if (remaining <= 0) return;
      if (workspace.archivedAt || workspace.kind !== "worktree") continue;
      if (alreadyReclaimed.has(workspace.workspaceId)) continue;
      const agents = views.filter((view) => view.workspaceId === workspace.workspaceId);
      // Never had an agent: someone may have made it a minute ago to start one. Not ours.
      if (agents.length === 0 || agents.some((view) => !view.archived)) continue;
      const newestMs = Math.max(
        ...agents.map((view) => view.lastActivityAtMs ?? Number.POSITIVE_INFINITY),
        parseMs(workspace.updatedAt),
        parseMs(workspace.createdAt),
      );
      if (!(nowMs - newestMs >= config.quietMs)) continue;
      const plan = await this.planWorkspace(
        workspace.workspaceId,
        views,
        workspaces,
        new Set(),
        config,
      );
      const reason = `every agent in it was archived and it has been quiet for ${formatDuration(nowMs - newestMs)}`;
      // Only a deletion spends the budget: a worktree kept for a reason that holds every sweep
      // (a dirty tree, say) would otherwise starve the ones after it forever.
      if (plan.kind === "reclaim") remaining -= 1;
      if (config.dryRun) {
        report.entries.push(this.describePlan(plan, true, reason));
        continue;
      }
      await this.reclaim(report, plan, reason);
    }
  }

  /**
   * Whether a workspace's worktree may be deleted once the agents in `archivingIds` are
   * archived. Cheap checks first, git last.
   */
  private async planWorkspace(
    workspaceId: string,
    views: readonly DoneJanitorAgentView[],
    workspaces: readonly DoneJanitorWorkspace[],
    archivingIds: ReadonlySet<string>,
    config: ResolvedDoneJanitorConfig,
  ): Promise<WorkspacePlan> {
    const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId) ?? null;
    const keep = (reason: string): WorkspacePlan => ({ kind: "keep", workspace, reason });
    if (!config.reclaimWorkspaces) return keep("workspace reclamation is off");
    if (workspace?.pinnedAt) return keep("its workspace is pinned");
    const recordProblem = workspaceRecordProblem(workspace);
    if (recordProblem || !workspace?.worktreeRoot) {
      return keep(recordProblem ?? "the workspace record is missing");
    }
    const path = resolve(workspace.worktreeRoot);
    if (!(await this.deps.isPaseoOwnedWorktreePath(path))) {
      return keep("its directory is outside the Paseo worktrees root");
    }
    for (const [failedPath, error] of this.snapshotFailures) {
      if (overlaps(path, failedPath)) {
        return keep(`its work is at risk and could not be snapshotted: ${error}`);
      }
    }
    const conflict = directoryConflict(workspace, path, workspaces, views, archivingIds);
    if (conflict) return keep(conflict);
    const terminals = await this.deps.countTerminals(workspaceId);
    if (terminals > 0) return keep(`it has ${terminals} open terminal(s)`);
    const safety = await this.deps.checkWorktree({
      worktreePath: path,
      baseBranch: workspace.baseBranch,
    });
    if (!safety.safe) return keep(safety.reason);
    return { kind: "reclaim", workspace, path, branch: safety.branch };
  }

  private describePlan(plan: WorkspacePlan, dryRun: boolean, why?: string): DoneJanitorReportEntry {
    if (plan.kind === "keep") {
      return {
        action: "kept-workspace",
        workspaceId: plan.workspace?.workspaceId,
        path: plan.workspace?.worktreeRoot ?? plan.workspace?.cwd,
        reason: plan.reason,
      };
    }
    const branch = plan.branch
      ? `branch ${plan.branch} is merged or pushed`
      : "HEAD is merged or pushed";
    return {
      action: dryRun ? "would-delete" : "deleted",
      workspaceId: plan.workspace.workspaceId,
      path: plan.path,
      reason: `${why ? `${why}; ` : ""}clean tree and ${branch}`,
    };
  }

  private async reclaim(
    report: DoneJanitorSweepReport,
    plan: WorkspacePlan,
    why: string,
  ): Promise<boolean> {
    const { logger } = this.options;
    if (plan.kind === "keep") {
      report.entries.push(this.describePlan(plan, false));
      logger.info(
        {
          workspaceId: plan.workspace?.workspaceId,
          path: plan.workspace?.worktreeRoot,
          reason: plan.reason,
        },
        "Done janitor: kept a workspace",
      );
      return false;
    }
    // The git gate passed, but it counts a commit on the local base branch as safe; the snapshot
    // keeps a copy anyway, and a failure keeps the worktree.
    const snapshotError = await this.snapshot(
      report,
      plan.path,
      `done janitor, before deleting workspace ${plan.workspace.workspaceId}`,
    );
    if (snapshotError) {
      report.entries.push({
        action: "kept-workspace",
        workspaceId: plan.workspace.workspaceId,
        path: plan.path,
        reason: `its work is at risk and could not be snapshotted: ${snapshotError}`,
      });
      return false;
    }
    const bytes = await this.deps.measureBytes(plan.path);
    try {
      const result = await this.deps.reclaimWorkspace(plan.workspace.workspaceId);
      const entry = { ...this.describePlan(plan, false, why), bytes };
      if (!result.removedDirectory) {
        entry.action = "kept-workspace";
        entry.reason = "archived the workspace, but the directory was not removed (see daemon log)";
        delete entry.bytes;
      }
      report.entries.push(entry);
      logger.info(
        {
          workspaceId: plan.workspace.workspaceId,
          path: plan.path,
          branch: plan.branch,
          bytes,
          removedDirectory: result.removedDirectory,
          reason: why,
        },
        "Done janitor: reclaimed a workspace",
      );
      return result.removedDirectory;
    } catch (error) {
      logger.warn(
        { err: error, workspaceId: plan.workspace.workspaceId, path: plan.path },
        "Done janitor: workspace reclaim failed",
      );
      report.entries.push({
        action: "kept-workspace",
        workspaceId: plan.workspace.workspaceId,
        path: plan.path,
        reason: `reclaim failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Snapshots the worktree around `cwd`. Returns the error when work at risk could not be
   * snapshotted, and remembers it so the worktree is spared this sweep; null otherwise. A
   * directory git cannot read holds nothing a snapshot could save.
   */
  private async snapshot(
    report: DoneJanitorSweepReport,
    cwd: string,
    reason: string,
  ): Promise<string | null> {
    const result = await this.deps.snapshotWorktree({ cwd, reason });
    if (result.kind === "snapshotted") {
      report.entries.push({
        action: "snapshotted",
        path: result.worktreePath,
        reason: `${result.ref}; ${describeOffsite(result.offsite)}`,
      });
      return null;
    }
    if (result.kind === "failed" && result.worktreePath) {
      this.snapshotFailures.set(result.worktreePath, result.error);
      this.options.logger.warn(
        { path: result.worktreePath, error: result.error },
        "Done janitor: snapshot of work at risk failed; its worktree is kept",
      );
      return result.error;
    }
    return null;
  }

  private async loadViews(): Promise<DoneJanitorAgentView[]> {
    const [stored, scheduled, workspaces] = await Promise.all([
      this.deps.listStoredAgents(),
      this.deps.listScheduledAgentIds(),
      this.deps.listWorkspaces(),
    ]);
    const pinnedWorkspaceIds = new Set(
      workspaces
        .filter((workspace) => workspace.pinnedAt)
        .map((workspace) => workspace.workspaceId),
    );
    return buildAgentViews(this.deps.listLiveAgents(), stored, scheduled, pinnedWorkspaceIds);
  }

  /** Logs each subject's line only when it changed since the last sweep. */
  private logReport(report: DoneJanitorSweepReport): void {
    const seen = new Set<string>();
    for (const entry of report.entries) {
      const subject = entry.agentId ?? entry.workspaceId ?? entry.projectId ?? entry.path ?? "";
      const key = `${subject}:${entry.action.replace(/^would-/, "")}`;
      seen.add(key);
      const line = `${entry.action}:${entry.reason}`;
      if (this.lastLogged.get(key) === line) continue;
      this.lastLogged.set(key, line);
      if (entry.action === "not-done") continue;
      this.options.logger.info(
        { ...entry, dryRun: report.dryRun },
        report.dryRun ? "Done janitor (dry run)" : "Done janitor",
      );
    }
    for (const key of this.lastLogged.keys()) {
      if (!seen.has(key)) this.lastLogged.delete(key);
    }
  }

  private async notify(
    report: DoneJanitorSweepReport,
    archivedAgentCount: number,
    archivedDeadAgentCount: number,
  ): Promise<void> {
    const deleted = report.entries.filter((entry) => entry.action === "deleted");
    if (
      archivedAgentCount === 0 &&
      archivedDeadAgentCount === 0 &&
      deleted.length === 0 &&
      report.removedProjectCount === 0
    ) {
      return;
    }
    const sender = this.options.getPushNotificationSender();
    if (!sender) return;
    const keptWorktrees = report.entries.filter(
      (entry) => entry.action === "kept-workspace" && entry.workspaceId,
    );
    try {
      await sender.send(
        buildDoneJanitorNotificationPayload({
          serverId: this.options.serverId,
          archivedAgentCount,
          archivedDeadAgentCount,
          deletedWorktreeCount: deleted.length,
          removedProjectCount: report.removedProjectCount,
          reclaimedBytes: deleted.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
          keptWorktrees: keptWorktrees.map((entry) => ({
            name: entry.path ?? entry.workspaceId ?? "",
            reason: entry.reason,
          })),
        }),
        // Only recorded, kept worktrees included: each is snapshotted, and the work-at-risk sweep
        // decides whether one needs a person (docs/work-snapshots.md).
        { level: "record" },
      );
    } catch (error) {
      this.options.logger.warn({ err: error }, "Done janitor: push notification failed");
    }
  }
}

function describeProjectBacklog(count: number): string {
  return count === 1 ? "1 more empty project waits" : `${count} more empty projects wait`;
}

const EMPTY_PROJECT_REASON = "it has no workspaces and its directory no longer exists";

function describeEmptyProject(
  project: DoneJanitorProject,
  action: "would-remove-project" | "removed-project" | "kept-project",
): DoneJanitorReportEntry {
  return {
    action,
    projectId: project.projectId,
    path: project.rootPath,
    reason: EMPTY_PROJECT_REASON,
  };
}

/** A phrase for why an empty project is not (or is no longer) removable, before its root is looked at; null when it is. */
function emptyProjectBlocker(
  project: DoneJanitorProject,
  workspaces: readonly DoneJanitorWorkspace[],
  nowMs: number,
): string | null {
  if (project.archivedAt) return "it is archived";
  // A remote project's root is a checkout on some other machine's terms; never looked at.
  if (project.projectKey?.startsWith("remote:") || project.projectId.startsWith("remote:")) {
    return "it is a remote project";
  }
  // Archived workspaces count: they are history someone may still open.
  if (workspaces.some((workspace) => workspace.projectId === project.projectId)) {
    return "it gained a workspace";
  }
  // stat("") is ENOENT and a relative path resolves against the daemon's cwd: neither is a root.
  if (!isAbsolute(project.rootPath)) return "its root is not an absolute path";
  const newestMs = Math.max(parseMs(project.createdAt), parseMs(project.updatedAt));
  if (!(nowMs - newestMs >= EMPTY_PROJECT_MIN_AGE_MS)) return "it was touched in the last hour";
  return null;
}

function describeRootProbe(probe: ProjectRootProbe): string | null {
  switch (probe.kind) {
    case "missing":
      return null;
    case "exists":
      return "its directory exists";
    case "unknown":
      return `its directory could not be checked (${probe.error})`;
  }
}

/** Whether the project's root is gone. Only ENOENT says so; EACCES, ENOTDIR on a parent and the rest say nothing. */
export async function probeProjectRoot(rootPath: string): Promise<ProjectRootProbe> {
  try {
    await stat(rootPath);
    return { kind: "exists" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}

function describeDeadRoot(
  root: DoneJanitorAgentView,
  tree: readonly DoneJanitorAgentView[],
  nowMs: number,
): string {
  return [
    `dead: ${root.live ? "in error" : "closed"}, quiet for ${formatDuration(nowMs - (root.lastActivityAtMs ?? nowMs))}`,
    tree.length > 1 ? `with ${tree.length - 1} subagent(s) by cascade` : null,
    describeUnread(tree),
  ]
    .filter(Boolean)
    .join("; ");
}

function describeOffsite(offsite: WorktreeSnapshotOffsite): string {
  switch (offsite.kind) {
    case "pushed":
      return `pushed to ${offsite.remote} as ${offsite.branch}`;
    case "bundled":
      return `bundled at ${offsite.path}`;
    case "none":
      return `kept locally (${offsite.reason})`;
  }
}

function describeAgent(
  view: DoneJanitorAgentView,
): Pick<DoneJanitorReportEntry, "agentId" | "title" | "workspaceId"> {
  return { agentId: view.id, title: view.title, workspaceId: view.workspaceId };
}

function readOutcome(result: AskAgentResult): ProbeOutcome {
  switch (result.kind) {
    case "answered":
      // A tool call while answering is work, whatever the last word was.
      return !result.usedTools && isDoneAnswer(result.reply) ? "done" : "not-done";
    case "permission":
      return "permission";
    case "timeout":
      return "no-answer";
    case "failed":
      return "failed";
  }
}

function describeOutcome(result: AskAgentResult): string {
  switch (result.kind) {
    case "answered": {
      const quoted = JSON.stringify(result.reply.trim().slice(0, 80));
      return result.usedTools
        ? `used tools while answering, then said ${quoted}`
        : `answered ${quoted}`;
    }
    case "permission":
      return "asked for a permission instead of answering; turn cancelled";
    case "timeout":
      return "did not answer in time; turn cancelled";
    case "failed":
      return `could not be asked: ${result.error}`;
  }
}

/** Why a workspace record is not a Paseo-managed worktree this janitor may reclaim. */
function workspaceRecordProblem(workspace: DoneJanitorWorkspace | null): string | null {
  if (!workspace) return "the workspace record is missing";
  if (workspace.archivedAt) return "the workspace is already archived";
  if (workspace.kind !== "worktree") return `it is a ${workspace.kind}, not a worktree`;
  if (!workspace.isPaseoOwnedWorktree || !workspace.worktreeRoot || !workspace.mainRepoRoot) {
    return "it is not a Paseo-managed worktree";
  }
  return null;
}

/**
 * Anything else living in or around the directory: the primary checkout, another active
 * workspace (a local checkout above all), or an agent not being archived with it.
 */
function directoryConflict(
  workspace: DoneJanitorWorkspace,
  path: string,
  workspaces: readonly DoneJanitorWorkspace[],
  views: readonly DoneJanitorAgentView[],
  archivingIds: ReadonlySet<string>,
): string | null {
  if (workspace.mainRepoRoot && overlaps(path, workspace.mainRepoRoot)) {
    return "it overlaps the primary checkout";
  }
  for (const other of workspaces) {
    if (other.workspaceId === workspace.workspaceId || other.archivedAt) continue;
    if (overlaps(path, other.worktreeRoot ?? other.cwd)) {
      return `workspace ${other.workspaceId} (${other.kind}) uses the same directory`;
    }
  }
  for (const view of views) {
    if (view.archived || archivingIds.has(view.id)) continue;
    if (view.workspaceId === workspace.workspaceId) return `agent ${view.id} in it is not archived`;
    if (isRealpathInsideRoot(path, view.cwd)) return `agent ${view.id} runs inside it`;
  }
  return null;
}

function parseMs(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  // Unparseable reads as "just now", which only ever delays.
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function overlaps(a: string, b: string): boolean {
  return isRealpathInsideRoot(a, b) || isRealpathInsideRoot(b, a);
}

/**
 * One view per agent the daemon knows: the live summary where the agent is loaded, the stored
 * record otherwise. A stored record says nothing about a turn, permission or alert because a
 * closed agent cannot have one.
 */
export function buildAgentViews(
  live: readonly DoneJanitorAgentSummary[],
  stored: readonly StoredAgentRecord[],
  scheduledAgentIds: ReadonlySet<string>,
  pinnedWorkspaceIds: ReadonlySet<string>,
): DoneJanitorAgentView[] {
  const liveById = new Map(live.map((agent) => [agent.id, agent]));
  const views: DoneJanitorAgentView[] = [];
  const storedIds = new Set<string>();
  for (const record of stored) {
    storedIds.add(record.id);
    const agent = liveById.get(record.id);
    if (agent && !record.archivedAt) {
      views.push(fromLive(agent, record, scheduledAgentIds, pinnedWorkspaceIds));
      continue;
    }
    const activity = [record.updatedAt, record.lastActivityAt, record.lastUserMessageAt]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter((value) => Number.isFinite(value));
    views.push({
      id: record.id,
      title: record.title ?? null,
      provider: record.provider,
      workspaceId: record.workspaceId,
      cwd: record.cwd,
      internal: record.internal ?? false,
      archived: Boolean(record.archivedAt),
      // A closed record still saying `running` was cut off mid-turn. That is not done either.
      lifecycle: record.lastStatus,
      busy: false,
      pendingPermissionCount: 0,
      requiresAttention: record.requiresAttention === true,
      attentionReason: record.requiresAttention ? (record.attentionReason ?? null) : null,
      hasAlert: false,
      runningProviderSubagentCount: 0,
      lastActivityAtMs: activity.length > 0 ? Math.max(...activity) : null,
      labels: record.labels,
      hasSession: Boolean(record.persistence?.sessionId),
      hasSchedule: scheduledAgentIds.has(record.id),
      live: false,
      workspacePinned: pinnedWorkspaceIds.has(record.workspaceId ?? ""),
    });
  }
  for (const agent of live) {
    if (!storedIds.has(agent.id)) {
      views.push(fromLive(agent, null, scheduledAgentIds, pinnedWorkspaceIds));
    }
  }
  return views;
}

function fromLive(
  agent: DoneJanitorAgentSummary,
  record: StoredAgentRecord | null,
  scheduledAgentIds: ReadonlySet<string>,
  pinnedWorkspaceIds: ReadonlySet<string>,
): DoneJanitorAgentView {
  const lastActivityAtMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : Number.NaN;
  return {
    id: agent.id,
    title: record?.title ?? agent.title,
    provider: agent.provider,
    workspaceId: agent.workspaceId,
    cwd: agent.cwd,
    internal: agent.internal,
    archived: false,
    lifecycle: agent.lifecycle,
    busy: agent.busy,
    pendingPermissionCount: agent.pendingPermissionCount,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    hasAlert: agent.hasAlert,
    runningProviderSubagentCount: agent.runningProviderSubagentCount,
    lastActivityAtMs: Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : null,
    labels: agent.labels,
    hasSession: Boolean(agent.sessionId),
    hasSchedule: scheduledAgentIds.has(agent.id),
    live: agent.lifecycle !== "closed",
    workspacePinned: pinnedWorkspaceIds.has(agent.workspaceId ?? ""),
  };
}

// ─── Production wiring ───────────────────────────────────────────────────────────────────────

/**
 * An account is askable unless something says it is not: a provider that reports itself
 * unavailable, a usage window at or past its cap, a usage source in error (how a logged-out
 * account shows), or any agent on it whose last error reads like a spent budget. Asking an agent
 * on a dead account would fail its turn and flag it — noise the janitor would have made itself.
 */
export async function readProviderHealth(input: {
  provider: string;
  isAvailable: (provider: string) => Promise<boolean>;
  listUsage: () => Promise<readonly ProviderUsage[] | null>;
  lastErrorsByProvider: ReadonlyMap<string, readonly (string | undefined)[]>;
}): Promise<ProviderHealth> {
  if (!(await input.isAvailable(input.provider))) {
    return { askable: false, reason: `provider ${input.provider} is unavailable` };
  }
  const usage = (await input.listUsage())?.find((entry) => entry.providerId === input.provider);
  if (usage?.status === "error") {
    return {
      askable: false,
      reason: `account ${input.provider} reports a usage error${usage.error ? ` (${usage.error})` : ""}; it may be logged out`,
    };
  }
  if (
    usage?.windows.some((window) => typeof window.usedPct === "number" && window.usedPct >= 100)
  ) {
    return { askable: false, reason: `account ${input.provider} is at its usage cap` };
  }
  if ((input.lastErrorsByProvider.get(input.provider) ?? []).some(isLimitShapedError)) {
    return { askable: false, reason: `an agent on account ${input.provider} hit a usage limit` };
  }
  return { askable: true };
}

/**
 * The production `askAgent`: load the agent, mark the turn quiet so its answer raises no
 * `finished` flag or push, send the question in a `<paseo-system>` envelope (hidden from the
 * timeline like every system-injected prompt), and wait for the turn. A permission request or a
 * timeout cancels the turn it started, so the janitor never leaves an agent blocked on its
 * question.
 */
export async function askAgentWhetherDone(
  deps: { agentManager: AgentManager; agentStorage: AgentStorage; logger: Logger },
  input: { agentId: string; prompt: string; timeoutMs: number },
): Promise<AskAgentResult> {
  const { agentManager, agentStorage, logger } = deps;
  const { agentId } = input;
  try {
    await ensureAgentLoaded(agentId, { agentManager, agentStorage, logger });
    const cursor = agentManager.getTimelineCursor(agentId);
    if (cursor === null || !agentManager.markQuietTurn(agentId)) {
      return { kind: "failed", error: "the agent did not load" };
    }
    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId,
      prompt: formatSystemNotificationPrompt(input.prompt),
      messageId: randomUUID(),
      unarchive: false,
      logger,
    });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), input.timeoutMs);
    try {
      const result = await agentManager.waitForAgentEvent(agentId, {
        signal: abort.signal,
        waitForActive: true,
      });
      if (result.permission) {
        await agentManager.cancelAgentRun(agentId, "done-janitor").catch(() => undefined);
        return { kind: "permission" };
      }
      if (result.status === "error") {
        return {
          kind: "failed",
          error: agentManager.getAgent(agentId)?.lastError ?? "turn failed",
        };
      }
      // Read from the cursor, not the last assistant message: an agent that said nothing this
      // turn would otherwise be credited with whatever it said last time.
      const since = agentManager.readTimelineSince(agentId, cursor);
      return {
        kind: "answered",
        reply: since?.assistantText ?? "",
        usedTools: since?.itemTypes.includes("tool_call") ?? false,
      };
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      await agentManager.cancelAgentRun(agentId, "done-janitor").catch(() => undefined);
      return { kind: "timeout" };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
