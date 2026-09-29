/**
 * The git half of AgentDoneJanitor's workspace gate: can this worktree directory be deleted
 * without losing anything that exists nowhere else? Read-only — it never fetches, never writes a
 * ref, and runs with optional locks off. See docs/done-janitor.md.
 *
 * `deletePaseoWorktree` has no git-safety gate of its own (worktree-disk-sweep-detector.ts says
 * the same about the disk sweeper), so this is it. Every check refuses on doubt: a git command
 * that fails is a reason to keep the directory, never to delete it.
 */

import { existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";

const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } as const;

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
    };

export interface CheckWorktreeDeletionSafetyInput {
  worktreePath: string;
  /** The branch the worktree was created from; null when the workspace never recorded one. */
  baseBranch: string | null;
  runGit?: RunGitCommand;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
 * - every commit reachable from HEAD is also reachable from a remote-tracking ref or from the
 *   local base branch. Both survive the deletion. A local branch other than the base does not
 *   count: it may be another worktree's branch, and the next sweep may delete that one.
 */
export async function checkWorktreeDeletionSafety(
  input: CheckWorktreeDeletionSafetyInput,
): Promise<WorktreeDeletionSafety> {
  const cwd = input.worktreePath;
  if (!existsSync(cwd)) return { safe: false, reason: "the directory does not exist" };
  const git = createReadOnlyGit(cwd, input.runGit ?? runGitCommand);

  const identity = await readLinkedWorktreeIdentity(git, cwd);
  if (!identity.ok) return { safe: false, reason: identity.reason };

  const treeProblem = await readTreeProblem(git, cwd, identity.gitDir);
  if (treeProblem) return { safe: false, ...treeProblem };

  return readReachability(git, input.baseBranch);
}

type ReadOnlyGit = (args: string[]) => Promise<string | null>;

/** Null for any failure: a git command that fails is a reason to keep, never to delete. */
function createReadOnlyGit(cwd: string, runGit: RunGitCommand): ReadOnlyGit {
  return async (args) => {
    try {
      const result = await runGit(args, { cwd, envOverlay: READ_ONLY_GIT_ENV, timeout: 30_000 });
      return result.exitCode === 0 || result.exitCode === null ? result.stdout : null;
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
  return changed > 0
    ? { reason: `it has ${changed} uncommitted or untracked file(s)`, atRisk: "dirty" }
    : null;
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
 * Every ignored path in the worktree, a wholly ignored directory as one `dir/` entry, so
 * `node_modules` costs one line. Null when git cannot list them: that is not the same as none.
 */
export async function listIgnoredEntries(
  worktreePath: string,
  runGit: RunGitCommand = runGitCommand,
): Promise<string[] | null> {
  if (!existsSync(worktreePath)) return null;
  const listing = await createReadOnlyGit(
    worktreePath,
    runGit,
  )(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
  return listing === null ? null : listing.split("\0").filter(Boolean);
}
