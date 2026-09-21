import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { checkWorktreeDeletionSafety } from "./done-janitor-worktree.js";

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

    expect(result).toEqual({ safe: false, reason: "it has 1 uncommitted or untracked file(s)" });
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

    expect(result).toEqual({ safe: false, reason: "the directory does not exist" });
  });
});
