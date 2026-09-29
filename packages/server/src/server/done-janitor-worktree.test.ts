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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { GitWorktreeSnapshotter } from "./agent/worktree-snapshot.js";
import { checkDeletionInvariant } from "./agent/workspace-sweep-detector.js";
import {
  checkWorktreeDeletionSafety,
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
): Promise<Extract<WorktreeSnapshotResult, { kind: "snapshotted" }>> {
  const result = await snapshotter(maxUntrackedFileBytes).snapshot({
    cwd: worktree,
    reason: "test",
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

  test("a file the snapshotter left out is listed, whatever its rule was", async () => {
    // The size cap here; the secret filter (1c82709a9) drops files the same silent way.
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

  test("a directory it cannot read is listed: git skips it without failing", async () => {
    const worktree = addWorktree("unreadable", "feature");
    mkdirSync(join(worktree, "notes"));
    writeFileSync(join(worktree, "notes", "n.txt"), "hidden notes\n");
    lockDirectory(join(worktree, "notes"));

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage?.unreadable).toEqual(["notes/"]);
  });

  test("a directory inside an ignored one that it cannot read is listed too", async () => {
    const worktree = addWorktree("unreadable-ignored", "feature");
    commit(worktree, ".gitignore", "node_modules/\n");
    mkdirSync(join(worktree, "node_modules", "pkg"), { recursive: true });
    lockDirectory(join(worktree, "node_modules", "pkg"));

    const coverage = await readWorktreeCoverage({ worktreePath: worktree, commit: null });

    expect(coverage?.unreadable).toEqual(["node_modules/pkg/"]);
  });

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

  test("M3: an unreadable directory is kept, so the delete never stops half-way", async () => {
    const worktree = fixture("M3");
    mkdirSync(join(worktree, "notes"));
    writeFileSync(join(worktree, "notes", "n.txt"), "hidden notes\n");
    lockDirectory(join(worktree, "notes"));

    expect(await plan(worktree)).toBe(
      "keep: 1 director(ies) it cannot read or empty, so a delete would stop part-way (notes/)",
    );
  });

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
    ).toEqual({ holds: false, reason });
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
});
