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
import { isRunMarkerOpen } from "./agent/restart-recovery/run-marker.js";
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
import {
  checkDeletionInvariant,
  classifyWorkspace,
  idleProjectVerdict,
  resolveWorkspaceSweepConfig,
  type DoneJanitorWorkspaceSweepConfig,
  type IdleProjectVerdict,
  type ResolvedWorkspaceSweepConfig,
  type WorkspaceActivitySignals,
  type WorkspaceSweepRule,
  type WorkspaceSweepVerdict,
} from "./agent/workspace-sweep-detector.js";
import type { WorktreeCoverage, WorktreeDeletionSafety } from "./done-janitor-worktree.js";
import type { PushNotificationSender } from "./push/index.js";
import type {
  WorktreeSnapshotOffsite,
  WorktreeSnapshotRequest,
  WorktreeSnapshotResult,
} from "./remediation/contract.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "./workspace-registry.js";
import { isProtectivePin } from "./workspace-auto-pin.js";
import type { ProcessScan } from "./worktree-process-scan.js";
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
 * the archive budget. The cap is a blast-radius limit in case the rule is ever wrong at scale;
 * a larger backlog than 50 drains over the next sweeps, and 50 is twice the one that motivated it.
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
  /** The idle-workspace sweep (docs/done-janitor.md, "Idle workspaces"). On by default. */
  workspaceSweep?: DoneJanitorWorkspaceSweepConfig;
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
  | "pinSource"
>;

export type DoneJanitorProject = Pick<
  PersistedProjectRecord,
  "projectId" | "rootPath" | "projectKey" | "createdAt" | "updatedAt" | "archivedAt"
>;

/**
 * `missing` is ENOENT on the root with its volume present, and nothing else: an absent volume is
 * `volume-absent`, and any other failure to stat is `unknown`. Only `missing` removes a project.
 */
export type ProjectRootProbe =
  | { kind: "exists" }
  | { kind: "missing" }
  | { kind: "volume-absent"; volumeRoot: string }
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
  /** The `cwd` of every schedule that is not completed and starts a new agent. */
  listScheduledCwds(): Promise<readonly string[]>;
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
   * The directory archive-by-scope deletes with this workspace, resolved the way it resolves it
   * (`resolveArchiveDirectory`, workspace-archive-service.ts); null when it deletes none. For an
   * older record without the ownership flag that is the worktree root above its cwd, so the
   * idle-workspace sweep checks this directory and never the record's own.
   */
  resolveArchiveDirectory(workspace: DoneJanitorWorkspace): Promise<string | null>;
  /**
   * The idle-workspace sweep's archive when it deletes a directory: archive-by-scope again, so
   * its agents, terminals and record go with the directory `resolveArchiveDirectory` names.
   */
  archiveWorkspace(workspaceId: string): Promise<{ removedDirectory: boolean }>;
  /**
   * The idle-workspace sweep's record-only archive: archive-by-scope with the directory kept, so
   * a plan that deletes nothing cannot delete anything, whatever the record resolves to by then.
   */
  archiveWorkspaceRecord(workspaceId: string): Promise<void>;
  /** Scripts and services the workspace has running (workspace-script-runtime-store.ts). */
  countRunningScripts(workspaceId: string): Promise<number>;
  /** HEAD's commit time and the directory's own mtime; never the git index. */
  readActivitySignals(directory: string): Promise<WorkspaceActivitySignals>;
  /** Every file in the worktree read against `commit`, HEAD when null; null when git cannot. */
  readWorktreeCoverage(input: {
    worktreePath: string;
    commit: string | null;
  }): Promise<WorktreeCoverage | null>;
  /** Null when the snapshot is a backup a deletion may rely on; otherwise why it is not. */
  verifyBackup(input: {
    worktreePath: string;
    snapshot: SnapshottedWorktree;
  }): Promise<string | null>;
  /** Processes with their cwd, their executable or a file open inside the directory. */
  listProcessesInside(directory: string): Promise<ProcessScan>;
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

type SnapshottedWorktree = Extract<WorktreeSnapshotResult, { kind: "snapshotted" }>;

type WorkspacePlan =
  | {
      kind: "reclaim";
      workspace: DoneJanitorWorkspace;
      path: string;
      branch: string | null;
      /** The deletion invariant as read before the snapshot. */
      invariant: string;
    }
  | { kind: "keep"; workspace: DoneJanitorWorkspace | null; reason: string };

/**
 * What the idle-workspace sweep does with one idle workspace. `directory` is the one its archive
 * deletes, when it deletes one; a record-only archive goes through the archive that keeps it.
 */
type IdleWorkspacePlan =
  | { kind: "archive"; deletesDirectory: false; detail: string }
  | {
      kind: "archive";
      deletesDirectory: true;
      directory: string;
      detail: string;
      invariant: string;
    }
  | { kind: "keep"; reason: string };

/** Whether a worktree's directory may go: the deletion invariant's verdict, or why not. */
type DeletionCheck = { ok: true; invariant: string } | { ok: false; reason: string };

interface AskCandidate {
  root: DoneJanitorAgentView;
  plan: WorkspacePlan;
  quietForMs: number;
}

interface IdleWorkspaceCandidate {
  workspace: DoneJanitorWorkspace;
  verdict: Extract<WorkspaceSweepVerdict, { kind: "idle" }>;
}

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
    | "kept-project"
    | "would-archive-workspace"
    | "archived-workspace"
    | "kept-idle-workspace";
  agentId?: string;
  title?: string | null;
  workspaceId?: string;
  projectId?: string;
  path?: string;
  bytes?: number;
  reason: string;
  /** The idle-workspace rule that picked it. */
  rule?: WorkspaceSweepRule;
  /** How long it has been idle, apart from `reason` so the line is logged once, not hourly. */
  idleFor?: string;
  /** The deletion invariant's verdict, on every line that deletes or would delete a directory. */
  invariant?: string;
  /** Set when this line's pass ran dry while the sweep did not: the workspace sweep's own dryRun. */
  dryRun?: boolean;
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

    // Workspaces whose agents this sweep archives or asks, or in a dry run would: the idle sweep
    // leaves them to a later sweep, so a directory never goes in the run that archived its agents.
    const touchedWorkspaceIds = new Set<string>();
    // Dead agents first: they are archived without being asked, and they are not the ones the
    // question budget is for.
    const dead = config.archiveDead
      ? await this.sweepDeadAgents(report, views, workspaces, config, nowMs, touchedWorkspaceIds)
      : { archivedAgentCount: 0, deletedWorkspaceIds: new Set<string>() };
    if (dead.archivedAgentCount > 0) {
      views = await this.loadViews();
      workspaces = await this.deps.listWorkspaces();
    }

    const askable = await this.listAskable(report, views, workspaces, config, nowMs);
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
      // The question is activity whatever the answer; a DONE archives the tree.
      for (const view of [root, ...listDescendants(root.id, views)]) {
        if (view.workspaceId) touchedWorkspaceIds.add(view.workspaceId);
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

    // Every idle workspace the passes above left, whatever its kind; then projects left empty.
    const workspaceSweep = resolveWorkspaceSweepConfig(raw);
    if (workspaceSweep.enabled) {
      await this.sweepIdleWorkspaces(report, config, workspaceSweep, touchedWorkspaceIds);
    }

    await this.sweepEmptyProjects(report, config);
    if (workspaceSweep.enabled) await this.sweepIdleProjects(report, workspaceSweep);

    this.logReport(report);
    if (!config.dryRun) await this.notify(report, archivedCount, dead.archivedAgentCount);
    return report;
  }

  /**
   * The roots the question may go to, most disk per question first, then the longest quiet:
   * asking costs a turn. Every root it passes over is reported with the reason.
   */
  private async listAskable(
    report: DoneJanitorSweepReport,
    views: readonly DoneJanitorAgentView[],
    workspaces: readonly DoneJanitorWorkspace[],
    config: ResolvedDoneJanitorConfig,
    nowMs: number,
  ): Promise<AskCandidate[]> {
    const askable: AskCandidate[] = [];
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
    return askable.sort(
      (a, b) =>
        Number(b.plan.kind === "reclaim") - Number(a.plan.kind === "reclaim") ||
        b.quietForMs - a.quietForMs,
    );
  }

  /**
   * Archives workspace records nothing uses any more (docs/done-janitor.md, "Idle workspaces"):
   * the classifier in agent/workspace-sweep-detector.ts picks them, a Paseo-owned worktree's
   * directory goes only when its work is safe, and each archive is decided on fresh state.
   * A worktree an earlier pass already plans to delete this sweep is left to that pass, and a
   * workspace whose agents an earlier pass archived or asked this sweep waits for a later one.
   */
  private async sweepIdleWorkspaces(
    report: DoneJanitorSweepReport,
    config: ResolvedDoneJanitorConfig,
    sweep: ResolvedWorkspaceSweepConfig,
    touchedWorkspaceIds: ReadonlySet<string>,
  ): Promise<void> {
    try {
      const views = await this.loadViews();
      const [workspaces, projects] = await Promise.all([
        this.deps.listWorkspaces(),
        this.deps.listProjects(),
      ]);
      // A workspace of an archived project is not on the sidebar: not clutter, and not ours.
      const archivedProjectIds = new Set(
        projects.filter((project) => project.archivedAt).map((project) => project.projectId),
      );
      const planned = new Set(
        report.entries
          .filter((entry) => entry.action === "would-delete" || entry.action === "deleted")
          .map((entry) => entry.workspaceId),
      );
      const nowMs = this.now();
      const candidates: IdleWorkspaceCandidate[] = [];
      for (const workspace of workspaces) {
        if (workspace.archivedAt || archivedProjectIds.has(workspace.projectId)) continue;
        if (planned.has(workspace.workspaceId) || touchedWorkspaceIds.has(workspace.workspaceId)) {
          continue;
        }
        const verdict = await this.classifyForSweep(workspace, views, sweep, nowMs);
        if (verdict.kind === "idle") candidates.push({ workspace, verdict });
      }
      // Fixers first: they are the ones that pile up. Then the longest idle.
      candidates.sort(
        (a, b) =>
          Number(b.verdict.rule === "fixer") - Number(a.verdict.rule === "fixer") ||
          b.verdict.idleForMs - a.verdict.idleForMs,
      );
      let archived = 0;
      for (const candidate of candidates) {
        if (archived >= sweep.maxArchivesPerSweep) {
          report.entries.push(
            describeIdleWorkspace(
              candidate.workspace,
              "kept-idle-workspace",
              "idle, but this sweep's archive budget is spent; next sweep",
            ),
          );
          continue;
        }
        if (await this.archiveIdleWorkspace(report, candidate, views, workspaces, config, sweep)) {
          archived += 1;
        }
      }
    } catch (error) {
      this.options.logger.warn({ err: error }, "Done janitor: the idle-workspace pass failed");
    }
  }

  /** The classifier's verdict, reading the directory only when the record cannot decide. */
  private async classifyForSweep(
    workspace: DoneJanitorWorkspace,
    views: readonly DoneJanitorAgentView[],
    sweep: ResolvedWorkspaceSweepConfig,
    nowMs: number,
  ): Promise<WorkspaceSweepVerdict> {
    const facts = {
      workspace,
      agents: views.filter((view) => view.workspaceId === workspace.workspaceId),
      views,
      terminalCount: await this.deps.countTerminals(workspace.workspaceId),
      runningScriptCount: await this.deps.countRunningScripts(workspace.workspaceId),
    };
    const verdict = classifyWorkspace({ ...facts, signals: null }, sweep, nowMs);
    if (verdict.kind !== "needs-signals") return verdict;
    const signals = await this.deps.readActivitySignals(
      resolve(workspace.worktreeRoot ?? workspace.cwd),
    );
    return classifyWorkspace({ ...facts, signals }, sweep, nowMs);
  }

  /**
   * Archives one idle workspace, or reports why not. True when it spent the sweep's budget: any
   * attempt does, whatever the last checks then decide, so a dry run and a live run take the same
   * candidates and a live run never goes past what the dry run listed.
   *
   * Every check reads the directory archive-by-scope would delete (`resolveArchiveDirectory`),
   * and every line names it. A plan that deletes nothing archives through the archive that keeps
   * the directory.
   */
  private async archiveIdleWorkspace(
    report: DoneJanitorSweepReport,
    candidate: IdleWorkspaceCandidate,
    views: readonly DoneJanitorAgentView[],
    workspaces: readonly DoneJanitorWorkspace[],
    config: ResolvedDoneJanitorConfig,
    sweep: ResolvedWorkspaceSweepConfig,
  ): Promise<boolean> {
    const { workspace, verdict } = candidate;
    const directory = await this.deps.resolveArchiveDirectory(workspace);
    const describe = (action: DoneJanitorReportEntry["action"], reason: string) =>
      describeIdleWorkspace(workspace, action, reason, directory);
    const plan: IdleWorkspacePlan = directory
      ? await this.planIdleWorktree({ workspace, path: directory, views, workspaces, config })
      : { kind: "archive", deletesDirectory: false, detail: "record only, its directory stays" };
    if (plan.kind === "keep") {
      // The reason alone, no idle time: it would change the line, and re-log it, every hour.
      report.entries.push(describe("kept-idle-workspace", plan.reason));
      return false;
    }
    const reason = `${describeIdleRule(verdict, sweep)}; ${plan.detail}`;
    const facts = { rule: verdict.rule, idleFor: formatDuration(verdict.idleForMs) };
    if (sweep.dryRun) {
      const action = plan.deletesDirectory ? "would-delete" : "would-archive-workspace";
      report.entries.push({
        ...describe(action, reason),
        ...facts,
        ...(plan.deletesDirectory ? { invariant: plan.invariant } : {}),
        dryRun: true,
      });
      return true;
    }

    // A person may have opened it, or an agent started in it, since the sweep's read.
    const changed = await this.idleWorkspaceChange(workspace.workspaceId, sweep);
    if (changed.kind !== "idle") {
      if (changed.kind === "changed") {
        report.entries.push(
          describe("kept-idle-workspace", `it was idle, but then ${changed.reason}`),
        );
      }
      return true;
    }
    if (!plan.deletesDirectory) {
      return this.archiveIdleRecord(report, workspace, describe, { reason, facts });
    }
    // The record, read afresh, has to name the directory every check read.
    const now = await this.deps.resolveArchiveDirectory(changed.workspace);
    if (now !== plan.directory) {
      report.entries.push(
        describe(
          "kept-idle-workspace",
          `it was idle, but then the directory its archive deletes changed from ${plan.directory} to ${now ?? "none"}`,
        ),
      );
      return true;
    }
    // `du` first: the last check has to be the last thing before the archive.
    const bytes = await this.deps.measureBytes(plan.directory);
    const check = await this.confirmDeletion(
      report,
      plan.directory,
      `done janitor, before archiving idle workspace ${workspace.workspaceId}`,
    );
    if (!check.ok) {
      report.entries.push(describe("kept-idle-workspace", check.reason));
      return true;
    }
    let removedDirectory: boolean;
    try {
      ({ removedDirectory } = await this.deps.archiveWorkspace(workspace.workspaceId));
    } catch (error) {
      this.reportIdleArchiveFailure(report, workspace, describe, error);
      return true;
    }
    const done = { ...facts, invariant: check.invariant };
    report.entries.push(
      removedDirectory
        ? { ...describe("deleted", reason), ...done, bytes }
        : {
            ...describe(
              "archived-workspace",
              `${reason}; the record is archived, but the directory was not removed (see daemon log)`,
            ),
            ...done,
          },
    );
    this.options.logger.info(
      {
        workspaceId: workspace.workspaceId,
        path: plan.directory,
        rule: verdict.rule,
        idleFor: facts.idleFor,
        removedDirectory,
        invariant: check.invariant,
        reason,
      },
      "Done janitor: archived an idle workspace",
    );
    return true;
  }

  /** The record-only archive: through the archive that keeps the directory, so nothing is deleted. */
  private async archiveIdleRecord(
    report: DoneJanitorSweepReport,
    workspace: DoneJanitorWorkspace,
    describe: (action: DoneJanitorReportEntry["action"], reason: string) => DoneJanitorReportEntry,
    line: { reason: string; facts: Pick<DoneJanitorReportEntry, "rule" | "idleFor"> },
  ): Promise<boolean> {
    try {
      await this.deps.archiveWorkspaceRecord(workspace.workspaceId);
    } catch (error) {
      this.reportIdleArchiveFailure(report, workspace, describe, error);
      return true;
    }
    const entry = describe("archived-workspace", line.reason);
    report.entries.push({ ...entry, ...line.facts });
    this.options.logger.info(
      {
        workspaceId: workspace.workspaceId,
        path: entry.path,
        rule: line.facts.rule,
        idleFor: line.facts.idleFor,
        removedDirectory: false,
        reason: line.reason,
      },
      "Done janitor: archived an idle workspace",
    );
    return true;
  }

  private reportIdleArchiveFailure(
    report: DoneJanitorSweepReport,
    workspace: DoneJanitorWorkspace,
    describe: (action: DoneJanitorReportEntry["action"], reason: string) => DoneJanitorReportEntry,
    error: unknown,
  ): void {
    this.options.logger.warn(
      { err: error, workspaceId: workspace.workspaceId },
      "Done janitor: archiving an idle workspace failed",
    );
    report.entries.push(
      describe(
        "kept-idle-workspace",
        `archive failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /**
   * Whether a Paseo-owned worktree's directory may go with its record, decided on what can be
   * read without writing: the same in a dry run and a live one. A live run then confirms it right
   * before the archive (`confirmDeletion`). Clean and pushed, or dirty or unpushed work a snapshot
   * can hold, may go; the deletion invariant decides the rest.
   */
  private async planIdleWorktree(input: {
    workspace: DoneJanitorWorkspace;
    path: string;
    views: readonly DoneJanitorAgentView[];
    workspaces: readonly DoneJanitorWorkspace[];
    config: ResolvedDoneJanitorConfig;
  }): Promise<IdleWorkspacePlan> {
    const { workspace, path, views, workspaces, config } = input;
    const keep = (reason: string): IdleWorkspacePlan => ({ kind: "keep", reason });
    if (!config.reclaimWorkspaces) {
      return keep("workspace reclamation is off, and archiving it would delete its directory");
    }
    const inWorkspace = new Set(
      views.filter((view) => view.workspaceId === workspace.workspaceId).map((view) => view.id),
    );
    const conflict = directoryConflict(workspace, path, workspaces, views, inWorkspace);
    if (conflict) return keep(conflict);
    const failed = this.snapshotFailureAt(path);
    if (failed) return keep(failed);
    const safety = await this.deps.checkWorktree({
      worktreePath: path,
      baseBranch: workspace.baseBranch,
    });
    if (!safety.safe && safety.gone) {
      return { kind: "archive", deletesDirectory: false, detail: "its directory is gone" };
    }
    if (!safety.safe && !safety.atRisk) return keep(safety.reason);
    const preview = await this.previewDeletion(path);
    if (!preview.ok) return keep(preview.reason);
    return {
      kind: "archive",
      deletesDirectory: true,
      directory: path,
      detail: safety.safe ? describeCleanTree(safety.branch) : safety.reason,
      invariant: preview.invariant,
    };
  }

  /**
   * What keeps a worktree's directory and can be read without writing anything: a schedule that
   * starts agents in it, a process inside it, and the deletion invariant read against HEAD. Both
   * a dry run and a live run plan with it, so a dry run lists every deletion a live run could make.
   */
  private async previewDeletion(path: string): Promise<DeletionCheck> {
    const occupied = await this.occupiedReason(path);
    if (occupied) return { ok: false, reason: occupied };
    const coverage = await this.deps.readWorktreeCoverage({ worktreePath: path, commit: null });
    const invariant = checkDeletionInvariant(coverage, "plan");
    return invariant.holds
      ? { ok: true, invariant: invariant.detail }
      : { ok: false, reason: invariant.reason };
  }

  /**
   * The last step of a live deletion, after `du` and right before the archive: the read-only
   * checks again, then a snapshot, its backup verified, and the deletion invariant read against
   * the snapshot itself. A file written since the plan, or one the snapshot left out for any
   * reason — its size cap, its secret filter, a rule added later — is not in the snapshot, so it
   * keeps the worktree until a later sweep snapshots it again.
   */
  private async confirmDeletion(
    report: DoneJanitorSweepReport,
    path: string,
    reason: string,
  ): Promise<DeletionCheck> {
    const occupied = await this.occupiedReason(path);
    if (occupied) return { ok: false, reason: occupied };
    const snapshot = await this.takeSnapshot(report, path, reason);
    if (snapshot.kind === "failed") {
      return {
        ok: false,
        reason: `its work is at risk and could not be snapshotted: ${snapshot.error}`,
      };
    }
    if (snapshot.kind === "nothing-at-risk") {
      const coverage = await this.deps.readWorktreeCoverage({ worktreePath: path, commit: null });
      const invariant = checkDeletionInvariant(coverage, "head");
      return invariant.holds
        ? { ok: true, invariant: invariant.detail }
        : { ok: false, reason: invariant.reason };
    }
    const omitted = describeSnapshotOmissions(snapshot);
    if (omitted) return { ok: false, reason: omitted };
    const unverified = await this.deps.verifyBackup({ worktreePath: path, snapshot });
    if (unverified) return { ok: false, reason: `its backup is not verified: ${unverified}` };
    const coverage = await this.deps.readWorktreeCoverage({
      worktreePath: path,
      commit: snapshot.commit,
    });
    const invariant = checkDeletionInvariant(coverage, "snapshot");
    return invariant.holds
      ? {
          ok: true,
          invariant: `${invariant.detail}; backed up at ${snapshot.ref}, ${describeOffsite(snapshot.offsite)}`,
        }
      : { ok: false, reason: invariant.reason };
  }

  /**
   * Something that will use the directory again, or is using it now: a schedule that starts
   * agents in it, or any process with its cwd, its executable or a file open inside it. Null when
   * nothing is. A process scan that fails is a reason too.
   */
  private async occupiedReason(path: string): Promise<string | null> {
    const schedules = (await this.deps.listScheduledCwds()).filter((cwd) =>
      isRealpathInsideRoot(path, cwd),
    );
    if (schedules.length > 0) return `${schedules.length} schedule(s) start agents in it`;
    const scan = await this.deps.listProcessesInside(path);
    if (scan.kind === "failed") return `the processes inside it could not be listed: ${scan.error}`;
    const [first] = scan.processes;
    if (!first) return null;
    const others = scan.processes.length > 1 ? ` and ${scan.processes.length - 1} more` : "";
    return `a process runs inside it: ${first.command} (pid ${first.pid})${others}`;
  }

  /** The reason a failed snapshot at or around `path` this sweep keeps it; null when none did. */
  private snapshotFailureAt(path: string): string | null {
    for (const [failedPath, error] of this.snapshotFailures) {
      if (overlaps(path, failedPath)) {
        return `its work is at risk and could not be snapshotted: ${error}`;
      }
    }
    return null;
  }

  /**
   * Whether a workspace the sweep found idle still is, read afresh: `idle` with the fresh record,
   * `changed` with why not, or `archived` when someone archived it meanwhile.
   */
  private async idleWorkspaceChange(
    workspaceId: string,
    sweep: ResolvedWorkspaceSweepConfig,
  ): Promise<
    | { kind: "idle"; workspace: DoneJanitorWorkspace }
    | { kind: "changed"; reason: string }
    | { kind: "archived" }
  > {
    const views = await this.loadViews();
    const fresh = (await this.deps.listWorkspaces()).find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
    if (!fresh || fresh.archivedAt) return { kind: "archived" };
    const verdict = await this.classifyForSweep(fresh, views, sweep, this.now());
    return verdict.kind === "active"
      ? { kind: "changed", reason: verdict.reason }
      : { kind: "idle", workspace: fresh };
  }

  /**
   * Removes projects with no active workspace once their last one has been gone for
   * `projectGraceMs`. Record-only, like a person's project removal; runs after the older empty
   * project rule, and a project that rule already reported is its.
   */
  private async sweepIdleProjects(
    report: DoneJanitorSweepReport,
    sweep: ResolvedWorkspaceSweepConfig,
  ): Promise<void> {
    try {
      const reported = new Set(report.entries.map((entry) => entry.projectId));
      const [projects, workspaces] = await Promise.all([
        this.deps.listProjects(),
        this.deps.listWorkspaces(),
      ]);
      const nowMs = this.now();
      const candidates = projects
        .filter((project) => !reported.has(project.projectId))
        .flatMap((project) => {
          const verdict = idleProjectVerdict(project, workspaces, sweep, nowMs);
          return verdict.kind === "remove" ? [{ project, verdict }] : [];
        })
        .sort((a, b) => b.verdict.quietForMs - a.verdict.quietForMs);
      for (const [index, { project, verdict }] of candidates.entries()) {
        if (index >= sweep.maxProjectRemovalsPerSweep) {
          report.entries.push({
            action: "kept-project",
            reason: `${describeProjectBacklog(candidates.length - index)} for the next sweep`,
          });
          return;
        }
        if (sweep.dryRun) {
          report.entries.push({
            ...describeIdleProject(project, "would-remove-project", verdict),
            dryRun: true,
          });
          continue;
        }
        await this.removeIdleProject(report, project, sweep);
      }
    } catch (error) {
      this.options.logger.warn({ err: error }, "Done janitor: the idle-project pass failed");
    }
  }

  private async removeIdleProject(
    report: DoneJanitorSweepReport,
    candidate: DoneJanitorProject,
    sweep: ResolvedWorkspaceSweepConfig,
  ): Promise<void> {
    const fresh = (await this.deps.listProjects()).find(
      (project) => project.projectId === candidate.projectId,
    );
    if (!fresh) return;
    const verdict = idleProjectVerdict(fresh, await this.deps.listWorkspaces(), sweep, this.now());
    if (verdict.kind !== "remove") {
      report.entries.push({
        ...describeIdleProject(fresh, "kept-project", verdict),
        reason: `it had no active workspace, but then ${verdict.reason}`,
      });
      return;
    }
    try {
      await this.deps.removeProject(fresh.projectId);
    } catch (error) {
      this.options.logger.warn(
        { err: error, projectId: fresh.projectId },
        "Done janitor: removing an idle project failed",
      );
      report.entries.push({
        ...describeIdleProject(fresh, "kept-project", verdict),
        reason: `removal failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    report.removedProjectCount += 1;
    report.entries.push(describeIdleProject(fresh, "removed-project", verdict));
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
      const candidates = await this.listEmptyProjectCandidates(report);
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

  private async listEmptyProjectCandidates(
    report: DoneJanitorSweepReport,
  ): Promise<DoneJanitorProject[]> {
    const [projects, workspaces] = await Promise.all([
      this.deps.listProjects(),
      this.deps.listWorkspaces(),
    ]);
    const candidates: DoneJanitorProject[] = [];
    for (const project of projects) {
      if (emptyProjectBlocker(project, workspaces, this.now())) continue;
      const probe = await this.deps.probeProjectRoot(project.rootPath);
      if (probe.kind === "missing") {
        candidates.push(project);
      } else if (probe.kind === "volume-absent") {
        // Empty and looks gone, but the volume it sits on is not there: worth saying, never removing.
        report.entries.push({
          ...describeEmptyProject(project, "kept-project"),
          reason: describeAbsentVolume(probe.volumeRoot),
        });
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
    touchedWorkspaceIds: Set<string>,
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
      for (const view of tree) {
        if (view.workspaceId) touchedWorkspaceIds.add(view.workspaceId);
      }
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
      } else {
        // Spent on the attempt, as in a dry run, so a live sweep never deletes past its dry run.
        if (plan.kind === "reclaim") deletions += 1;
        if (config.dryRun) report.entries.push(this.describePlan(plan, true, why));
        else if (await this.reclaim(report, plan, why)) deletedWorkspaceIds.add(workspaceId);
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
    candidate: AskCandidate,
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
        ...agents.map((view) => view.archivedAtMs ?? Number.NEGATIVE_INFINITY),
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
    if (workspace && isProtectivePin(workspace)) return keep("its workspace is pinned");
    const recordProblem = workspaceRecordProblem(workspace);
    if (recordProblem || !workspace?.worktreeRoot) {
      return keep(recordProblem ?? "the workspace record is missing");
    }
    const path = resolve(workspace.worktreeRoot);
    if (!(await this.deps.isPaseoOwnedWorktreePath(path))) {
      return keep("its directory is outside the Paseo worktrees root");
    }
    const failed = this.snapshotFailureAt(path);
    if (failed) return keep(failed);
    const conflict = directoryConflict(workspace, path, workspaces, views, archivingIds);
    if (conflict) return keep(conflict);
    const terminals = await this.deps.countTerminals(workspaceId);
    if (terminals > 0) return keep(`it has ${terminals} open terminal(s)`);
    const safety = await this.deps.checkWorktree({
      worktreePath: path,
      baseBranch: workspace.baseBranch,
    });
    if (!safety.safe) return keep(safety.reason);
    const preview = await this.previewDeletion(path);
    if (!preview.ok) return keep(preview.reason);
    return {
      kind: "reclaim",
      workspace,
      path,
      branch: safety.branch,
      invariant: preview.invariant,
    };
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
    return {
      action: dryRun ? "would-delete" : "deleted",
      workspaceId: plan.workspace.workspaceId,
      path: plan.path,
      reason: `${why ? `${why}; ` : ""}${describeCleanTree(plan.branch)}`,
      invariant: plan.invariant,
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
    // `du` first: the last check has to be the last thing before the archive. The git gate
    // passed, but it counts a commit on the local base branch as safe; the snapshot keeps a copy.
    const bytes = await this.deps.measureBytes(plan.path);
    const check = await this.confirmDeletion(
      report,
      plan.path,
      `done janitor, before deleting workspace ${plan.workspace.workspaceId}`,
    );
    if (!check.ok) {
      report.entries.push({
        action: "kept-workspace",
        workspaceId: plan.workspace.workspaceId,
        path: plan.path,
        reason: check.reason,
      });
      return false;
    }
    try {
      const result = await this.deps.reclaimWorkspace(plan.workspace.workspaceId);
      const entry = {
        ...this.describePlan(plan, false, why),
        invariant: check.invariant,
        bytes,
      };
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
          invariant: check.invariant,
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
    const result = await this.takeSnapshot(report, cwd, reason);
    return result.kind === "failed" && result.worktreePath ? result.error : null;
  }

  /** The snapshot itself, reported, with a failure on work at risk remembered for the sweep. */
  private async takeSnapshot(
    report: DoneJanitorSweepReport,
    cwd: string,
    reason: string,
  ): Promise<WorktreeSnapshotResult> {
    const result = await this.deps.snapshotWorktree({ cwd, reason });
    if (result.kind === "snapshotted") {
      report.entries.push({
        action: "snapshotted",
        path: result.worktreePath,
        reason: `${result.ref}; ${describeOffsite(result.offsite)}`,
      });
    } else if (result.kind === "failed" && result.worktreePath) {
      this.snapshotFailures.set(result.worktreePath, result.error);
      this.options.logger.warn(
        { path: result.worktreePath, error: result.error },
        "Done janitor: snapshot of work at risk failed; its worktree is kept",
      );
    }
    return result;
  }

  private async loadViews(): Promise<DoneJanitorAgentView[]> {
    const [stored, scheduled, workspaces] = await Promise.all([
      this.deps.listStoredAgents(),
      this.deps.listScheduledAgentIds(),
      this.deps.listWorkspaces(),
    ]);
    const pinnedWorkspaceIds = new Set(
      workspaces.filter(isProtectivePin).map((workspace) => workspace.workspaceId),
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
      const line = `${entry.action}:${entry.reason}:${entry.invariant ?? ""}`;
      if (this.lastLogged.get(key) === line) continue;
      this.lastLogged.set(key, line);
      if (entry.action === "not-done") continue;
      const dryRun = entry.dryRun ?? report.dryRun;
      this.options.logger.info(
        { ...entry, dryRun },
        dryRun ? "Done janitor (dry run)" : "Done janitor",
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
    const archivedWorkspaceCount = report.entries.filter(
      (entry) => entry.action === "archived-workspace",
    ).length;
    if (
      archivedAgentCount === 0 &&
      archivedDeadAgentCount === 0 &&
      deleted.length === 0 &&
      archivedWorkspaceCount === 0 &&
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
          archivedWorkspaceCount,
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

/** One line for an idle workspace; `directory`, when its archive deletes one, is the path. */
function describeIdleWorkspace(
  workspace: DoneJanitorWorkspace,
  action: DoneJanitorReportEntry["action"],
  reason: string,
  directory: string | null = null,
): DoneJanitorReportEntry {
  return {
    action,
    workspaceId: workspace.workspaceId,
    title: workspace.title ?? workspace.displayName,
    path: directory ?? workspace.worktreeRoot ?? workspace.cwd,
    reason,
  };
}

/** The rule that made a workspace idle, without its idle time: that is `idleFor`. */
function describeIdleRule(
  verdict: Extract<WorkspaceSweepVerdict, { kind: "idle" }>,
  sweep: ResolvedWorkspaceSweepConfig,
): string {
  switch (verdict.rule) {
    case "fixer":
      return verdict.reason;
    case "idle":
      return `idle past ${formatDuration(sweep.idleMs)}`;
    case "empty":
      return `no agents and no git checkout, idle past ${formatDuration(sweep.emptyIdleMs)}`;
  }
}

function describeCleanTree(branch: string | null): string {
  return `clean tree and ${branch ? `branch ${branch} is merged or pushed` : "HEAD is merged or pushed"}`;
}

/**
 * The untracked files a snapshot reports it left out: over its size cap, or, once the snapshot
 * reports them, possible secrets. Null when it reports none. The coverage read after it would
 * find them too; this names why.
 */
function describeSnapshotOmissions(snapshot: SnapshottedWorktree): string | null {
  const secrets = snapshot.possibleSecrets ?? [];
  const parts = [
    snapshot.skippedFiles.length > 0
      ? `${snapshot.skippedFiles.length} over its size cap (${listSome(snapshot.skippedFiles)})`
      : null,
    secrets.length > 0 ? `${secrets.length} possible secret(s) (${listSome(secrets)})` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `the snapshot left out untracked files: ${parts.join(", ")}` : null;
}

function listSome(items: readonly string[]): string {
  const shown = items.slice(0, 3).join(", ");
  return items.length > 3 ? `${shown}, …` : shown;
}

function describeIdleProject(
  project: DoneJanitorProject,
  action: "would-remove-project" | "removed-project" | "kept-project",
  verdict: IdleProjectVerdict,
): DoneJanitorReportEntry {
  return { action, projectId: project.projectId, path: project.rootPath, reason: verdict.reason };
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
    case "volume-absent":
      return `its volume ${probe.volumeRoot} is not mounted`;
    case "unknown":
      return `its directory could not be checked (${probe.error})`;
  }
}

function describeAbsentVolume(volumeRoot: string): string {
  return `its volume ${volumeRoot} is not mounted, so its directory may still exist on it`;
}

/**
 * The mount point a path sits under, decided from the path alone: `/Volumes/<name>` on macOS,
 * `/media/<user>/<name>` and `/mnt/<name>` on Linux, a drive root on Windows. Null for anything
 * else, which is the system volume. No mount table: the caller stats the answer once.
 */
export function volumeRootOf(rootPath: string): string | null {
  const drive = /^([A-Za-z]:)[\\/]/u.exec(rootPath);
  if (drive) return `${drive[1]}\\`;
  const segments = rootPath.split("/");
  if (segments[0] !== "") return null;
  const [, top, first, second] = segments;
  if (top === "Volumes" && first) return `/Volumes/${first}`;
  if (top === "mnt" && first) return `/mnt/${first}`;
  if (top === "media" && first && second) return `/media/${first}/${second}`;
  return null;
}

/**
 * Whether the project's root is gone. Only ENOENT says so, and only with its volume present:
 * a root under an unmounted volume is `volume-absent`. EACCES, ENOTDIR on a parent and the rest
 * say nothing. `volumeRootOf` is a seam for tests.
 */
export async function probeProjectRoot(
  rootPath: string,
  options: { volumeRootOf?: (rootPath: string) => string | null } = {},
): Promise<ProjectRootProbe> {
  const rootError = await statError(rootPath);
  if (rootError === null) return { kind: "exists" };
  if (rootError.code !== "ENOENT") return { kind: "unknown", error: rootError.message };
  const volumeRoot = (options.volumeRootOf ?? volumeRootOf)(rootPath);
  if (volumeRoot === null) return { kind: "missing" };
  const volumeError = await statError(volumeRoot);
  if (volumeError === null) return { kind: "missing" };
  if (volumeError.code === "ENOENT") return { kind: "volume-absent", volumeRoot };
  return { kind: "unknown", error: volumeError.message };
}

async function statError(path: string): Promise<{ code?: string; message: string } | null> {
  try {
    await stat(path);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { code, message: error instanceof Error ? error.message : String(error) };
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
 * Anything else living in the directory: the primary checkout, another active workspace at or
 * inside it (a local checkout above all), or an agent not being archived with it. A workspace in
 * a directory above it does not count: deleting the worktree leaves that directory as it was, and
 * a self-heal fixer's workspace in the home directory would otherwise keep every worktree.
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
    if (isRealpathInsideRoot(path, other.worktreeRoot ?? other.cwd)) {
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
      archivedAtMs: record.archivedAt ? parseMs(record.archivedAt) : null,
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
      interruptedMidTurn: isRunMarkerOpen(record.runMarker),
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
    interruptedMidTurn: isRunMarkerOpen(record?.runMarker),
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
