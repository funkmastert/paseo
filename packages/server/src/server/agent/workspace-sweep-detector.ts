/**
 * Selection logic for the done janitor's idle-workspace sweep: which workspace records are idle
 * enough to archive, which rule made them so, and whether a Paseo-owned worktree's work is backed
 * up well enough for its directory to go. Pure — no I/O, no clock reads; AgentDoneJanitor reads
 * the facts and passes `nowMs` in. See docs/done-janitor.md, "Idle workspaces".
 *
 * Every doubt keeps the workspace: a pin, an agent at work, an unreadable timestamp, no activity
 * signal at all, a file that is neither pushed, backed up nor regenerable.
 */

import type { DoneJanitorProject, DoneJanitorWorkspace } from "../agent-done-janitor.js";
import type { WorktreeCoverage } from "../done-janitor-worktree.js";
import { isProtectivePin } from "../workspace-auto-pin.js";
import {
  DONE_JANITOR_KEEP_LABEL,
  formatDuration,
  listDescendants,
  parentOf,
  type DoneJanitorAgentView,
} from "./done-janitor-detector.js";

const HOUR_MS = 60 * 60_000;

/** The label the remediation ladder puts on every agent it starts (remediation/ladder.ts). */
export const REMEDIATION_LABEL = "paseo.remediation";

/**
 * How long a self-heal fixer must have been quiet before its workspace goes. The ladder polls its
 * agents every minute and reads the report from the finished agent; archiving first would read to
 * it as "archived before it reported" and send a person a false failure.
 */
export const FIXER_SETTLE_MS = 10 * 60_000;

/**
 * The regenerable allowlist, part (c) of the deletion invariant: directories a build, an install
 * or a test run recreates. An ignored path counts only when a directory on its way is one of
 * these, at the worktree root or beside a build manifest (`isBuildManifest`). Anything else
 * ignored — `.env`, `.xcode.env.local`, `google-services.json`, evidence logs, `.data/`,
 * `results/`, a `src/build/` beside source — may exist nowhere else and keeps the worktree. Keep
 * it short: a name added here is a name whose contents the janitor may delete unread.
 */
const REGENERABLE_DIRS: ReadonlySet<string> = new Set([
  // JavaScript and TypeScript
  "node_modules",
  "dist",
  "build",
  "out-tsc",
  "tsc-out",
  ".expo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "coverage",
  "test-results",
  // JVM, Android, Rust
  "target",
  ".gradle",
  ".cxx",
  ".kotlin",
  // Apple
  "DerivedData",
  "Pods",
  ".build",
  ".swiftpm",
  // Python
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  // Dart, Godot
  ".dart_tool",
  ".godot",
]);
/** A directory regenerable only inside its parent: the rest of `.yarn` may be configuration. */
const REGENERABLE_NESTED_DIRS: ReadonlySet<string> = new Set([".yarn/cache"]);
const REGENERABLE_FILES: ReadonlySet<string> = new Set([".DS_Store", ".yarn/install-state.gz"]);
const REGENERABLE_EXTENSIONS = [".pyc", ".pyo", ".tsbuildinfo"] as const;
/**
 * Files that make their directory a build's: a tool writes its output beside its manifest. An
 * Xcode project is a directory, matched by its extension.
 */
const BUILD_MANIFESTS: ReadonlySet<string> = new Set([
  "package.json",
  "Cargo.toml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "Package.swift",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "pom.xml",
]);

/** `agents.doneJanitor.workspaceSweep`. Every key is optional; the resolver owns the defaults. */
export interface DoneJanitorWorkspaceSweepConfig {
  enabled?: boolean;
  dryRun?: boolean;
  idleHours?: number;
  emptyIdleHours?: number;
  maxArchivesPerSweep?: number;
  projectGraceHours?: number;
  maxProjectRemovalsPerSweep?: number;
  keptCooldownHours?: number;
}

export interface ResolvedWorkspaceSweepConfig {
  enabled: boolean;
  /**
   * On unless `workspaceSweep.dryRun` is `false`: the sweep's first run on a machine reports and
   * waits for a person to approve it (docs/done-janitor.md, "Approving the first live run"). The
   * janitor's own `dryRun` makes the sweep dry too.
   */
  dryRun: boolean;
  /** Anything with agents, or in a git checkout. */
  idleMs: number;
  /** No unarchived agent and no git checkout: nothing in it to lose. */
  emptyIdleMs: number;
  maxArchivesPerSweep: number;
  /** How long a project stays after its last active workspace goes. */
  projectGraceMs: number;
  maxProjectRemovalsPerSweep: number;
  /** How long a workspace kept for a reason that will not change within the hour (R5) waits
   * before the sweep spends budget checking it again. */
  keptCooldownMs: number;
}

export function resolveWorkspaceSweepConfig(janitor: {
  dryRun?: boolean;
  workspaceSweep?: DoneJanitorWorkspaceSweepConfig;
}): ResolvedWorkspaceSweepConfig {
  const sweep = janitor.workspaceSweep;
  return {
    enabled: sweep?.enabled ?? true,
    dryRun: (janitor.dryRun ?? false) || (sweep?.dryRun ?? true),
    idleMs: (sweep?.idleHours ?? 72) * HOUR_MS,
    emptyIdleMs: (sweep?.emptyIdleHours ?? 24) * HOUR_MS,
    maxArchivesPerSweep: sweep?.maxArchivesPerSweep ?? 10,
    projectGraceMs: (sweep?.projectGraceHours ?? 24) * HOUR_MS,
    maxProjectRemovalsPerSweep: sweep?.maxProjectRemovalsPerSweep ?? 10,
    keptCooldownMs: (sweep?.keptCooldownHours ?? 6) * HOUR_MS,
  };
}

/** Activity read from the workspace's directory. The git index is never one of them. */
export interface WorkspaceActivitySignals {
  /** HEAD's committer time; null when the directory is not in a git checkout. */
  headCommitMs: number | null;
  /** The directory's own mtime; null when it does not exist. */
  directoryMtimeMs: number | null;
}

export interface WorkspaceSweepFacts {
  workspace: DoneJanitorWorkspace;
  /** Every agent whose workspace this is, archived or not. */
  agents: readonly DoneJanitorAgentView[];
  /** Every agent the daemon knows, for the subagents of the ones in this workspace. */
  views: readonly DoneJanitorAgentView[];
  terminalCount: number;
  runningScriptCount: number;
  /** Null until read: the sweep reads the directory only for a workspace the rest cannot decide. */
  signals: WorkspaceActivitySignals | null;
}

export type WorkspaceSweepRule = "fixer" | "idle" | "empty";

export type WorkspaceSweepVerdict =
  | { kind: "active"; reason: string }
  | { kind: "needs-signals" }
  | { kind: "idle"; rule: WorkspaceSweepRule; idleForMs: number; reason: string };

/**
 * Whether a workspace record is idle enough to archive, and by which rule:
 * - `fixer`: every agent it ever held was started by the remediation ladder and none is at work.
 *   It goes once they settle, whatever its directory does: a fixer's directory is the home
 *   directory, whose mtime moves all day.
 * - `idle`: it has an unarchived agent or is a git checkout, and nothing moved for `idleMs`.
 *   An archived agent's last activity and its archive time both count as movement.
 * - `empty`: neither, and nothing moved for `emptyIdleMs`.
 */
export function classifyWorkspace(
  facts: WorkspaceSweepFacts,
  config: Pick<ResolvedWorkspaceSweepConfig, "idleMs" | "emptyIdleMs">,
  nowMs: number,
): WorkspaceSweepVerdict {
  const busy = workspaceBusyReason(facts, { idleMs: config.idleMs, nowMs });
  if (busy) return { kind: "active", reason: busy };

  const unarchived = facts.agents.filter((agent) => !agent.archived);
  const unreadable = unarchived.find((agent) => agent.lastActivityAtMs === null);
  if (unreadable) {
    return {
      kind: "active",
      reason: `agent ${unreadable.id} has no readable last-activity time`,
    };
  }
  if (isFixerWorkspace(facts.agents)) return classifyFixer(facts.agents, unarchived, nowMs);

  // Every agent it ever held, archived ones included, and the moment each was archived: an
  // archive is the last thing that happened to the workspace, not proof that it is abandoned.
  const recordActivity = [
    parseStamp(facts.workspace.createdAt),
    parseStamp(facts.workspace.updatedAt),
    ...facts.agents.flatMap((agent) => [agent.lastActivityAtMs, agent.archivedAtMs ?? null]),
  ];
  const { signals } = facts;
  if (signals === null) {
    // The directory can only make the workspace newer. Read it only when the record alone does
    // not already keep the workspace under the shorter of the two thresholds.
    const newest = newestOf(recordActivity);
    const threshold = unarchived.length > 0 ? config.idleMs : config.emptyIdleMs;
    if (newest !== null && nowMs - newest < threshold) {
      return { kind: "active", reason: describeRecent(nowMs - newest, threshold) };
    }
    return { kind: "needs-signals" };
  }

  const newest = newestOf([...recordActivity, signals.headCommitMs, signals.directoryMtimeMs]);
  if (newest === null) return { kind: "active", reason: "it has no usable activity signal" };
  const gitCheckout = facts.workspace.kind !== "directory" || signals.headCommitMs !== null;
  const rule: WorkspaceSweepRule = unarchived.length > 0 || gitCheckout ? "idle" : "empty";
  const threshold = rule === "idle" ? config.idleMs : config.emptyIdleMs;
  const idleForMs = nowMs - newest;
  if (idleForMs < threshold) {
    return { kind: "active", reason: describeRecent(idleForMs, threshold) };
  }
  const reason =
    rule === "idle"
      ? `idle for ${formatDuration(idleForMs)}`
      : `no agents and no git checkout, idle for ${formatDuration(idleForMs)}`;
  return { kind: "idle", rule, idleForMs, reason };
}

function classifyFixer(
  agents: readonly DoneJanitorAgentView[],
  unarchived: readonly DoneJanitorAgentView[],
  nowMs: number,
): WorkspaceSweepVerdict {
  const newestUnarchived = newestOf(unarchived.map((agent) => agent.lastActivityAtMs));
  if (newestUnarchived !== null && nowMs - newestUnarchived < FIXER_SETTLE_MS) {
    return {
      kind: "active",
      reason: `its self-heal fixer stopped ${formatDuration(nowMs - newestUnarchived)} ago; it settles for ${formatDuration(FIXER_SETTLE_MS)} so the ladder reads its report first`,
    };
  }
  const newest = newestOf(agents.map((agent) => agent.lastActivityAtMs));
  return {
    kind: "idle",
    rule: "fixer",
    idleForMs: newest === null ? 0 : Math.max(0, nowMs - newest),
    reason: "a self-heal fixer's workspace, and every fixer in it is finished",
  };
}

/** Every agent it ever held was started by the remediation ladder. */
function isFixerWorkspace(agents: readonly DoneJanitorAgentView[]): boolean {
  return (
    agents.length > 0 &&
    agents.every((agent) => Object.prototype.hasOwnProperty.call(agent.labels, REMEDIATION_LABEL))
  );
}

/**
 * What keeps the workspace whatever its age: a manual pin, an agent at work or about to be woken,
 * an orchestrator whose fleet is still loaded, a subagent whose leader is still at it elsewhere, a
 * terminal, a script. Null when nothing does. A schedule that starts agents in a worktree keeps
 * its directory, not its record: the janitor checks that before a deletion.
 */
export function workspaceBusyReason(
  facts: Pick<
    WorkspaceSweepFacts,
    "workspace" | "agents" | "views" | "terminalCount" | "runningScriptCount"
  >,
  context: { idleMs: number; nowMs: number },
): string | null {
  // An auto pin only sorts the workspace to the top while it is in use (workspace-auto-pin.ts).
  if (isProtectivePin(facts.workspace)) return "it is pinned";
  const unarchived = facts.agents.filter((agent) => !agent.archived);
  for (const agent of unarchived) {
    if (Object.prototype.hasOwnProperty.call(agent.labels, DONE_JANITOR_KEEP_LABEL)) {
      return `agent ${agent.id} is pinned with ${DONE_JANITOR_KEEP_LABEL}`;
    }
    const working = agentWorkingReason(agent);
    if (working) return `agent ${agent.id} ${working}`;
    if (agent.hasSchedule) return `agent ${agent.id} has a schedule or heartbeat that will wake it`;
  }
  for (const agent of unarchived) {
    // Archiving the workspace archives the leader, and its subagents with it or out from under it.
    const live = listDescendants(agent.id, facts.views).find(
      (descendant) => descendant.live || agentWorkingReason(descendant) !== null,
    );
    if (live) return `agent ${agent.id} leads subagent ${live.id}, which is live`;
    const leader = activeLeaderElsewhere(agent, facts.views, context);
    if (leader) return `agent ${agent.id} is a subagent of ${leader.id}, which is still active`;
  }
  if (facts.terminalCount > 0) return `it has ${facts.terminalCount} open terminal(s)`;
  if (facts.runningScriptCount > 0) {
    return `it has ${facts.runningScriptCount} running script(s)`;
  }
  return null;
}

/**
 * The nearest unarchived ancestor in another workspace that is live, at work, or active within
 * `idleMs`; null when none is. A leader in the same workspace already dates it. A multi-day
 * orchestration leaves a worker idle for days while its leader works elsewhere and may send it
 * more; archiving the worker's workspace would delete the directory it would be sent back to.
 */
function activeLeaderElsewhere(
  agent: DoneJanitorAgentView,
  views: readonly DoneJanitorAgentView[],
  context: { idleMs: number; nowMs: number },
): DoneJanitorAgentView | null {
  const byId = new Map(views.map((view) => [view.id, view]));
  const seen = new Set<string>([agent.id]);
  let parentId = parentOf(agent);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return null;
    const active =
      parent.live ||
      agentWorkingReason(parent) !== null ||
      parent.lastActivityAtMs === null ||
      context.nowMs - parent.lastActivityAtMs < context.idleMs;
    if (!parent.archived && parent.workspaceId !== agent.workspaceId && active) return parent;
    parentId = parentOf(parent);
  }
  return null;
}

function agentWorkingReason(agent: DoneJanitorAgentView): string | null {
  if (agent.lifecycle === "running" || agent.lifecycle === "initializing") {
    return `is ${agent.lifecycle}`;
  }
  if (agent.busy) return "has a turn in flight";
  if (agent.pendingPermissionCount > 0) return "is waiting on a permission";
  if (agent.runningProviderSubagentCount > 0) {
    return `has ${agent.runningProviderSubagentCount} provider subagent(s) still running`;
  }
  if (agent.interruptedMidTurn) return "was cut off mid-turn by a daemon stop";
  return null;
}

/** Which commit the coverage was read against, and so what it must show. */
export type CoverageBasis =
  /** Before any snapshot, against HEAD: whatever differs is what the snapshot must hold. */
  | "plan"
  /** Against HEAD, with no snapshot taken: nothing may differ, and HEAD must be on a remote. */
  | "head"
  /** Against a snapshot whose backup the caller verified: nothing may differ from it. */
  | "snapshot";

/**
 * `category` marks the one failure the sweep's cooldown treats as permanent within the hour
 * (R5, docs/done-janitor.md): an ignored, non-regenerable path a backup cannot cover either. Every
 * other failure — an unreadable directory, a hidden change, an LFS file, a nested repository, an
 * unpushed commit — is left uncategorized; it may clear on its own (a push, a rebase) sooner than
 * the cooldown would allow re-checking.
 */
export type DeletionInvariant =
  | { holds: true; detail: string }
  | { holds: false; reason: string; category?: "ignored-path" };

/**
 * The deletion invariant (docs/done-janitor.md): a worktree's directory goes only when every file
 * in it is (a) tracked and pushed, (b) in a verified backup, or (c) under a regenerable directory.
 * Anything else present keeps it, and so does anything that stops the listing being the whole
 * truth: a directory the delete could not read or empty, a change git is told not to look for,
 * a file whose contents Git LFS keeps outside git. The caller verifies the backup; this judges
 * the files.
 */
export function checkDeletionInvariant(
  coverage: WorktreeCoverage | null,
  basis: CoverageBasis,
): DeletionInvariant {
  if (coverage === null) return { holds: false, reason: "git could not list its files" };
  const unlisted = describeUnlisted(coverage);
  if (unlisted) return { holds: false, reason: unlisted };
  const manifestDirectories = new Set(coverage.manifestDirectories);
  const kept = coverage.ignored.filter((entry) => !isRegenerablePath(entry, manifestDirectories));
  if (kept.length > 0) {
    return {
      holds: false,
      reason: `${kept.length} ignored path(s) that are not regenerable and no backup holds (${listSome(kept)})`,
      category: "ignored-path",
    };
  }
  const nested = listNestedRepositories(coverage);
  if (nested.length > 0) {
    return {
      holds: false,
      reason: `${nested.length} submodule(s) or nested repositor(ies) a backup holds only as a pointer (${listSome(nested)})`,
    };
  }
  const regenerable = describeRegenerable(coverage.ignored);
  const differs = [...coverage.changed, ...coverage.untracked];
  if (basis === "plan") {
    const owed = [
      differs.length > 0 ? `${differs.length} changed or untracked file(s)` : null,
      coverage.unbackedCommits > 0 ? `${coverage.unbackedCommits} unpushed commit(s)` : null,
    ].filter((part): part is string => part !== null);
    return {
      holds: true,
      detail:
        owed.length > 0
          ? `holds once a verified snapshot backs up ${owed.join(" and ")}${regenerable}`
          : `holds: every file is tracked and pushed${regenerable}`,
    };
  }
  const against = basis === "snapshot" ? "the snapshot" : "pushed HEAD";
  if (differs.length > 0) {
    return {
      holds: false,
      reason: `${differs.length} file(s) not in ${against}, changed since or left out (${listSome(differs)})`,
    };
  }
  if (coverage.unbackedCommits > 0) {
    return {
      holds: false,
      reason: `${coverage.unbackedCommits} commit(s) reachable from HEAD are neither pushed nor in ${against}`,
    };
  }
  return {
    holds: true,
    detail:
      basis === "snapshot"
        ? `holds: every file is in the verified snapshot${regenerable}`
        : `holds: every file is tracked and pushed${regenerable}`,
  };
}

/**
 * Why git's listing of the worktree is not the whole of what a deletion loses; null when it is.
 * A snapshot cannot help with any of these, so they keep the worktree whatever the basis.
 */
function describeUnlisted(coverage: WorktreeCoverage): string | null {
  if (coverage.unreadable.length > 0) {
    // Git skips a directory it cannot open, and a delete that meets one stops part-way.
    return `${coverage.unreadable.length} director(ies) it cannot read or empty, so a delete would stop part-way (${listSome(coverage.unreadable)})`;
  }
  if (coverage.hidden.length > 0) {
    // git status, git diff and the snapshot all read such a file as unchanged.
    return `${coverage.hidden.length} tracked file(s) git is told not to check, with --assume-unchanged or --skip-worktree (${listSome(coverage.hidden)})`;
  }
  if (coverage.lfs.length > 0) {
    // Git and the backup hold a pointer; the contents are in the LFS store, and nothing the
    // janitor reads shows the LFS server has them. `git lfs push --dry-run` and `git lfs status`
    // compare refs, not the server's objects.
    return `${coverage.lfs.length} file(s) stored with Git LFS, whose contents nothing shows are off this machine (${listSome(coverage.lfs)})`;
  }
  return null;
}

/**
 * Every repository inside the worktree a backup would hold only as a pointer, if at all: a
 * submodule or a snapshotted nested repository (a gitlink), an untracked one (git lists it as
 * `dir/`), and any `.git` the walk found, inside an ignored regenerable directory too. Once each.
 */
function listNestedRepositories(coverage: WorktreeCoverage): string[] {
  const seen = new Set<string>();
  const nested: string[] = [];
  for (const entry of [
    ...coverage.gitlinks,
    ...coverage.untracked.filter((path) => path.endsWith("/")),
    ...coverage.nestedRepositories,
  ]) {
    const key = entry.replace(/\/$/u, "");
    if (seen.has(key)) continue;
    seen.add(key);
    nested.push(entry);
  }
  return nested;
}

function describeRegenerable(ignored: readonly string[]): string {
  return ignored.length > 0 ? `; ignored only regenerable (${listSome(ignored)})` : "";
}

/**
 * Whether an ignored path is on the regenerable allowlist. Directories end with `/`. A listed
 * directory name counts only at the worktree root or in a directory holding a build manifest
 * (`manifestDirectories`, relative, as readWorktreeCoverage lists them): a `build/` beside a
 * `package.json` is that package's output, a `src/build/` beside source is somebody's files.
 */
export function isRegenerablePath(
  entry: string,
  manifestDirectories: ReadonlySet<string>,
): boolean {
  const isDirectory = entry.endsWith("/");
  const segments = entry.split("/").filter(Boolean);
  const directories = isDirectory ? segments : segments.slice(0, -1);
  const besideManifest = (index: number): boolean =>
    index === 0 || manifestDirectories.has(directories.slice(0, index).join("/"));
  for (const [index, name] of directories.entries()) {
    if (REGENERABLE_DIRS.has(name) && besideManifest(index)) return true;
    const nested = index > 0 ? `${directories[index - 1]}/${name}` : null;
    if (nested && REGENERABLE_NESTED_DIRS.has(nested) && besideManifest(index - 1)) return true;
  }
  if (isDirectory) return false;
  const name = segments[segments.length - 1] ?? "";
  const parentAndName = segments.slice(-2).join("/");
  return (
    REGENERABLE_FILES.has(name) ||
    REGENERABLE_FILES.has(parentAndName) ||
    REGENERABLE_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}

/** Whether a file (or an Xcode project directory) is a build manifest; see `BUILD_MANIFESTS`. */
export function isBuildManifest(name: string): boolean {
  return BUILD_MANIFESTS.has(name) || name.endsWith(".xcodeproj");
}

export type IdleProjectVerdict =
  | { kind: "keep"; reason: string }
  | { kind: "remove"; quietForMs: number; reason: string };

/**
 * Whether a project is sidebar clutter: not archived, not remote, no active workspace, and quiet
 * for `projectGraceMs` since the newest of its own timestamps and every one of its workspaces'.
 * An archived workspace's `archivedAt` is when it went, so the grace runs from the last one gone.
 * Removal is record-only and re-adding the project undoes it; its root is never looked at.
 */
export function idleProjectVerdict(
  project: DoneJanitorProject,
  workspaces: readonly DoneJanitorWorkspace[],
  config: Pick<ResolvedWorkspaceSweepConfig, "projectGraceMs">,
  nowMs: number,
): IdleProjectVerdict {
  if (project.archivedAt) return { kind: "keep", reason: "it is archived" };
  if (project.projectKey?.startsWith("remote:") || project.projectId.startsWith("remote:")) {
    return { kind: "keep", reason: "it is a remote project" };
  }
  const own = workspaces.filter((workspace) => workspace.projectId === project.projectId);
  if (own.some((workspace) => !workspace.archivedAt)) {
    return { kind: "keep", reason: "it has an active workspace" };
  }
  const newest = newestOf([
    parseStamp(project.createdAt),
    parseStamp(project.updatedAt),
    ...own.flatMap((workspace) => [
      parseStamp(workspace.createdAt),
      parseStamp(workspace.updatedAt),
      parseStamp(workspace.archivedAt),
    ]),
  ]);
  if (newest === null) return { kind: "keep", reason: "it has no usable activity signal" };
  const quietForMs = nowMs - newest;
  if (quietForMs < config.projectGraceMs) {
    return {
      kind: "keep",
      reason: `its last workspace went ${formatDuration(quietForMs)} ago; removed after ${formatDuration(config.projectGraceMs)}`,
    };
  }
  return {
    kind: "remove",
    quietForMs,
    reason: `it has had no active workspace for ${formatDuration(quietForMs)}`,
  };
}

function listSome(items: readonly string[]): string {
  const shown = items.slice(0, 3).join(", ");
  return items.length > 3 ? `${shown}, …` : shown;
}

function describeRecent(idleForMs: number, thresholdMs: number): string {
  return `active ${formatDuration(idleForMs)} ago; idle after ${formatDuration(thresholdMs)}`;
}

/** Absent is no signal. Present but unparseable reads as just now, which only ever delays. */
function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function newestOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}
