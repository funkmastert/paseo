/**
 * The git half of AgentDoneJanitor's workspace gate: can this worktree directory be deleted
 * without losing anything that exists nowhere else? Read-only — it never fetches, never writes a
 * ref, and runs with optional locks off. See docs/done-janitor.md.
 *
 * `deletePaseoWorktree` has no git-safety gate of its own (worktree-disk-sweep-detector.ts says
 * the same about the disk sweeper), so this is it. Every check refuses on doubt: a git command
 * that fails is a reason to keep the directory, never to delete it.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, realpathSync, rmSync, type Dirent } from "node:fs";
import { access, constants, lstat, opendir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_MAX_BACKUP_IGNORED_FILE_BYTES,
  isBackupEligibleIgnoredPath,
} from "./agent/backup-eligible-ignored.js";
import { isBuildManifest, isRegenerablePath } from "./agent/workspace-sweep-detector.js";
import type { WorktreeSnapshotOffsite } from "./remediation/contract.js";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} as const;
/** A gitlink: a submodule, or a nested repository added as one. */
const GITLINK_MODE = "160000";

/** Files git leaves in a worktree's own git dir while an operation is half done. */
const IN_PROGRESS_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["BISECT_LOG", "a bisect"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase or am"],
];

export type WorktreeDeletionSafety =
  | { safe: true; branch: string | null; head: string }
  | {
      safe: false;
      reason: string;
      /**
       * Set when the only problem is work a snapshot can save: uncommitted or untracked files
       * (`dirty`), or commits nothing else holds (`unpushed`). Absent for every other refusal.
       */
      atRisk?: "dirty" | "unpushed";
      /** The directory does not exist: nothing is left in it to lose. */
      gone?: true;
    };

export interface CheckWorktreeDeletionSafetyInput {
  worktreePath: string;
  /** The branch the worktree was created from; null when the workspace never recorded one. */
  baseBranch: string | null;
  runGit?: RunGitCommand;
}

// Git reports --path-format=absolute paths with forward slashes even on win32, and on a
// GitHub-hosted Windows runner TEMP is routinely an 8.3 short name ("RUNNER~1") that the plain
// JS realpathSync walker leaves untouched (it only follows symlinks/reparse points) while git's
// own internal resolution expands it — .native calls the OS's GetFinalPathNameByHandle instead,
// so both sides land on the same canonical form. The catch fallback must still return something
// native so two realpathOrSelf() results stay comparable when one side never hits the
// filesystem (e.g. a path that does not exist).
function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Safe means all of:
 * - git reads the directory, and it is the root of a **linked** worktree — its git dir differs
 *   from the common dir. A primary checkout shares them, so this refuses the main working copy
 *   whatever path it lives at.
 * - it is not locked with `git worktree lock`;
 * - no merge, rebase, cherry-pick, revert or bisect is half done;
 * - `git status` reports nothing: no staged, unstaged, untracked or submodule change. Ignored
 *   files are not counted — they are build output and dependencies, which is the space being
 *   reclaimed;
 * - no tracked file is marked `--assume-unchanged` or `--skip-worktree` while on disk: `git status`
 *   never looks at such a file, so an edit to it would read as clean;
 * - every commit reachable from HEAD is also reachable from a remote-tracking ref or from the
 *   local base branch. Both survive the deletion. A local branch other than the base does not
 *   count: it may be another worktree's branch, and the next sweep may delete that one.
 */
export async function checkWorktreeDeletionSafety(
  input: CheckWorktreeDeletionSafetyInput,
): Promise<WorktreeDeletionSafety> {
  const cwd = input.worktreePath;
  if (!existsSync(cwd)) return { safe: false, reason: "the directory does not exist", gone: true };
  const git = createReadOnlyGit(cwd, input.runGit ?? runGitCommand);

  const identity = await readLinkedWorktreeIdentity(git, cwd);
  if (!identity.ok) return { safe: false, reason: identity.reason };

  const treeProblem = await readTreeProblem(git, cwd, identity.gitDir);
  if (treeProblem) return { safe: false, ...treeProblem };

  return readReachability(git, input.baseBranch);
}

type ReadOnlyGit = (args: string[]) => Promise<string | null>;

/**
 * Null for any failure: a git command that fails is a reason to keep, never to delete. So is
 * output cut off at the runner's size cap: a truncated listing would read as fewer files.
 */
function createReadOnlyGit(
  cwd: string,
  runGit: RunGitCommand,
  env: Record<string, string> = {},
): ReadOnlyGit {
  return async (args) => {
    try {
      const result = await runGit(args, {
        cwd,
        envOverlay: { ...READ_ONLY_GIT_ENV, ...env },
        timeout: 30_000,
      });
      if (result.truncated) return null;
      // A null exit code is a signal: the output may be cut short.
      return result.exitCode === 0 ? result.stdout : null;
    } catch {
      return null;
    }
  };
}

async function readLinkedWorktreeIdentity(
  git: ReadOnlyGit,
  cwd: string,
): Promise<{ ok: true; gitDir: string } | { ok: false; reason: string }> {
  const revParse = await git([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  const [toplevel, gitDir, commonDir] = (revParse ?? "").split("\n").map((line) => line.trim());
  if (!toplevel || !gitDir || !commonDir) return { ok: false, reason: "git cannot read it" };
  if (realpathOrSelf(toplevel) !== realpathOrSelf(cwd)) {
    return { ok: false, reason: `it is inside another checkout (${toplevel})` };
  }
  if (realpathOrSelf(gitDir) === realpathOrSelf(commonDir)) {
    return { ok: false, reason: "it is a primary checkout, not a linked worktree" };
  }
  return { ok: true, gitDir };
}

/** A lock, a half-done operation, or any change `git status` reports. */
async function readTreeProblem(
  git: ReadOnlyGit,
  cwd: string,
  gitDir: string,
): Promise<{ reason: string; atRisk?: "dirty" } | null> {
  const worktreeList = await git(["worktree", "list", "--porcelain"]);
  if (worktreeList === null) return { reason: "git cannot list its worktrees" };
  if (isLockedWorktree(worktreeList, realpathOrSelf(cwd))) {
    return { reason: "it is locked with git worktree lock" };
  }
  for (const [marker, operation] of IN_PROGRESS_MARKERS) {
    if (existsSync(join(gitDir, marker))) return { reason: `it has ${operation} in progress` };
  }
  const status = await git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status === null) return { reason: "git status failed" };
  const changed = status.split("\n").filter((line) => line.trim().length > 0).length;
  if (changed > 0) {
    return { reason: `it has ${changed} uncommitted or untracked file(s)`, atRisk: "dirty" };
  }
  const hidden = await readHiddenFiles(git, cwd);
  if (hidden === null) return { reason: "git cannot list its index" };
  return hidden.length > 0 ? { reason: describeHiddenFiles(hidden) } : null;
}

/**
 * Tracked files whose changes git is told not to look for: `--assume-unchanged` (a lowercase tag
 * in `ls-files -v`), or `--skip-worktree` (`S`) with the file on disk. `git status`, `git diff`
 * and a snapshot's `add` all read such a file as unchanged, whatever is in it. A skip-worktree
 * file that is not on disk is a sparse checkout's, with nothing there to lose. Null when git
 * cannot list the index.
 */
async function readHiddenFiles(git: ReadOnlyGit, worktreePath: string): Promise<string[] | null> {
  const listing = await git(["ls-files", "-v", "-z"]);
  if (listing === null) return null;
  const hidden: string[] = [];
  const presentDirectories = new Map<string, boolean>();
  for (const entry of splitNul(listing)) {
    const tag = entry.slice(0, 1);
    const path = entry.slice(2);
    if (/^[a-z]$/u.test(tag)) {
      hidden.push(path);
    } else if (tag === "S" && (await isOnDisk(worktreePath, path, presentDirectories))) {
      hidden.push(path);
    }
  }
  return hidden;
}

/** Whether a path exists, not following a final symlink; a missing directory is read once. */
async function isOnDisk(
  root: string,
  path: string,
  presentDirectories: Map<string, boolean>,
): Promise<boolean> {
  const directory = dirname(path);
  let present = presentDirectories.get(directory);
  if (present === undefined) {
    present = await lstat(join(root, directory)).then(
      () => true,
      () => false,
    );
    presentDirectories.set(directory, present);
  }
  if (!present) return false;
  return lstat(join(root, path)).then(
    () => true,
    () => false,
  );
}

function describeHiddenFiles(hidden: readonly string[]): string {
  const shown = hidden.slice(0, 3).join(", ");
  return `${hidden.length} tracked file(s) git is told not to check, with --assume-unchanged or --skip-worktree (${hidden.length > 3 ? `${shown}, …` : shown})`;
}

async function readReachability(
  git: ReadOnlyGit,
  baseBranch: string | null,
): Promise<WorktreeDeletionSafety> {
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  if (!head) return { safe: false, reason: "it has no commits" };
  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;

  const survivors = ["--remotes"];
  const baseRef = baseBranch ? `refs/heads/${baseBranch}` : null;
  if (baseRef && (await git(["rev-parse", "--verify", "--quiet", baseRef]))?.trim()) {
    survivors.push(baseRef);
  }
  const unreachable = await git(["rev-list", "--count", "HEAD", "--not", ...survivors]);
  const count = unreachable === null ? Number.NaN : Number.parseInt(unreachable.trim(), 10);
  if (!Number.isFinite(count)) {
    return { safe: false, reason: "git could not compare it with its remotes" };
  }
  if (count > 0) {
    const base = baseRef ? `merged into ${baseBranch}` : "merged into a recorded base branch";
    return {
      safe: false,
      reason: `${branch ?? "HEAD"} has ${count} commit(s) neither ${base} nor pushed to any remote`,
      atRisk: "unpushed",
    };
  }
  return { safe: true, branch, head };
}

export type MergedIntoRemoteBase =
  | { merged: true }
  | { merged: false; reason: string }
  /** Can't tell: no base branch recorded, or no remote holds it. The caller allows through. */
  | { merged: null; reason: string };

export interface CheckMergedIntoRemoteBaseInput {
  worktreePath: string;
  /** The branch the worktree was created from; null when the workspace never recorded one. */
  baseBranch: string | null;
  runGit?: RunGitCommand;
}

/**
 * Whether this worktree's HEAD is merged into its *remote* base branch — stricter than
 * {@link checkWorktreeDeletionSafety}'s reachability check, which also accepts the base's local
 * ref or any other remote-tracking branch. Used by completion state's `done` gate
 * (docs/completion-state.md): "pushed somewhere" is not "the PR merged".
 *
 * Ancestor reachability is the fast path, but it is blind to the default GitHub/Gitea "squash and
 * merge" (and a rebase merge): both land HEAD's net changes on the base in a commit that is never
 * a descendant of HEAD, so reachability stays permanently non-zero. When reachability fails,
 * {@link isContentMergedIntoRemoteBase} falls back to a tree-equality check: HEAD's changes are
 * already on the base if merging HEAD into it would produce exactly the base's own tree.
 *
 * `merged: null` is "can't tell" (no base branch recorded, no matching remote ref, or a git
 * command failed) — doubt never reads as merged, but the caller treats it as allow-through, same
 * as a non-git or local checkout.
 */
export async function checkMergedIntoRemoteBase(
  input: CheckMergedIntoRemoteBaseInput,
): Promise<MergedIntoRemoteBase> {
  const { worktreePath, baseBranch } = input;
  if (!baseBranch) return { merged: null, reason: "no base branch recorded" };
  const git = createReadOnlyGit(worktreePath, input.runGit ?? runGitCommand);

  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  if (!head) return { merged: null, reason: "it has no commits" };

  const refList = await git([
    "for-each-ref",
    "--format=%(refname)",
    `refs/remotes/*/${baseBranch}`,
  ]);
  if (refList === null) return { merged: null, reason: "git could not list remote base refs" };
  const candidates = refList
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    return { merged: null, reason: `no remote holds a ${baseBranch} branch` };
  }

  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || "HEAD";
  const unreachable = await git(["rev-list", "--count", head, "--not", ...candidates]);
  const count = unreachable === null ? Number.NaN : Number.parseInt(unreachable.trim(), 10);
  if (!Number.isFinite(count)) {
    return { merged: null, reason: "git could not compare it with its remote base" };
  }
  if (count === 0) {
    return { merged: true };
  }
  if (await isContentMergedIntoRemoteBase(git, head, candidates[0])) {
    return { merged: true };
  }
  return {
    merged: false,
    reason:
      `${branch} has ${count} commit(s) not yet merged into ${candidates[0]}` +
      " (this never fetches — if it was just merged, run git fetch and retry)",
  };
}

/**
 * Content-equality fallback for a squash or rebase merge: true when merging `head` into
 * `remoteBaseRef` would change nothing — the result tree is exactly the base's own tree, with no
 * conflict. That means every change HEAD carries is already present on the base, which is what
 * "squashed and merged" looks like once the commits themselves no longer line up.
 */
async function isContentMergedIntoRemoteBase(
  git: ReadOnlyGit,
  head: string,
  remoteBaseRef: string,
): Promise<boolean> {
  // Non-zero exit (a real conflict, or a failure) maps to null by createReadOnlyGit, so a
  // conflicted merge never reads as a content match.
  const mergeTreeOutput = await git(["merge-tree", "--write-tree", remoteBaseRef, head]);
  if (mergeTreeOutput === null) return false;
  const resultTree = mergeTreeOutput.split("\n")[0]?.trim();
  if (!resultTree) return false;
  const baseTree = (
    await git(["rev-parse", "--verify", "--quiet", `${remoteBaseRef}^{tree}`])
  )?.trim();
  if (!baseTree) return false;
  return resultTree === baseTree;
}

function isLockedWorktree(porcelain: string, worktreePath: string): boolean {
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || realpathOrSelf(path.trim()) !== worktreePath) continue;
    return lines.some((line) => line === "locked" || line.startsWith("locked "));
  }
  return false;
}

/**
 * What the directory says about when it was last used: HEAD's committer time and the directory's
 * own mtime. Never the git index: `git status` rewrites it, so reading it would make every
 * workspace look used whenever anything looked at it. Null for whatever cannot be read.
 */
export async function readWorkspaceActivitySignals(
  directory: string,
  runGit: RunGitCommand = runGitCommand,
): Promise<{ headCommitMs: number | null; directoryMtimeMs: number | null }> {
  let directoryMtimeMs: number | null = null;
  try {
    directoryMtimeMs = (await stat(directory)).mtimeMs;
  } catch {
    return { headCommitMs: null, directoryMtimeMs: null };
  }
  const git = createReadOnlyGit(directory, runGit);
  const committed = await git(["log", "-1", "--format=%ct", "HEAD"]);
  const seconds = committed === null ? Number.NaN : Number.parseInt(committed.trim(), 10);
  return {
    headCommitMs: Number.isFinite(seconds) ? seconds * 1000 : null,
    directoryMtimeMs,
  };
}

/**
 * Every file in a worktree, read against one commit: the snapshot about to stand in for the
 * worktree, or HEAD when nothing needs one. What the deletion invariant (docs/done-janitor.md)
 * needs, and nothing it judges: `checkDeletionInvariant` in agent/workspace-sweep-detector.ts
 * does that.
 */
export interface WorktreeCoverage {
  /** The commit read against. */
  commit: string;
  /** In `commit`, but different or missing in the working tree; a dirty submodule too. */
  changed: string[];
  /** Neither ignored nor in `commit`. An untracked nested repository is one `dir/` entry. */
  untracked: string[];
  /**
   * Ignored paths. A directory an ignore rule names is one `dir/` entry; every other ignored file
   * is listed on its own, inside an untracked directory too. An empty directory is none.
   */
  ignored: string[];
  /** Submodules and nested repositories `commit` holds only as a pointer to a commit. */
  gitlinks: string[];
  /** Commits reachable from HEAD that neither a remote-tracking ref nor `commit` holds. */
  unbackedCommits: number;
  /** Tracked files git is told not to check for changes: `--assume-unchanged`, or `--skip-worktree` on disk. */
  hidden: string[];
  /** Files, tracked or untracked, whose `filter` attribute is `lfs`. */
  lfs: string[];
  /** Directories the delete could not read or empty. Each ends with `/`; the root is `./`. */
  unreadable: string[];
  /** Directories below the root holding a `.git`, ignored ones included. Each ends with `/`. */
  nestedRepositories: string[];
  /** Directories on the way to an ignored path that hold a build manifest, relative, sorted. */
  manifestDirectories: string[];
  /**
   * Ignored paths, part (c) of the deletion invariant's other half: a file or directory whose
   * content is byte-identical to the same relative path in the worktree's main checkout, so a
   * worktree-setup script copied it rather than the worktree holding the only copy. Empty when no
   * main checkout was given, when it differs, or when it doesn't exist there — see
   * `partitionCopiedFromMainCheckout`.
   */
  copiedFromMainCheckout: string[];
  /**
   * Ignored paths, part (d): one that matches `agents.doneJanitor.backupIgnoredPaths` and holds
   * nothing too large or secret-shaped to back up (`isBackupEligibleIgnoredPath`,
   * backup-eligible-ignored.ts). Empty when no patterns were given. Unlike
   * `copiedFromMainCheckout`, nothing here is backed up yet — `checkDeletionInvariant` may treat
   * it as pending a snapshot only while planning; a live deletion still has to go through a real
   * snapshot that stages it, same as any other at-risk file.
   */
  backupEligibleIgnored: string[];
  /**
   * Ignored directory entries (part of `ignored`) whose entire recursive content is one or more
   * entries of `nestedRepositories` and nothing else: a container like `.claude/worktrees/` that
   * git collapses to a single ignored entry because it never looks inside it. `checkDeletionInvariant`
   * may excuse one of these once every nested repository under it is confirmed safe
   * (`checkNestedRepositorySafety`) — the container itself holds nothing a nested repo's own
   * remote doesn't already cover.
   */
  ignoredDirectoriesHoldingOnlyNestedRepositories: string[];
}

/**
 * Reads the working tree against `commit` (HEAD when null) through a scratch index outside the
 * repository, seeded from the worktree's own index so unchanged files are not re-hashed. The
 * worktree's index, HEAD and refs are never written. It judges nothing a snapshot decided: a file
 * the snapshot left out, for its size or because it looked like a secret, is simply not in
 * `commit`, and reads as untracked here. Then what git's listing cannot show: the flags that hide
 * a change, Git LFS, and a walk of the whole tree for directories the delete could not get
 * through and repositories nested in ignored ones. Null when git cannot read any of it: that is
 * not the same as nothing to lose.
 */
export async function readWorktreeCoverage(input: {
  worktreePath: string;
  commit: string | null;
  runGit?: RunGitCommand;
  /** The repo root this worktree was created from, when known (`DoneJanitorWorkspace.mainRepoRoot`). */
  mainRepoRoot?: string | null;
  /** `agents.doneJanitor.backupIgnoredPaths`, already validated by `resolveBackupIgnoredPaths`. */
  backupIgnoredPaths?: readonly string[];
  /** `agents.doneJanitor.maxBackupIgnoredFileBytes`. Defaults to `DEFAULT_MAX_BACKUP_IGNORED_FILE_BYTES`. */
  maxBackupIgnoredFileBytes?: number;
}): Promise<WorktreeCoverage | null> {
  const { worktreePath } = input;
  if (!existsSync(worktreePath)) return null;
  const runGit = input.runGit ?? runGitCommand;
  const git = createReadOnlyGit(worktreePath, runGit);
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  if (!head) return null;
  const commit = (
    await git(["rev-parse", "--verify", "--quiet", `${input.commit ?? head}^{commit}`])
  )?.trim();
  if (!commit) return null;
  const indexFile = join(tmpdir(), `paseo-janitor-coverage-${process.pid}-${randomUUID()}`);
  try {
    const scratch = createReadOnlyGit(worktreePath, runGit, { GIT_INDEX_FILE: indexFile });
    if (!(await seedScratchIndex({ git, scratch, indexFile, commit }))) return null;
    const changed = await scratch([
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--ignore-submodules=none",
      "--name-only",
      "-z",
    ]);
    const untracked = await scratch(["ls-files", "-z", "--others", "--exclude-standard"]);
    // Not `ls-files --ignored --directory`: it never looks inside an untracked directory, so a
    // `.env` beside a new, untracked source file would be in neither list. `matching` shows a
    // directory an ignore rule names as one entry, and every other ignored file on its own.
    const status = await scratch([
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--ignored=matching",
      "--untracked-files=all",
    ]);
    const ignored = status === null ? null : await listIgnored(worktreePath, status);
    const staged = await scratch(["ls-files", "-z", "--stage"]);
    const hidden = await readHiddenFiles(git, worktreePath);
    const lfs = await git([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ":(attr:filter=lfs)",
    ]);
    const unbacked = await git([
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--remotes",
      ...(commit === head ? [] : [commit]),
    ]);
    const unbackedCommits = unbacked === null ? Number.NaN : Number.parseInt(unbacked.trim(), 10);
    if (
      changed === null ||
      untracked === null ||
      ignored === null ||
      staged === null ||
      hidden === null ||
      lfs === null ||
      !Number.isFinite(unbackedCommits)
    ) {
      return null;
    }
    const tree = await walkWorktree(worktreePath);
    const manifestDirectories = await readManifestDirectories(worktreePath, ignored);
    const unregenerable = unregenerableIgnored(ignored, manifestDirectories);
    return {
      commit,
      changed: splitNul(changed),
      untracked: splitNul(untracked),
      ignored,
      gitlinks: splitNul(staged).flatMap((entry) => {
        const [meta = "", path = ""] = entry.split("\t");
        return meta.startsWith(`${GITLINK_MODE} `) ? [path] : [];
      }),
      unbackedCommits,
      hidden,
      lfs: [...new Set(splitNul(lfs))].sort(),
      unreadable: tree.unreadable,
      nestedRepositories: tree.nestedRepositories,
      manifestDirectories,
      copiedFromMainCheckout: input.mainRepoRoot
        ? await partitionCopiedFromMainCheckout(worktreePath, input.mainRepoRoot, unregenerable)
        : [],
      backupEligibleIgnored: await partitionBackupEligibleIgnored(
        worktreePath,
        unregenerable,
        input.backupIgnoredPaths,
        input.maxBackupIgnoredFileBytes,
      ),
      ignoredDirectoriesHoldingOnlyNestedRepositories: listIgnoredDirectoriesOfOnlyNestedRepos(
        ignored,
        tree.nestedRepositories,
      ),
    };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }
}

/**
 * The scratch index holds `commit`'s tree. A one-tree `read-tree -m` over a copy of the worktree's
 * own index keeps the stat data of every entry that matches, so `git diff` re-hashes only what
 * changed; a plain `read-tree` is the fallback, slower and as correct.
 */
async function seedScratchIndex(input: {
  git: ReadOnlyGit;
  scratch: ReadOnlyGit;
  indexFile: string;
  commit: string;
}): Promise<boolean> {
  const realIndex = (
    await input.git(["rev-parse", "--path-format=absolute", "--git-path", "index"])
  )?.trim();
  if (realIndex && existsSync(realIndex)) {
    try {
      copyFileSync(realIndex, input.indexFile);
      if ((await input.scratch(["read-tree", "-m", input.commit])) !== null) return true;
    } catch {
      // Fall through to a fresh read.
    }
    rmSync(input.indexFile, { force: true });
  }
  return (await input.scratch(["read-tree", input.commit])) !== null;
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/**
 * The `!!` entries of `git status --porcelain=v1 -z --ignored=matching`, less directories that
 * hold no file at any depth: an empty ignored directory has nothing to lose.
 */
async function listIgnored(worktreePath: string, status: string): Promise<string[]> {
  const ignored: string[] = [];
  for (const entry of splitNul(status)) {
    if (!entry.startsWith("!! ")) continue;
    const path = entry.slice(3);
    if (path.endsWith("/") && !(await holdsAnyFile(join(worktreePath, path)))) continue;
    ignored.push(path);
  }
  return ignored;
}

/** Whether anything but directories is under `directory`; true when it cannot be read. */
async function holdsAnyFile(directory: string): Promise<boolean> {
  const pending = [directory];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) return true;
      pending.push(join(current, entry.name));
    }
  }
  return false;
}

/**
 * What only the file system can tell about the tree the delete goes through: directories it
 * could not read or empty, and every `.git` below the root. Git skips a directory it cannot open
 * without failing and collapses an ignored one to a single entry, so the whole tree is walked,
 * ignored directories included. Emptying a directory takes read, write and search permission on
 * it; a file's own permissions do not matter to the delete. Symbolic links are not followed: the
 * delete does not follow them either.
 */
async function walkWorktree(
  worktreePath: string,
): Promise<{ unreadable: string[]; nestedRepositories: string[] }> {
  const unreadable: string[] = [];
  const nestedRepositories: string[] = [];
  const pending: string[] = [""];
  for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
    const directory = join(worktreePath, relative);
    const label = relative === "" ? "./" : `${relative}/`;
    const writable = await access(directory, constants.R_OK | constants.W_OK | constants.X_OK).then(
      () => true,
      () => false,
    );
    let entries: Awaited<ReturnType<typeof opendir>>;
    try {
      entries = await opendir(directory, { bufferSize: 256 });
    } catch {
      unreadable.push(label);
      continue;
    }
    if (!writable) unreadable.push(label);
    try {
      for await (const entry of entries) {
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        // The root's own `.git` is this worktree's; any other is a repository of its own.
        if (entry.name === ".git" && relative !== "") nestedRepositories.push(label);
        if (relative === "" && entry.name === ".git") continue;
        if (await isDirectoryEntry(entry, join(worktreePath, child))) pending.push(child);
      }
    } catch {
      if (!unreadable.includes(label)) unreadable.push(label);
    }
  }
  return { unreadable: unreadable.sort(), nestedRepositories: nestedRepositories.sort() };
}

async function isDirectoryEntry(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean },
  path: string,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink() || entry.isFile()) return false;
  // Some file systems do not report a type: ask, without following a link.
  return lstat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
}

/**
 * The directories on the way to each ignored path that hold a build manifest (`isBuildManifest`):
 * the only places besides the root where a regenerable directory counts. A directory that cannot
 * be listed holds none, so what is under it keeps the worktree.
 */
async function readManifestDirectories(
  worktreePath: string,
  ignored: readonly string[],
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const entry of ignored) {
    const segments = entry.split("/").filter(Boolean);
    for (let length = 1; length < segments.length; length += 1) {
      candidates.add(segments.slice(0, length).join("/"));
    }
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    const names = await readdir(join(worktreePath, candidate)).catch(() => []);
    if (names.some(isBuildManifest)) found.push(candidate);
  }
  return found.sort();
}

/**
 * `ignored` minus whatever `isRegenerablePath` already allows by name: `checkDeletionInvariant`
 * never consults `copiedFromMainCheckout` for an entry regenerable by name, so comparing one
 * against the main checkout — a full recursive byte comparison for a directory — would read
 * `node_modules/`, `build/`, `Pods/` and the rest of `REGENERABLE_DIRS` for a result nobody uses.
 */
function unregenerableIgnored(
  ignored: readonly string[],
  manifestDirectories: readonly string[],
): string[] {
  const manifestDirectorySet = new Set(manifestDirectories);
  return ignored.filter((entry) => !isRegenerablePath(entry, manifestDirectorySet));
}

/**
 * A file above this size is never hashed: reading two copies of it into memory on every sweep
 * check is not worth sparing one worktree. Past the cap a file counts as unique, the same as one
 * that differs — the deletion invariant's doubt-keeps-it rule.
 */
const COPY_COMPARISON_SIZE_CAP_BYTES = 1_000_000;

/**
 * Which of `candidates` (already filtered to entries not regenerable by name) are byte-identical
 * to the same relative path under `mainRepoRoot`: a worktree-setup script's copy, not this
 * worktree's only copy. A directory entry (ends with `/`) counts only when every file under it
 * matches, recursively, and neither side holds an extra one. Missing, size-mismatched, over-cap or
 * genuinely different entries are left out, which keeps the worktree exactly as before this check
 * existed.
 */
async function partitionCopiedFromMainCheckout(
  worktreePath: string,
  mainRepoRoot: string,
  candidates: readonly string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of candidates) {
    const isDirectory = entry.endsWith("/");
    const relative = isDirectory ? entry.slice(0, -1) : entry;
    // A symlink is this worktree's own entry whatever its target holds; `readdir` and `stat`
    // would follow it and compare the target instead.
    if (await isSymbolicLink(join(worktreePath, relative))) continue;
    const matches = isDirectory
      ? await directoriesByteIdentical(join(worktreePath, relative), join(mainRepoRoot, relative))
      : await filesByteIdentical(join(worktreePath, relative), join(mainRepoRoot, relative));
    if (matches) copied.push(entry);
  }
  return copied;
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Two regular files (never symlinks) of the same size, small enough to compare, equal in full. */
async function filesByteIdentical(pathA: string, pathB: string): Promise<boolean> {
  let statA: Awaited<ReturnType<typeof lstat>>;
  let statB: Awaited<ReturnType<typeof lstat>>;
  try {
    [statA, statB] = await Promise.all([lstat(pathA), lstat(pathB)]);
  } catch {
    return false;
  }
  if (!statA.isFile() || !statB.isFile()) return false;
  if (statA.size !== statB.size) return false;
  if (statA.size > COPY_COMPARISON_SIZE_CAP_BYTES) return false;
  const [contentA, contentB] = await Promise.all([readFile(pathA), readFile(pathB)]);
  return contentA.equals(contentB);
}

/**
 * Recursively: the same file names, each a byte-identical file or a matching subdirectory. A
 * symlink, or anything `readdir` or a stat fails on, is never confirmed a copy.
 */
async function directoriesByteIdentical(directoryA: string, directoryB: string): Promise<boolean> {
  let entriesA: Dirent[];
  let entriesB: Dirent[];
  try {
    [entriesA, entriesB] = await Promise.all([
      readdir(directoryA, { withFileTypes: true }),
      readdir(directoryB, { withFileTypes: true }),
    ]);
  } catch {
    return false;
  }
  if (entriesA.length !== entriesB.length) return false;
  const byNameB = new Map(entriesB.map((entry) => [entry.name, entry]));
  for (const entryA of entriesA) {
    const entryB = byNameB.get(entryA.name);
    if (!entryB) return false;
    const pathA = join(directoryA, entryA.name);
    const pathB = join(directoryB, entryB.name);
    if (entryA.isDirectory() && entryB.isDirectory()) {
      if (!(await directoriesByteIdentical(pathA, pathB))) return false;
    } else if (entryA.isFile() && entryB.isFile()) {
      if (!(await filesByteIdentical(pathA, pathB))) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Which of `candidates` (already filtered to entries not regenerable by name) a work snapshot
 * would capture, were one taken now: `isBackupEligibleIgnoredPath` run over each, size cap and
 * secret filter included. Done once here rather than inside `checkDeletionInvariant` because that
 * function is pure and this needs to read file content.
 */
async function partitionBackupEligibleIgnored(
  worktreePath: string,
  candidates: readonly string[],
  patterns: readonly string[] = [],
  maxFileBytes: number = DEFAULT_MAX_BACKUP_IGNORED_FILE_BYTES,
): Promise<string[]> {
  if (patterns.length === 0) return [];
  const eligible: string[] = [];
  for (const entry of candidates) {
    if (await isBackupEligibleIgnoredPath({ worktreePath, entry, patterns, maxFileBytes })) {
      eligible.push(entry);
    }
  }
  return eligible;
}

/**
 * Ignored directory entries whose only content, recursively, is one or more of
 * `nestedRepositories` (and nothing else): a container git collapses to a single ignored entry,
 * like `.claude/worktrees/`, because it never looks inside a directory it ignores.
 * `checkDeletionInvariant` may excuse one of these once every nested repository under it is
 * confirmed safe — the container holds nothing beyond what each nested repo's own remote covers.
 */
function listIgnoredDirectoriesOfOnlyNestedRepos(
  ignored: readonly string[],
  nestedRepositories: readonly string[],
): string[] {
  return ignored.filter((entry) => {
    if (!entry.endsWith("/")) return false;
    const nestedUnder = nestedRepositories.filter((nested) => nested.startsWith(entry));
    return nestedUnder.length > 0;
  });
}

/**
 * Whether a repository nested inside a worktree is safe to lose when the worktree goes: its HEAD
 * is clean (no uncommitted or untracked change) and reachable from a remote-tracking ref of its
 * own. No local base branch is consulted, unlike {@link checkWorktreeDeletionSafety}: a nested
 * repository records no base branch of its own, and a backup only ever holds it as a pointer to a
 * commit, never its history. A git failure, a dirty tree or an unreachable HEAD all read as unsafe
 * — doubt keeps the worktree, same as everywhere else in this module.
 */
export async function checkNestedRepositorySafety(
  nestedRepositoryPath: string,
  runGit: RunGitCommand = runGitCommand,
): Promise<boolean> {
  const git = createReadOnlyGit(nestedRepositoryPath, runGit);
  const status = await git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status === null) return false;
  if (status.split("\n").some((line) => line.trim().length > 0)) return false;
  const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  if (!head) return false;
  const unreachable = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const count = unreachable === null ? Number.NaN : Number.parseInt(unreachable.trim(), 10);
  return Number.isFinite(count) && count === 0;
}

/**
 * Every nested repository path {@link checkDeletionInvariant} would otherwise keep the worktree
 * for (gitlinks, untracked nested repos, and anything the filesystem walk found), confirmed safe
 * by {@link checkNestedRepositorySafety}. Candidate paths come with mixed trailing-slash
 * conventions (a gitlink has none; a walked or untracked directory ends with `/`); both read the
 * same directory on disk, so the returned set keeps whichever form the candidate used.
 */
export async function computeSafeNestedRepositories(
  worktreePath: string,
  candidates: readonly string[],
  runGit: RunGitCommand = runGitCommand,
): Promise<Set<string>> {
  const safe = new Set<string>();
  for (const candidate of candidates) {
    const relative = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    if (await checkNestedRepositorySafety(join(worktreePath, relative), runGit)) {
      safe.add(candidate);
    }
  }
  return safe;
}

/**
 * Whether a snapshot is a backup the janitor may delete a worktree on: its ref exists and points
 * at the snapshot, the snapshot's objects are there, and a copy exists outside the repository — a
 * bundle file that is non-empty, passes `git bundle verify` and holds the snapshot, or a branch
 * the personal remote reports at the snapshot. Null when it is; otherwise why not. A snapshot
 * kept only in the repository's own refs is not enough: it goes if the repository does.
 */
export async function verifyWorktreeBackup(input: {
  worktreePath: string;
  ref: string;
  commit: string;
  offsite: WorktreeSnapshotOffsite;
  runGit?: RunGitCommand;
}): Promise<string | null> {
  const { ref, commit, offsite } = input;
  const git = createReadOnlyGit(input.worktreePath, input.runGit ?? runGitCommand);
  const at = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim();
  if (!at) return `its backup ref ${ref} does not exist`;
  if (at !== commit) return `its backup ref ${ref} points at ${at}, not the snapshot ${commit}`;
  if ((await git(["cat-file", "-e", `${commit}^{tree}`])) === null) {
    return `the snapshot ${commit} is missing from the repository`;
  }
  switch (offsite.kind) {
    case "none":
      return `the snapshot has no copy outside the repository (${offsite.reason})`;
    case "bundled":
      return verifyBundle(git, offsite.path, commit);
    case "pushed": {
      const listing = await git(["ls-remote", offsite.remote, `refs/heads/${offsite.branch}`]);
      const pushed = (listing ?? "").split("\n").some((line) => line.startsWith(`${commit}\t`));
      return pushed ? null : `${offsite.remote} does not hold ${offsite.branch} at the snapshot`;
    }
  }
}

async function verifyBundle(
  git: ReadOnlyGit,
  path: string,
  commit: string,
): Promise<string | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return `its bundle ${path} is missing`;
  }
  if (size === 0) return `its bundle ${path} is empty`;
  if ((await git(["bundle", "verify", "--quiet", path])) === null) {
    return `its bundle ${path} fails git bundle verify`;
  }
  const heads = await git(["bundle", "list-heads", path]);
  const holdsSnapshot = (heads ?? "").split("\n").some((line) => line.startsWith(`${commit} `));
  return holdsSnapshot ? null : `its bundle ${path} does not hold the snapshot ${commit}`;
}
