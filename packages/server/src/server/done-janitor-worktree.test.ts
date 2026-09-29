import { execFileSync } from "node:child_process";
import {
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

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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
