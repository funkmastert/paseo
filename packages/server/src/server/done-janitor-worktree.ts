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
import { copyFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** Ignored paths. A wholly ignored directory is one `dir/` entry; an empty one is none. */
  ignored: string[];
  /** Submodules and nested repositories `commit` holds only as a pointer to a commit. */
  gitlinks: string[];
  /** Commits reachable from HEAD that neither a remote-tracking ref nor `commit` holds. */
  unbackedCommits: number;
}

/**
 * Reads the working tree against `commit` (HEAD when null) through a scratch index outside the
 * repository, seeded from the worktree's own index so unchanged files are not re-hashed. The
 * worktree's index, HEAD and refs are never written. It judges nothing a snapshot decided: a file
 * the snapshot left out, for its size or because it looked like a secret, is simply not in
 * `commit`, and reads as untracked here. Null when git cannot read any of it: that is not the
 * same as nothing to lose.
 */
export async function readWorktreeCoverage(input: {
  worktreePath: string;
  commit: string | null;
  runGit?: RunGitCommand;
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
    const ignored = await scratch([
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
    ]);
    const staged = await scratch(["ls-files", "-z", "--stage"]);
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
      !Number.isFinite(unbackedCommits)
    ) {
      return null;
    }
    return {
      commit,
      changed: splitNul(changed),
      untracked: splitNul(untracked),
      ignored: splitNul(ignored),
      gitlinks: splitNul(staged).flatMap((entry) => {
        const [meta = "", path = ""] = entry.split("\t");
        return meta.startsWith(`${GITLINK_MODE} `) ? [path] : [];
      }),
      unbackedCommits,
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
