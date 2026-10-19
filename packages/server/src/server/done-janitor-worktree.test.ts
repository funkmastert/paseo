import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GitWorktreeSnapshotter } from "./agent/worktree-snapshot.js";
import {
  checkDeletionInvariant,
  listNestedRepositories,
} from "./agent/workspace-sweep-detector.js";
import {
  checkMergedIntoRemoteBase,
  checkNestedRepositorySafety,
  checkWorktreeDeletionSafety,
  computeSafeNestedRepositories,
  readWorkspaceActivitySignals,
  readWorktreeCoverage,
  verifyWorktreeBackup,
} from "./done-janitor-worktree.js";
import type { WorktreeSnapshotResult } from "./remediation/contract.js";
import type { RunGitCommand } from "../utils/run-git-command.js";

// Real repositories under a temp dir: the gate is only as good as its reading of real git
// output, so nothing here is faked.
let root: string;
let repo: string;
let remote: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

function addWorktree(name: string, branch: string): string {
  const path = join(root, "worktrees", name);
  git(repo, "worktree", "add", "-q", "-b", branch, path, "main");
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "done-janitor-worktree-"));
  repo = join(root, "repo");
  remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", "-b", "main", repo);
  commit(repo, "README.md", "hello\n");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
});

/** Directories a test made unreadable, given their mode back before the temp tree is removed. */
const lockedDirectories: string[] = [];

afterEach(() => {
  for (const directory of lockedDirectories.splice(0)) chmodSync(directory, 0o755);
  rmSync(root, { recursive: true, force: true });
});

function lockDirectory(directory: string): void {
  chmodSync(directory, 0o000);
  lockedDirectories.push(directory);
}

describe("checkWorktreeDeletionSafety", () => {
  test("a clean worktree whose branch was merged into its base is safe", async () => {
    const worktree = addWorktree("merged", "feature");
    commit(worktree, "a.txt", "a\n");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toMatchObject({ safe: true, branch: "feature" });
  });

  test("a clean worktree whose branch was pushed is safe even unmerged", async () => {
    const worktree = addWorktree("pushed", "feature");
    commit(worktree, "a.txt", "a\n");
    git(worktree, "push", "-q", "origin", "feature");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result.safe).toBe(true);
  });

  test("a branch that exists only in this worktree is not safe", async () => {
    const worktree = addWorktree("local-only", "feature");
    commit(worktree, "a.txt", "a\n");
    commit(worktree, "b.txt", "b\n");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toEqual({
      safe: false,
      reason: "feature has 2 commit(s) neither merged into main nor pushed to any remote",
      atRisk: "unpushed",
    });
  });

  test("commits after the last push are not safe", async () => {
    const worktree = addWorktree("ahead", "feature");
    commit(worktree, "a.txt", "a\n");
    git(worktree, "push", "-q", "origin", "feature");
    commit(worktree, "b.txt", "b\n");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toMatchObject({ safe: false });
    expect(!result.safe && result.reason).toContain("1 commit(s)");
  });

  test("another local branch containing the commits does not count", async () => {
    const worktree = addWorktree("other-branch", "feature");
    commit(worktree, "a.txt", "a\n");
    git(repo, "branch", "copy", "feature");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result.safe).toBe(false);
  });

  test("an untracked file is not safe", async () => {
    const worktree = addWorktree("untracked", "feature");
    writeFileSync(join(worktree, "notes.txt"), "draft\n");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toEqual({
      safe: false,
      reason: "it has 1 uncommitted or untracked file(s)",
      atRisk: "dirty",
    });
  });

  test("a staged change is not safe", async () => {
    const worktree = addWorktree("staged", "feature");
    writeFileSync(join(worktree, "README.md"), "changed\n");
    git(worktree, "add", "README.md");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result.safe).toBe(false);
  });

  test("ignored files do not block: they are the build output being reclaimed", async () => {
    const worktree = addWorktree("ignored", "feature");
    commit(worktree, ".gitignore", "node_modules/\n");
    git(repo, "merge", "-q", "--ff-only", "feature");
    execFileSync("mkdir", ["-p", join(worktree, "node_modules", "x")]);
    writeFileSync(join(worktree, "node_modules", "x", "index.js"), "1\n");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result.safe).toBe(true);
  });

  test("the primary checkout is never safe, however clean", async () => {
    const result = await checkWorktreeDeletionSafety({ worktreePath: repo, baseBranch: "main" });

    expect(result).toEqual({
      safe: false,
      reason: "it is a primary checkout, not a linked worktree",
    });
  });

  test("a subdirectory of a worktree is not treated as the worktree", async () => {
    const worktree = addWorktree("subdir", "feature");
    execFileSync("mkdir", ["-p", join(worktree, "pkg")]);

    const result = await checkWorktreeDeletionSafety({
      worktreePath: join(worktree, "pkg"),
      baseBranch: "main",
    });

    expect(result.safe).toBe(false);
  });

  test("a locked worktree is not safe", async () => {
    const worktree = addWorktree("locked", "feature");
    git(repo, "worktree", "lock", worktree);

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toEqual({ safe: false, reason: "it is locked with git worktree lock" });
  });

  test("a merge in progress is not safe", async () => {
    const worktree = addWorktree("merging", "feature");
    commit(worktree, "README.md", "ours\n");
    commit(repo, "README.md", "theirs\n");
    try {
      git(worktree, "merge", "-q", "main");
    } catch {
      // Conflicts, as intended.
    }
    git(worktree, "add", "README.md");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toEqual({ safe: false, reason: "it has a merge in progress" });
  });

  test("without a recorded base branch only a remote counts", async () => {
    const worktree = addWorktree("no-base", "feature");
    commit(worktree, "a.txt", "a\n");
    git(repo, "merge", "-q", "--ff-only", "feature");

    const result = await checkWorktreeDeletionSafety({ worktreePath: worktree, baseBranch: null });

    expect(result.safe).toBe(false);
  });

  test("a directory git cannot read is not safe", async () => {
    const plain = join(root, "plain");
    execFileSync("mkdir", ["-p", plain]);

    const result = await checkWorktreeDeletionSafety({ worktreePath: plain, baseBranch: "main" });

    expect(result.safe).toBe(false);
  });

  test("a missing directory is not safe", async () => {
    const result = await checkWorktreeDeletionSafety({
      worktreePath: join(root, "gone"),
      baseBranch: "main",
    });

    expect(result).toEqual({ safe: false, reason: "the directory does not exist", gone: true });
  });

  test.each([
    ["--assume-unchanged", "--assume-unchanged"],
    ["--skip-worktree", "--skip-worktree"],
  ])("an edit hidden from git status with %s is not safe", async (_name, flag) => {
    const worktree = addWorktree(`hidden${flag}`, "feature");
    git(worktree, "update-index", flag, "README.md");
    writeFileSync(join(worktree, "README.md"), "local only\n");
    git(repo, "merge", "-q", "--ff-only", "feature");

    const result = await checkWorktreeDeletionSafety({
      worktreePath: worktree,
      baseBranch: "main",
    });

    expect(result).toEqual({
      safe: false,
      reason:
        "1 tracked file(s) git is told not to check, with --assume-unchanged or --skip-worktree (README.md)",
    });
  });
});

describe("checkMergedIntoRemoteBase", () => {
  test("a branch merged and pushed to the remote base is merged", async () => {
    const worktree = addWorktree("merged-remote", "feature");
    commit(worktree, "a.txt", "a\n");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    git(repo, "push", "-q", "origin", "main");

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: "main" });

    expect(result).toEqual({ merged: true });
  });

  test("a branch pushed but not merged into the remote base is not merged", async () => {
    const worktree = addWorktree("pushed-unmerged", "feature");
    commit(worktree, "a.txt", "a\n");
    git(worktree, "push", "-q", "origin", "feature");

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: "main" });

    expect(result.merged).toBe(false);
    expect(!result.merged && result.reason).toContain(
      "not yet merged into refs/remotes/origin/main",
    );
  });

  test("a branch merged locally but not pushed to the remote base is not merged", async () => {
    const worktree = addWorktree("merged-local-only", "feature");
    commit(worktree, "a.txt", "a\n");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    // origin/main still points at the pre-merge commit.

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: "main" });

    expect(result.merged).toBe(false);
  });

  test("commits that exist nowhere remote are not merged", async () => {
    const worktree = addWorktree("local-only-merge-check", "feature");
    commit(worktree, "a.txt", "a\n");

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: "main" });

    expect(result.merged).toBe(false);
  });

  test("a branch squash-merged into the remote base is merged, though never its ancestor", async () => {
    const worktree = addWorktree("squash-merged", "feature");
    commit(worktree, "a.txt", "a\n");
    // What GitHub's and Gitea's default "squash and merge" does: one new commit on main whose
    // tree matches the branch's net change, with no ancestor/descendant relationship to it.
    git(repo, "merge", "-q", "--squash", "feature");
    git(repo, "commit", "-q", "-m", "squash merge feature");
    git(repo, "push", "-q", "origin", "main");

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: "main" });

    expect(result).toEqual({ merged: true });
  });

  test("a branch rebase-merged into the remote base is merged, though its own commit never landed", async () => {
    const worktree = addWorktree("rebase-merged", "feature");
    commit(worktree, "a.txt", "a\n");
    const featureHead = git(worktree, "rev-parse", "HEAD").trim();
    // What a "rebase and merge" does: the commit is replayed onto main with a new parent, so it
    // gets a new SHA even though the diff is identical. The worktree's own commit is never an
    // ancestor of the result.
    git(repo, "cherry-pick", featureHead);
    git(repo, "push", "-q", "origin", "main");

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: "main" });

    expect(result).toEqual({ merged: true });
  });

  test("no recorded base branch cannot tell", async () => {
    const worktree = addWorktree("no-base-merge-check", "feature");
    commit(worktree, "a.txt", "a\n");

    const result = await checkMergedIntoRemoteBase({ worktreePath: worktree, baseBranch: null });

    expect(result).toEqual({ merged: null, reason: "no base branch recorded" });
  });

  test("a base branch no remote holds cannot tell", async () => {
    const worktree = addWorktree("no-remote-base", "feature");
    commit(worktree, "a.txt", "a\n");

    const result = await checkMergedIntoRemoteBase({
      worktreePath: worktree,
      baseBranch: "develop",
    });

    expect(result).toEqual({ merged: null, reason: "no remote holds a develop branch" });
  });
});

describe("readWorkspaceActivitySignals", () => {
  const OLD = new Date("2026-09-01T00:00:00.000Z");

  function commitAt(cwd: string, file: string, date: Date): void {
    writeFileSync(join(cwd, file), `${date.toISOString()}\n`);
    git(cwd, "add", file);
    execFileSync("git", ["commit", "-q", "-m", `edit ${file}`], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_AUTHOR_DATE: date.toISOString(),
        GIT_COMMITTER_DATE: date.toISOString(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  }

  test("reads HEAD's commit time and the directory's own mtime", async () => {
    const worktree = addWorktree("signals", "feature");
    commitAt(worktree, "a.txt", OLD);
    utimesSync(worktree, OLD, OLD);

    expect(await readWorkspaceActivitySignals(worktree)).toEqual({
      headCommitMs: OLD.getTime(),
      directoryMtimeMs: OLD.getTime(),
    });
  });

  test("the git index is not activity: git status and a touched index change nothing", async () => {
    commitAt(repo, "a.txt", OLD);
    utimesSync(repo, OLD, OLD);
    git(repo, "status", "--porcelain");
    const index = join(repo, ".git", "index");
    utimesSync(index, new Date(), new Date());
    expect(statSync(index).mtimeMs).toBeGreaterThan(OLD.getTime());

    expect(await readWorkspaceActivitySignals(repo)).toEqual({
      headCommitMs: OLD.getTime(),
      directoryMtimeMs: OLD.getTime(),
    });
  });

  test("a directory outside git has only its mtime", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    utimesSync(plain, OLD, OLD);

    expect(await readWorkspaceActivitySignals(plain)).toEqual({
      headCommitMs: null,
      directoryMtimeMs: OLD.getTime(),
    });
  });

  test("a missing directory has no signal at all", async () => {
    expect(await readWorkspaceActivitySignals(join(root, "gone"))).toEqual({
      headCommitMs: null,
      directoryMtimeMs: null,
    });
  });
});

function snapshotter(maxUntrackedFileBytes = 1024 * 1024): GitWorktreeSnapshotter {
  return new GitWorktreeSnapshotter({
    readConfig: () => ({
      personalOwners: [],
      bundleDir: join(root, "bundles"),
      maxUntrackedFileBytes,
    }),
    paseoHome: join(root, "paseo-home"),
    logger: pino({ level: "silent" }),
  });
}

async function snapshot(
  worktree: string,
  maxUntrackedFileBytes?: number,
  backupIgnoredPaths?: readonly string[],
): Promise<Extract<WorktreeSnapshotResult, { kind: "snapshotted" }>> {
  const result = await snapshotter(maxUntrackedFileBytes).snapshot({
    cwd: worktree,
    reason: "test",
    backupIgnoredPaths,
  });
  if (result.kind !== "snapshotted") throw new Error(`expected a snapshot, got ${result.kind}`);
  return result;
}

describe("readWorktreeCoverage", () => {
  test("a clean, pushed worktree differs from HEAD in nothing", async () => {
    const worktree = addWorktree("clean", "feature");
    git(worktree, "push", "-q", "origin", "feature");

    expect(await readWorktreeCoverage({ worktreePath: worktree, commit: null })).toEqual({
      commit: git(worktree, "rev-parse", "HEAD").trim(),
      changed: [],
      untracked: [],
      ignored: [],
      gitlinks: [],
      unbackedCommits: 0,
      hidden: [],
      lfs: [],
      unreadable: [],
      nestedRepositories: [],
      manifestDirectories: [],
      copiedFromMainCheckout: [],
      backupEligibleIgnored: [],
      ignoredDirectoriesHoldingOnlyNestedRepositories: [],
    });
  });

  test("against HEAD: changed, untracked, ignored and unpushed work are all listed", async () => {
    const worktree = addWorktree("busy", "feature");
    commit(worktree, ".gitignore", "node_modules/\n.env\n");
    writeFileSync(join(worktree, "README.md"), "edited\n");
    writeFileSync(join(worktree, "notes.txt"), "untracked\n");
    writeFileSync(join(worktree, ".env"), "SECRET=1\n");
    mkdirSync(join(worktree, "node_modules", "x"), { recursive: true });
    writeFileSync(join(worktree, "node_modules", "x", "index.js"), "1\n");
    mkdirSync(join(worktree, "empty-ignored-parent", "node_modules"), { recursive: true });

    expect(await readWorktreeCoverage({ worktreePath: worktree, commit: null })).toMatchObject({
      changed: ["README.md"],
      untracked: ["notes.txt"],
      ignored: [".env", "node_modules/"],
      gitlinks: [],
      unbackedCommits: 1,
    });
  });

  test("against a snapshot of that state, nothing differs and no commit is unbacked", async () => {
    const worktree = addWorktree("snapshotted", "feature");
    commit(worktree, "work.txt", "committed, unpushed\n");
    writeFileSync(join(worktree, "README.md"), "edited\n");
    mkdirSync(join(worktree, "drafts"));
    writeFileSync(join(worktree, "drafts", "a.txt"), "draft\n");
    const taken = await snapshot(worktree);

    expect(await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit })).toEqual({
      commit: taken.commit,
      changed: [],
      untracked: [],
      ignored: [],
      gitlinks: [],
      unbackedCommits: 0,
      hidden: [],
      lfs: [],
      unreadable: [],
      nestedRepositories: [],
      manifestDirectories: [],
      copiedFromMainCheckout: [],
      backupEligibleIgnored: [],
      ignoredDirectoriesHoldingOnlyNestedRepositories: [],
    });
  });

  test("a file written or changed after the snapshot is listed against it", async () => {
    const worktree = addWorktree("after", "feature");
    writeFileSync(join(worktree, "notes.txt"), "before\n");
    const taken = await snapshot(worktree);
    writeFileSync(join(worktree, "notes.txt"), "after\n");
    writeFileSync(join(worktree, "new.txt"), "new\n");

    expect(
      await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit }),
    ).toMatchObject({ changed: ["notes.txt"], untracked: ["new.txt"] });
  });

  test("a possible secret the snapshotter left out is reported, and listed against the snapshot", async () => {
    const worktree = addWorktree("secret", "feature");
    writeFileSync(join(worktree, "small.txt"), "kept\n");
    writeFileSync(join(worktree, ".env"), "API_KEY=1\n");
    const taken = await snapshot(worktree);

    expect(taken.possibleSecrets).toEqual([".env"]);
    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit });
    expect(coverage).toMatchObject({ changed: [], untracked: [".env"] });
    expect(checkDeletionInvariant(coverage, "snapshot").holds).toBe(false);
  });

  test("a file the snapshotter left out is listed, whatever its rule was", async () => {
    // The size cap here; the secret filter's omissions are listed the same way (test above).
    const worktree = addWorktree("left-out", "feature");
    writeFileSync(join(worktree, "small.txt"), "kept\n");
    writeFileSync(join(worktree, "big.bin"), "x".repeat(64));
    const taken = await snapshot(worktree, 16);

    expect(
      await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit }),
    ).toMatchObject({ changed: [], untracked: ["big.bin"] });
  });

  test("a nested repository the snapshot added is a gitlink: a pointer, not its files", async () => {
    const worktree = addWorktree("nested", "feature");
    const nested = join(worktree, "vendor", "tool");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "f.txt", "only here\n");

    const head = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    expect(head?.untracked).toEqual(["vendor/tool/"]);
    const taken = await snapshot(worktree);
    const against = await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit });
    expect(against?.gitlinks).toEqual(["vendor/tool"]);
  });

  test("a directory git cannot read, and output cut off at the runner's cap, read as unknown", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await readWorktreeCoverage({ worktreePath: plain, commit: null })).toBeNull();

    const worktree = addWorktree("truncated", "feature");
    const truncating: RunGitCommand = async (args) => ({
      stdout: args[0] === "rev-parse" ? "abc\n" : "",
      stderr: "",
      truncated: args[0] === "ls-files",
      exitCode: 0,
      signal: null,
    });
    expect(
      await readWorktreeCoverage({ worktreePath: worktree, commit: null, runGit: truncating }),
    ).toBeNull();
  });

  test("never writes the worktree's own index", async () => {
    const worktree = addWorktree("index", "feature");
    writeFileSync(join(worktree, "notes.txt"), "untracked\n");
    const before = git(worktree, "ls-files", "--stage");
    const taken = await snapshot(worktree);

    await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit });

    expect(git(worktree, "ls-files", "--stage")).toBe(before);
  });
});

describe("readWorktreeCoverage, what git alone does not show", () => {
  test("an edit hidden with --assume-unchanged or --skip-worktree is listed", async () => {
    const worktree = addWorktree("hidden", "feature");
    commit(worktree, "config.json", "{}\n");
    git(worktree, "update-index", "--assume-unchanged", "README.md");
    git(worktree, "update-index", "--skip-worktree", "config.json");
    writeFileSync(join(worktree, "README.md"), "local only\n");
    writeFileSync(join(worktree, "config.json"), '{"local":true}\n');

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    // git diff reads both as unchanged: the flags are the only sign.
    expect(coverage).toMatchObject({ changed: [], hidden: ["README.md", "config.json"] });
  });

  test("a sparse checkout's files outside the cone are not on disk, so nothing is hidden", async () => {
    const worktree = addWorktree("sparse", "feature");
    mkdirSync(join(worktree, "src"));
    mkdirSync(join(worktree, "other"));
    commit(worktree, "src/a.ts", "a\n");
    commit(worktree, "other/b.txt", "b\n");
    git(worktree, "sparse-checkout", "set", "--cone", "src");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage?.hidden).toEqual([]);
  });

  // chmod 0o000 makes a directory genuinely unreadable on POSIX; on Windows it only toggles the
  // read-only attribute, so git still reads straight through it and these never see "unreadable".
  test.skipIf(process.platform === "win32")(
    "a directory it cannot read is listed: git skips it without failing",
    async () => {
      const worktree = addWorktree("unreadable", "feature");
      mkdirSync(join(worktree, "notes"));
      writeFileSync(join(worktree, "notes", "n.txt"), "hidden notes\n");
      lockDirectory(join(worktree, "notes"));

      const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

      expect(coverage?.unreadable).toEqual(["notes/"]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a directory inside an ignored one that it cannot read is listed too",
    async () => {
      const worktree = addWorktree("unreadable-ignored", "feature");
      commit(worktree, ".gitignore", "node_modules/\n");
      mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
      lockDirectory(join(worktree, "node_modules", "pkg"));

      const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

      expect(coverage?.unreadable).toEqual(["node_modules/pkg/"]);
    },
  );

  test("a repository nested anywhere is listed, inside an ignored directory too", async () => {
    const worktree = addWorktree("nested-ignored", "feature");
    commit(worktree, ".gitignore", ".cache/\n");
    const nested = join(worktree, ".cache", "tool");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "only-copy.txt", "unpushed nested work\n");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    // Git collapses it to the ignored directory; only the walk sees the repository.
    expect(coverage).toMatchObject({ ignored: [".cache/"], nestedRepositories: [".cache/tool/"] });
  });

  test("an ignored file inside an untracked directory is listed, not lost with it", async () => {
    const worktree = addWorktree("ignored-in-untracked", "feature");
    commit(worktree, ".gitignore", ".env\nnode_modules/\n");
    mkdirSync(join(worktree, "newpkg", "node_modules", "x"), { recursive: true });
    writeFileSync(join(worktree, "newpkg", "index.ts"), "new\n");
    writeFileSync(join(worktree, "newpkg", ".env"), "SECRET=1\n");
    writeFileSync(join(worktree, "newpkg", "node_modules", "x", "i.js"), "1\n");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage).toMatchObject({
      untracked: ["newpkg/index.ts"],
      ignored: ["newpkg/.env", "newpkg/node_modules/"],
    });
  });

  test("a directory on the way to an ignored path that holds a build manifest is listed", async () => {
    const worktree = addWorktree("manifests", "feature");
    commit(worktree, ".gitignore", "build/\n");
    mkdirSync(join(worktree, "packages", "app", "build"), { recursive: true });
    mkdirSync(join(worktree, "ios", "App.xcodeproj"), { recursive: true });
    mkdirSync(join(worktree, "ios", "build"), { recursive: true });
    mkdirSync(join(worktree, "src", "build"), { recursive: true });
    writeFileSync(join(worktree, "packages", "package.json"), "{}\n");
    writeFileSync(join(worktree, "packages", "app", "package.json"), "{}\n");
    writeFileSync(join(worktree, "packages", "app", "build", "out.js"), "1\n");
    writeFileSync(join(worktree, "ios", "build", "out.o"), "1\n");
    writeFileSync(join(worktree, "src", "build", "hand-written.json"), "{}\n");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage?.manifestDirectories).toEqual(["ios", "packages", "packages/app"]);
  });

  test("a file Git LFS would store is listed, tracked or not, whether or not git-lfs is installed", async () => {
    const worktree = addWorktree("lfs", "feature");
    commit(worktree, ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    commit(worktree, "tracked.bin", "pointer or content\n");
    writeFileSync(join(worktree, "new.bin"), "untracked\n");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage?.lfs).toEqual(["new.bin", "tracked.bin"]);
  });
});

/**
 * The review's probes (bozeo-ops/reviews/workspace-janitor-v2-replay/probes/__probe_edges.ts),
 * each a real worktree read the way the janitor plans a deletion: coverage against HEAD, judged by
 * the deletion invariant. Every case that deleted work there keeps its worktree here.
 */
describe("the deletion invariant on real worktrees", () => {
  function fixture(name: string): string {
    const worktree = addWorktree(name, "feature");
    commit(worktree, ".gitignore", "node_modules/\ndist/\nbuild/\n.cache/\n");
    mkdirSync(join(worktree, "src"));
    commit(worktree, "src/a.ts", "export const a = 1;\n");
    git(worktree, "push", "-q", "origin", "feature");
    return worktree;
  }

  async function plan(worktree: string): Promise<string> {
    const verdict = checkDeletionInvariant(
      await readWorktreeCoverage({ worktreePath: worktree, commit: null }),
      "plan",
    );
    return verdict.holds ? `holds: ${verdict.detail}` : `keep: ${verdict.reason}`;
  }

  test("A: a clean, pushed worktree with output at the root may go", async () => {
    const worktree = fixture("A");
    mkdirSync(join(worktree, "dist"));
    writeFileSync(join(worktree, "dist", "bundle.js"), "1\n");

    expect(await plan(worktree)).toBe(
      "holds: holds: every file is tracked and pushed; ignored only regenerable (dist/)",
    );
  });

  test("F2: a nested repository in an ignored .cache/ is kept", async () => {
    const worktree = fixture("F2");
    const nested = join(worktree, ".cache", "tool");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "only-copy.txt", "unpushed nested work\n");

    expect(await plan(worktree)).toBe(
      "keep: 1 submodule(s) or nested repositor(ies) a backup holds only as a pointer (.cache/tool/)",
    );
  });

  test("I1: a clean sparse checkout may go", async () => {
    const worktree = fixture("I1");
    mkdirSync(join(worktree, "dirB"));
    commit(worktree, "dirB/b.txt", "b\n");
    git(worktree, "push", "-q", "origin", "feature");
    git(worktree, "sparse-checkout", "set", "--cone", "src");

    expect(await plan(worktree)).toBe("holds: holds: every file is tracked and pushed");
  });

  // Same reason as the readWorktreeCoverage skips above: chmod 0o000 doesn't make a directory
  // unreadable on Windows.
  test.skipIf(process.platform === "win32")(
    "M3: an unreadable directory is kept, so the delete never stops half-way",
    async () => {
      const worktree = fixture("M3");
      mkdirSync(join(worktree, "notes"));
      writeFileSync(join(worktree, "notes", "n.txt"), "hidden notes\n");
      lockDirectory(join(worktree, "notes"));

      expect(await plan(worktree)).toBe(
        "keep: 1 director(ies) it cannot read or empty, so a delete would stop part-way (notes/)",
      );
    },
  );

  test.each([
    ["N1", "--assume-unchanged"],
    ["N2", "--skip-worktree"],
  ])("%s: an edit hidden with %s is kept", async (name, flag) => {
    const worktree = fixture(name);
    git(worktree, "update-index", flag, "src/a.ts");
    writeFileSync(join(worktree, "src", "a.ts"), "export const a = 42; // local only\n");

    expect(await plan(worktree)).toBe(
      "keep: 1 tracked file(s) git is told not to check, with --assume-unchanged or --skip-worktree (src/a.ts)",
    );
  });

  test.each([
    ["Q1", "src/build", "release-signing.json"],
    ["Q2", "src/.cache", "investigation-notes.md"],
    ["K", "config/build", "hand-written.json"],
  ])("%s: hand-written files in %s/ beside source are kept", async (name, directory, file) => {
    const worktree = fixture(name);
    mkdirSync(join(worktree, directory), { recursive: true });
    writeFileSync(join(worktree, directory, file), "only copy\n");

    expect(await plan(worktree)).toMatch(
      /^keep: 1 ignored path\(s\) that are not regenerable and no backup holds/,
    );
  });

  test("R: a .env beside a new, untracked source file is kept, before and after the snapshot", async () => {
    const worktree = fixture("R");
    commit(worktree, ".gitignore", "node_modules/\ndist/\nbuild/\n.cache/\n.env\n");
    git(worktree, "push", "-q", "origin", "feature");
    mkdirSync(join(worktree, "newpkg"));
    writeFileSync(join(worktree, "newpkg", "index.ts"), "export const n = 1;\n");
    writeFileSync(join(worktree, "newpkg", ".env"), "SECRET=only-copy\n");
    const reason = "1 ignored path(s) that are not regenerable and no backup holds (newpkg/.env)";

    expect(await plan(worktree)).toBe(`keep: ${reason}`);
    const taken = await snapshot(worktree);
    expect(
      checkDeletionInvariant(
        await readWorktreeCoverage({ worktreePath: worktree, commit: taken.commit }),
        "snapshot",
      ),
    ).toEqual({ holds: false, reason, category: "ignored-path" });
  });

  test("build output beside its package.json may go", async () => {
    const worktree = fixture("beside-manifest");
    mkdirSync(join(worktree, "packages", "app"), { recursive: true });
    commit(worktree, "packages/app/package.json", "{}\n");
    git(worktree, "push", "-q", "origin", "feature");
    mkdirSync(join(worktree, "packages", "app", "build"));
    writeFileSync(join(worktree, "packages", "app", "build", "out.js"), "1\n");

    expect(await plan(worktree)).toBe(
      "holds: holds: every file is tracked and pushed; ignored only regenerable (packages/app/build/)",
    );
  });

  test("LFS: a worktree whose files Git LFS stores is kept", async () => {
    const worktree = fixture("lfs");
    commit(worktree, ".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
    commit(worktree, "hero.png", "pointer\n");
    git(worktree, "push", "-q", "origin", "feature");

    expect(await plan(worktree)).toBe(
      "keep: 1 file(s) stored with Git LFS, whose contents nothing shows are off this machine (hero.png)",
    );
  });
});

/**
 * A worktree-setup script copies an ignored per-machine file — one without a name the deletion
 * invariant recognizes on its own, unlike `local.properties` or `google-services.json`
 * (`isRegenerablePath`, workspace-sweep-detector.ts) — from the main checkout (`repo`, the primary
 * checkout every `addWorktree` branches off) into the new worktree. `mainRepoRoot` lets the
 * deletion invariant recognize that copy instead of keeping the worktree for it forever
 * (docs/done-janitor.md, "The deletion invariant").
 */
describe("the deletion invariant against the main checkout", () => {
  function fixture(name: string): string {
    const worktree = addWorktree(name, "feature");
    commit(worktree, ".gitignore", "node_modules/\nmachine-config.json\nconfig/\n");
    git(worktree, "push", "-q", "origin", "feature");
    return worktree;
  }

  async function planAgainstMain(worktree: string): Promise<string> {
    const verdict = checkDeletionInvariant(
      await readWorktreeCoverage({ worktreePath: worktree, commit: null, mainRepoRoot: repo }),
      "plan",
    );
    return verdict.holds ? `holds: ${verdict.detail}` : `keep: ${verdict.reason}`;
  }

  test("a file byte-identical to the main checkout's copy may go", async () => {
    const worktree = fixture("copied-file");
    writeFileSync(join(repo, "machine-config.json"), "sdk.dir=/Users/someone/Android/sdk\n");
    writeFileSync(join(worktree, "machine-config.json"), "sdk.dir=/Users/someone/Android/sdk\n");

    expect(await planAgainstMain(worktree)).toBe(
      "holds: holds: every file is tracked and pushed; ignored path(s) copied from the main checkout (machine-config.json)",
    );
  });

  test("a directory byte-identical to the main checkout's copy may go", async () => {
    const worktree = fixture("copied-dir");
    for (const base of [repo, worktree]) {
      mkdirSync(join(base, "config", "xcshareddata"), { recursive: true });
      writeFileSync(join(base, "config", "xcshareddata", "a.xcsettings"), "<plist/>\n");
    }

    expect(await planAgainstMain(worktree)).toBe(
      "holds: holds: every file is tracked and pushed; ignored path(s) copied from the main checkout (config/)",
    );
  });

  test("a file that differs from the main checkout's copy is kept", async () => {
    const worktree = fixture("unique-file");
    writeFileSync(join(repo, "machine-config.json"), "sdk.dir=/Users/someone/Android/sdk\n");
    writeFileSync(join(worktree, "machine-config.json"), "sdk.dir=/Users/someone/other-sdk\n");

    expect(await planAgainstMain(worktree)).toBe(
      "keep: 1 ignored path(s) that are not regenerable and no backup holds (machine-config.json)",
    );
  });

  test("a file the main checkout does not have is kept, same as a .env edited only here", async () => {
    const worktree = fixture("env-only-here");
    writeFileSync(join(worktree, "machine-config.json"), "sdk.dir=/Users/someone/Android/sdk\n");

    expect(await planAgainstMain(worktree)).toBe(
      "keep: 1 ignored path(s) that are not regenerable and no backup holds (machine-config.json)",
    );
  });

  test("a symlink is kept even when its target matches the main checkout's copy", async () => {
    const worktree = fixture("symlinked-file");
    writeFileSync(join(repo, "machine-config.json"), "sdk.dir=/Users/someone/Android/sdk\n");
    symlinkSync(join(repo, "machine-config.json"), join(worktree, "machine-config.json"));

    expect(await planAgainstMain(worktree)).toBe(
      "keep: 1 ignored path(s) that are not regenerable and no backup holds (machine-config.json)",
    );
  });

  test("a directory that differs from the main checkout's copy is kept", async () => {
    const worktree = fixture("unique-dir");
    mkdirSync(join(repo, "config", "xcshareddata"), { recursive: true });
    writeFileSync(join(repo, "config", "xcshareddata", "a.xcsettings"), "<plist/>\n");
    mkdirSync(join(worktree, "config", "xcshareddata"), { recursive: true });
    writeFileSync(join(worktree, "config", "xcshareddata", "a.xcsettings"), "<plist edited/>\n");

    expect(await planAgainstMain(worktree)).toBe(
      "keep: 1 ignored path(s) that are not regenerable and no backup holds (config/)",
    );
  });

  test("a file past the hashing cap is kept even when it is actually identical", async () => {
    const worktree = fixture("over-cap");
    const big = `${"x".repeat(1_000_001)}\n`;
    writeFileSync(join(repo, "machine-config.json"), big);
    writeFileSync(join(worktree, "machine-config.json"), big);

    expect(await planAgainstMain(worktree)).toBe(
      "keep: 1 ignored path(s) that are not regenerable and no backup holds (machine-config.json)",
    );
  });

  test("dotnet build output beside its .csproj may go, without comparing it to the main checkout", async () => {
    const worktree = addWorktree("dotnet", "feature");
    mkdirSync(join(worktree, "src", "Camp.Api"), { recursive: true });
    commit(worktree, "src/Camp.Api/Camp.Api.csproj", "<Project />\n");
    commit(worktree, ".gitignore", "bin/\nobj/\n");
    git(worktree, "push", "-q", "origin", "feature");
    mkdirSync(join(worktree, "src", "Camp.Api", "bin"));
    writeFileSync(join(worktree, "src", "Camp.Api", "bin", "Camp.Api.dll"), "binary\n");

    expect(await planAgainstMain(worktree)).toBe(
      "holds: holds: every file is tracked and pushed; ignored only regenerable (src/Camp.Api/bin/)",
    );
  });
});

describe("verifyWorktreeBackup", () => {
  async function bundled(name: string) {
    const worktree = addWorktree(name, name);
    writeFileSync(join(worktree, "notes.txt"), "work\n");
    const taken = await snapshot(worktree);
    if (taken.offsite.kind !== "bundled") throw new Error("expected a bundle");
    return { worktree, taken, bundle: taken.offsite.path };
  }

  function verify(
    worktree: string,
    taken: Extract<WorktreeSnapshotResult, { kind: "snapshotted" }>,
  ) {
    return verifyWorktreeBackup({
      worktreePath: worktree,
      ref: taken.ref,
      commit: taken.commit,
      offsite: taken.offsite,
    });
  }

  test("a snapshot with its ref and a sound bundle verifies", async () => {
    const { worktree, taken } = await bundled("sound");
    expect(await verify(worktree, taken)).toBeNull();
  });

  test("a missing, empty or corrupt bundle does not", async () => {
    const { worktree, taken, bundle } = await bundled("bad-bundle");
    writeFileSync(bundle, "# v2 git bundle\nnot a bundle\n");
    expect(await verify(worktree, taken)).toBe(`its bundle ${bundle} fails git bundle verify`);
    truncateSync(bundle, 0);
    expect(await verify(worktree, taken)).toBe(`its bundle ${bundle} is empty`);
    unlinkSync(bundle);
    expect(await verify(worktree, taken)).toBe(`its bundle ${bundle} is missing`);
  });

  test("a bundle of some other snapshot does not", async () => {
    const { worktree, taken } = await bundled("other");
    const other = await bundled("other-2");
    expect(await verify(worktree, { ...taken, offsite: other.taken.offsite })).toBe(
      `its bundle ${(other.taken.offsite as { path: string }).path} does not hold the snapshot ${taken.commit}`,
    );
  });

  test("a missing ref, or a snapshot with no copy outside the repository, does not", async () => {
    const { worktree, taken } = await bundled("no-ref");
    expect(
      await verify(worktree, {
        ...taken,
        offsite: { kind: "none", reason: "bundle failed: disk full" },
      }),
    ).toBe("the snapshot has no copy outside the repository (bundle failed: disk full)");
    git(worktree, "update-ref", "-d", taken.ref);
    expect(await verify(worktree, taken)).toBe(`its backup ref ${taken.ref} does not exist`);
  });

  test("a janitor backup on a private personal origin passes the push scan first: a token is bundled, not pushed", async () => {
    const url = "https://github.com/example-owner/x.git";
    git(repo, "remote", "set-url", "origin", url);
    git(repo, "config", `url.${remote}.insteadOf`, url);
    const personal = new GitWorktreeSnapshotter({
      readConfig: () => ({
        personalOwners: ["example-owner"],
        bundleDir: join(root, "bundles"),
        maxUntrackedFileBytes: 1024 * 1024,
      }),
      paseoHome: join(root, "paseo-home"),
      logger: pino({ level: "silent" }),
      lookupRepoVisibility: async () => "private",
    });
    // The request shape the done janitor sends (agent-done-janitor.ts takeSnapshot).
    const janitorSnapshot = async (worktree: string) => {
      const result = await personal.snapshot({ cwd: worktree, reason: "done janitor, test" });
      if (result.kind !== "snapshotted") throw new Error(`expected a snapshot, got ${result.kind}`);
      return result;
    };

    const remoteRefs = () => git(remote, "for-each-ref", "--format=%(refname)");
    const clean = addWorktree("janitor-clean", "janitor-clean");
    writeFileSync(join(clean, "notes.txt"), "work\n");
    expect((await janitorSnapshot(clean)).offsite.kind).toBe("pushed");

    // Assembled at runtime so no secret scanner flags this file.
    const token = ["ghp", "z".repeat(36)].join("_");
    const leaky = addWorktree("janitor-leaky", "janitor-leaky");
    writeFileSync(join(leaky, "README.md"), `hello\nkey ${token}\n`);
    const before = remoteRefs();
    const taken = await janitorSnapshot(leaky);

    expect(taken.offsite.kind).toBe("bundled");
    expect(remoteRefs()).toBe(before);
    expect(await verify(leaky, taken)).toBeNull();
  });
});

describe("readWorktreeCoverage, backup-eligible ignored paths", () => {
  test("an ignored file matching a configured pattern is listed as backup-eligible", async () => {
    const worktree = addWorktree("backup-eligible", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "line\n");

    const coverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });

    expect(coverage).toMatchObject({
      ignored: [".worker-logs/"],
      backupEligibleIgnored: [".worker-logs/"],
    });
  });

  test("an ignored file matching no configured pattern is not backup-eligible", async () => {
    const worktree = addWorktree("backup-no-match", "feature");
    commit(worktree, ".gitignore", "src/build/\n");
    mkdirSync(join(worktree, "src", "build"), { recursive: true });
    writeFileSync(join(worktree, "src", "build", "release-signing.json"), "only copy\n");

    const coverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });

    expect(coverage?.backupEligibleIgnored).toEqual([]);
  });

  test("no patterns configured means nothing is backup-eligible, as before this existed", async () => {
    const worktree = addWorktree("backup-default", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "line\n");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage?.backupEligibleIgnored).toEqual([]);
  });

  test("a secret-shaped file inside a matching directory makes the whole directory ineligible", async () => {
    const worktree = addWorktree("backup-secret", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "line\n");
    writeFileSync(join(worktree, ".worker-logs", ".env"), "API_KEY=1\n");

    const coverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });

    expect(coverage?.backupEligibleIgnored).toEqual([]);
  });
});

describe("a work snapshot backs up a configured ignored path, and the janitor then releases it", () => {
  test("plan defers a backup-eligible ignored file instead of keeping forever; confirming against a real snapshot that staged it holds", async () => {
    const worktree = addWorktree("backup-flow", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "line\n");
    git(worktree, "push", "-q", "origin", "feature");

    const planCoverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });
    expect(checkDeletionInvariant(planCoverage, "plan").holds).toBe(true);
    // Without the pattern configured, planning still keeps it: nothing changed for everyone else.
    expect(
      checkDeletionInvariant(
        await readWorktreeCoverage({ worktreePath: worktree, commit: null }),
        "plan",
      ).holds,
    ).toBe(false);

    const taken = await snapshot(worktree, undefined, [".worker-logs/"]);
    const snapshotCoverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: taken.commit,
    });
    const invariant = checkDeletionInvariant(snapshotCoverage, "snapshot");
    expect(invariant).toEqual({
      holds: true,
      detail: "holds: every file is in the verified snapshot",
    });
  });

  test("with no patterns configured, an ignored file never forces a snapshot, so the worktree is kept exactly as before this existed", async () => {
    const worktree = addWorktree("backup-flow-unconfigured", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "line\n");
    git(worktree, "push", "-q", "origin", "feature");

    const result = await snapshotter().snapshot({ cwd: worktree, reason: "test" });
    expect(result.kind).toBe("nothing-at-risk");
    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    expect(checkDeletionInvariant(coverage, "head").holds).toBe(false);
  });

  // #11: the plan-basis excusal is safe only because the real snapshot's own basis re-reads an
  // unstaged entry as ignored. A file eligible when the plan read it, but grown past the cap by
  // the time the real snapshot runs, must still be read back as ignored and keep the worktree.
  test("a file eligible at plan time but grown past the cap before the real snapshot keeps the worktree", async () => {
    const worktree = addWorktree("backup-flow-grows", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "small\n");
    git(worktree, "push", "-q", "origin", "feature");

    const planCoverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });
    expect(checkDeletionInvariant(planCoverage, "plan").holds).toBe(true);

    writeFileSync(join(worktree, ".worker-logs", "a.log"), "x".repeat(2048));
    const result = await snapshotter().snapshot({
      cwd: worktree,
      reason: "test",
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });
    expect(result.kind).toBe("nothing-at-risk"); // nothing tracked changed; the log alone is over cap now
    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    expect(checkDeletionInvariant(coverage, "head").holds).toBe(false);
  });

  // #9: a total cap across every eligible entry, not just a per-file one.
  test("a total cap smaller than the combined eligible entries excludes the later ones", async () => {
    const worktree = addWorktree("backup-flow-total-cap", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\nmore-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    mkdirSync(join(worktree, "more-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "x".repeat(600));
    writeFileSync(join(worktree, "more-logs", "b.log"), "x".repeat(600));

    const coverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/", "more-logs/"],
      maxBackupIgnoredFileBytes: 1024,
      maxBackupIgnoredTotalBytes: 800,
    });
    // Both match and are each within the per-file cap, but together they exceed the total: only
    // the first accepted stays within it.
    expect(coverage?.backupEligibleIgnored).toEqual([".worker-logs/"]);
  });

  // #13: an eligible file whose name is also a glob (git pathspec syntax, not this module's own
  // glob matching) must never pull in an unchecked, ignored sibling when force-added. Both names
  // are ignored individually -- neither through a directory pattern, so the whole-directory
  // eligibility walk cannot explain a sibling showing up, and neither is picked up by the normal
  // untracked-file staging, which skips anything ignored.
  test("staging a file whose name looks like a glob does not also stage an unchecked, ignored sibling", async () => {
    const worktree = addWorktree("backup-flow-literal-pathspec", "feature");
    commit(worktree, ".gitignore", "run[1].log\nrun1.log\n");
    writeFileSync(join(worktree, "run[1].log"), "eligible\n");
    writeFileSync(join(worktree, "run1.log"), "never asked for, ignored on its own\n");

    const taken = await snapshot(worktree, undefined, ["run[1].log"]);
    const tracked = git(worktree, "ls-tree", "-r", "--name-only", taken.commit)
      .split("\n")
      .filter(Boolean);

    expect(tracked).toContain("run[1].log");
    expect(tracked).not.toContain("run1.log");
  });

  // #10: isSecretShapedPath applied per file, recursively -- not just to the top-level entry --
  // so a secret-named file the JEV list recognizes but hasSecretName (the untracked-file filter's
  // own, narrower list) does not still disqualifies the directory holding it.
  test("a file secret-shaped by the JEV path list, but not by the untracked-file filter's own list, disqualifies its directory", async () => {
    const worktree = addWorktree("backup-flow-jev-secret", "feature");
    commit(worktree, ".gitignore", ".worker-logs/\n");
    mkdirSync(join(worktree, ".worker-logs"));
    writeFileSync(join(worktree, ".worker-logs", "a.log"), "plain\n");
    writeFileSync(join(worktree, ".worker-logs", "terraform.tfvars"), 'token = "x"\n');

    const coverage = await readWorktreeCoverage({
      worktreePath: worktree,
      commit: null,
      backupIgnoredPaths: [".worker-logs/"],
      maxBackupIgnoredFileBytes: 1024,
    });
    expect(coverage?.backupEligibleIgnored).toEqual([]);
  });
});

describe("checkNestedRepositorySafety", () => {
  function initNested(worktree: string, relativePath: string): string {
    const nested = join(worktree, ...relativePath.split("/"));
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    return nested;
  }

  /**
   * A remote whose URL looks like a real network host, with a local `refs/remotes/<name>/<branch>`
   * matching `head` -- enough for `checkNestedRepositorySafety`'s reachability checks without an
   * actual network push (#6: a local-path remote, which `git push` to a bare repo on this machine
   * would otherwise produce, is deliberately never trusted).
   */
  function fakeNetworkRemote(nested: string, head: string, name = "origin"): void {
    git(nested, "remote", "add", name, `https://example.invalid/${name}.git`);
    git(nested, "update-ref", `refs/remotes/${name}/main`, head);
  }

  test("a clean repository on a trusted (network) remote is safe", async () => {
    const worktree = addWorktree("nested-safe", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(true);
  });

  test("a nested repository with no remote is not safe", async () => {
    const worktree = addWorktree("nested-no-remote", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, "f.txt", "content\n");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  test("a nested repository with uncommitted changes is not safe", async () => {
    const worktree = addWorktree("nested-dirty", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());
    writeFileSync(join(nested, "f.txt"), "edited\n");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  test("a nested repository with unpushed commits is not safe", async () => {
    const worktree = addWorktree("nested-unpushed", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());
    commit(nested, "g.txt", "more, never pushed\n");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  test("a directory git cannot read as a repository is not safe", async () => {
    await expect(checkNestedRepositorySafety(join(root, "does-not-exist"))).resolves.toBe(false);
  });

  // #6: a remote whose own URL is a local path -- what `git push` to a bare repo on this
  // machine produces -- is never trusted, even once pushed: that bare repo may sit inside the
  // very directory being deleted (an SPM-style `repositories/` cache, for one).
  test("a repository pushed only to a local-path remote is not safe", async () => {
    const worktree = addWorktree("nested-local-remote", "feature");
    const nested = initNested(worktree, "vendor/tool");
    const nestedRemote = join(root, "nested-remote.git");
    git(root, "init", "-q", "--bare", nestedRemote);
    commit(nested, "f.txt", "content\n");
    git(nested, "remote", "add", "origin", nestedRemote);
    git(nested, "push", "-q", "origin", "HEAD:main");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  // #2: a standalone nested clone's own refs are deleted with it, so a second local branch
  // holding commits no trusted remote has is invisible to a HEAD-only check.
  test("a nested repository with an unpushed sibling branch is not safe", async () => {
    const worktree = addWorktree("nested-sibling-branch", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());
    git(nested, "branch", "wip");
    git(nested, "checkout", "-q", "wip");
    commit(nested, "g.txt", "unpushed work on a sibling branch\n");
    git(nested, "checkout", "-q", "main");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  // #2: a stash entry is local-only, same as a sibling branch.
  test("a nested repository with a stash entry is not safe", async () => {
    const worktree = addWorktree("nested-stash", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());
    writeFileSync(join(nested, "f.txt"), "stashed edit\n");
    git(nested, "stash", "push", "-q");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  // #5: the outer worktree's own rule (not regenerable by name, no backup) applies inside a
  // nested repository too -- its own .gitignore must not hide a file the janitor never sees.
  test("a nested repository with an ignored, non-regenerable file is not safe", async () => {
    const worktree = addWorktree("nested-ignored-file", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, ".gitignore", "secret-notes.txt\n");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());
    writeFileSync(join(nested, "secret-notes.txt"), "only copy, never tracked\n");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(false);
  });

  // #5, the other direction: an ignored path regenerable by name (inside the nested repo's own
  // root) does not block it -- the outer rule's exceptions apply here too, not just its rule.
  test("a nested repository with only a regenerable ignored path is safe", async () => {
    const worktree = addWorktree("nested-ignored-regenerable", "feature");
    const nested = initNested(worktree, "vendor/tool");
    commit(nested, ".gitignore", "node_modules/\n");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());
    mkdirSync(join(nested, "node_modules", "x"), { recursive: true });
    writeFileSync(join(nested, "node_modules", "x", "index.js"), "1\n");

    await expect(checkNestedRepositorySafety(nested)).resolves.toBe(true);
  });

  // #4: an invalid `.git` entry (not a real repository) must never let git discovery climb to
  // an ancestor repository and read that outer repo's cleanliness as the candidate's own.
  test("a directory with an invalid .git entry is not safe, even though the outer worktree is clean", async () => {
    const worktree = addWorktree("nested-broken-git", "feature");
    git(worktree, "push", "-q", "origin", "feature");
    const broken = join(worktree, "vendor", "broken");
    mkdirSync(join(broken, ".git"), { recursive: true }); // an empty .git directory: not a repo
    writeFileSync(join(broken, "notes.md"), "would be lost\n");

    await expect(checkNestedRepositorySafety(broken)).resolves.toBe(false);
  });

  // #3: the outer gate's own guards (lock, in-progress operation, hidden edits) apply to a
  // nested *linked* worktree too, not only to a standalone clone.
  test("a nested linked worktree with a --skip-worktree edit is not safe", async () => {
    const worktree = addWorktree("nested-linked", "feature");
    const upstream = join(root, "upstream-repo");
    mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "-q", "-b", "main");
    commit(upstream, "config.json", "{}\n");
    const upstreamRemote = join(root, "upstream-remote.git");
    git(root, "init", "-q", "--bare", upstreamRemote);
    git(upstream, "remote", "add", "origin", upstreamRemote);
    git(upstream, "push", "-q", "origin", "main");
    git(upstream, "checkout", "-q", "--detach"); // free "main" for the linked worktree below
    const linked = join(worktree, "vendor", "linked");
    mkdirSync(join(worktree, "vendor"), { recursive: true });
    git(upstream, "worktree", "add", "-q", linked, "main");

    git(linked, "update-index", "--skip-worktree", "config.json");
    writeFileSync(join(linked, "config.json"), '{"local":true}\n');

    await expect(checkNestedRepositorySafety(linked)).resolves.toBe(false);
  });

  test("a locked nested linked worktree is not safe", async () => {
    const worktree = addWorktree("nested-locked", "feature");
    const upstream = join(root, "upstream-repo-2");
    mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "-q", "-b", "main");
    commit(upstream, "f.txt", "content\n");
    const upstreamRemote = join(root, "upstream-remote-2.git");
    git(root, "init", "-q", "--bare", upstreamRemote);
    git(upstream, "remote", "add", "origin", upstreamRemote);
    git(upstream, "push", "-q", "origin", "main");
    git(upstream, "checkout", "-q", "--detach"); // free "main" for the linked worktree below
    const linked = join(worktree, "vendor", "linked");
    mkdirSync(join(worktree, "vendor"), { recursive: true });
    git(upstream, "worktree", "add", "-q", "--lock", linked, "main");

    await expect(checkNestedRepositorySafety(linked)).resolves.toBe(false);
  });
});

describe("computeSafeNestedRepositories", () => {
  test("keeps only the candidates that are confirmed safe, by their own candidate string", async () => {
    const worktree = addWorktree("compute-safe", "feature");
    const safe = join(worktree, "vendor", "safe");
    mkdirSync(safe, { recursive: true });
    git(safe, "init", "-q");
    commit(safe, "f.txt", "content\n");
    git(safe, "remote", "add", "origin", "https://example.invalid/safe.git");
    git(safe, "update-ref", "refs/remotes/origin/main", git(safe, "rev-parse", "HEAD").trim());

    const unsafe = join(worktree, "vendor", "unsafe");
    mkdirSync(unsafe, { recursive: true });
    git(unsafe, "init", "-q");
    commit(unsafe, "f.txt", "content, no remote\n");

    const result = await computeSafeNestedRepositories(worktree, [
      "vendor/safe/",
      "vendor/unsafe/",
    ]);

    expect(result).toEqual(new Set(["vendor/safe/"]));
  });
});

describe("the deletion invariant: nested repositories confirmed safe", () => {
  function fakeNetworkRemote(nested: string, head: string): void {
    git(nested, "remote", "add", "origin", "https://example.invalid/origin.git");
    git(nested, "update-ref", "refs/remotes/origin/main", head);
  }

  test("a nested repository kept by checkDeletionInvariant is excused once it is in safeNestedRepositories", async () => {
    const worktree = addWorktree("invariant-nested-safe", "feature");
    git(worktree, "push", "-q", "origin", "feature");
    const nested = join(worktree, "vendor", "tool");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    expect(checkDeletionInvariant(coverage, "plan").holds).toBe(false);

    const candidates = listNestedRepositories(coverage as NonNullable<typeof coverage>);
    const safe = await computeSafeNestedRepositories(worktree, candidates);
    expect(checkDeletionInvariant(coverage, "plan", [], safe)).toEqual({
      holds: true,
      detail:
        "holds once a verified snapshot backs up 1 changed or untracked file(s); nested repo(s) judged safe (vendor/tool/)",
    });
  });

  test("an ignored container holding only nested repositories is excused once every one of them is safe", async () => {
    const worktree = addWorktree("invariant-nested-container", "feature");
    commit(worktree, ".gitignore", ".claude/worktrees/\n");
    git(worktree, "push", "-q", "origin", "feature");
    const nested = join(worktree, ".claude", "worktrees", "sub");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    expect(coverage).toMatchObject({
      ignored: [".claude/worktrees/"],
      ignoredDirectoriesHoldingOnlyNestedRepositories: [".claude/worktrees/"],
    });
    expect(checkDeletionInvariant(coverage, "plan").holds).toBe(false);

    const candidates = listNestedRepositories(coverage as NonNullable<typeof coverage>);
    const safe = await computeSafeNestedRepositories(worktree, candidates);
    expect(checkDeletionInvariant(coverage, "plan", [], safe)).toEqual({
      holds: true,
      detail:
        "holds: every file is tracked and pushed; container(s) of nested repo(s) judged safe (.claude/worktrees/); nested repo(s) judged safe (.claude/worktrees/sub/)",
    });
  });

  test("an ignored container is not excused while any nested repository under it is unsafe", async () => {
    const worktree = addWorktree("invariant-nested-container-unsafe", "feature");
    commit(worktree, ".gitignore", ".claude/worktrees/\n");
    git(worktree, "push", "-q", "origin", "feature");
    const nested = join(worktree, ".claude", "worktrees", "sub");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "f.txt", "content, no remote\n");

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    const candidates = listNestedRepositories(coverage as NonNullable<typeof coverage>);
    const safe = await computeSafeNestedRepositories(worktree, candidates);

    expect(safe.size).toBe(0);
    const invariant = checkDeletionInvariant(coverage, "plan", [], safe);
    expect(invariant.holds).toBe(false);
  });

  // #1: a loose file beside a safe nested repository, inside the same ignored container, must
  // still keep the worktree -- the container is excused only when it holds nested repos and
  // nothing else.
  test("a loose file beside a safe nested repository in the same container keeps the worktree", async () => {
    const worktree = addWorktree("invariant-nested-container-loose-file", "feature");
    commit(worktree, ".gitignore", ".claude/\n");
    git(worktree, "push", "-q", "origin", "feature");
    mkdirSync(join(worktree, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(join(worktree, ".claude", "skills", "mine", "SKILL.md"), "only copy\n");
    const nested = join(worktree, ".claude", "worktrees", "n1");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    commit(nested, "f.txt", "content\n");
    fakeNetworkRemote(nested, git(nested, "rev-parse", "HEAD").trim());

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });
    expect(coverage?.ignoredDirectoriesHoldingOnlyNestedRepositories).toEqual([]);

    const candidates = listNestedRepositories(coverage as NonNullable<typeof coverage>);
    const safe = await computeSafeNestedRepositories(worktree, candidates);
    const invariant = checkDeletionInvariant(coverage, "plan", [], safe);
    expect(invariant.holds).toBe(false);
    expect(invariant.holds === false ? invariant.category : undefined).toBe("ignored-path");
  });
});
