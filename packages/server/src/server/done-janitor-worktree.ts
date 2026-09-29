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
import { access, constants, lstat, opendir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isBuildManifest } from "./agent/workspace-sweep-detector.js";
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
      manifestDirectories: await readManifestDirectories(worktreePath, ignored),
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
