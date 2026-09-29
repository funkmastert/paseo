import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stableAuditKey } from "./memory.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "memory-key-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stableAuditKey", () => {
  it("keys the same file the same way across two different worktrees of one repo", async () => {
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "a@b.c");
    git(repo, "config", "user.name", "a");
    writeFileSync(path.join(repo, "CLAUDE.md"), "hello");
    git(repo, "add", "CLAUDE.md");
    git(repo, "commit", "-q", "-m", "init");

    const worktreeA = path.join(root, "worktree-serene-bumblebee");
    const worktreeB = path.join(root, "worktree-quiet-otter");
    git(repo, "worktree", "add", "-q", worktreeA, "-b", "task-a");
    git(repo, "worktree", "add", "-q", worktreeB, "-b", "task-b");

    const [keyA, keyB] = await Promise.all([
      stableAuditKey(path.join(worktreeA, "CLAUDE.md")),
      stableAuditKey(path.join(worktreeB, "CLAUDE.md")),
    ]);
    expect(keyA).toBe(keyB);
    expect(keyA).toContain("CLAUDE.md");
  });

  it("keys a file the same as its own cwd's directory-level key stays distinct per relative path", async () => {
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "a@b.c");
    git(repo, "config", "user.name", "a");
    mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
    writeFileSync(path.join(repo, "CLAUDE.md"), "root");
    writeFileSync(path.join(repo, "packages", "app", "CLAUDE.md"), "nested");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");

    const rootKey = await stableAuditKey(path.join(repo, "CLAUDE.md"));
    const nestedKey = await stableAuditKey(path.join(repo, "packages", "app", "CLAUDE.md"));
    expect(rootKey).not.toBe(nestedKey);
  });

  it("keys the same relative file differently across two different repos", async () => {
    const repoA = path.join(root, "repo-a");
    const repoB = path.join(root, "repo-b");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo);
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "a@b.c");
      git(repo, "config", "user.name", "a");
      writeFileSync(path.join(repo, "CLAUDE.md"), "hello");
      git(repo, "add", "CLAUDE.md");
      git(repo, "commit", "-q", "-m", "init");
    }
    const keyA = await stableAuditKey(path.join(repoA, "CLAUDE.md"));
    const keyB = await stableAuditKey(path.join(repoB, "CLAUDE.md"));
    expect(keyA).not.toBe(keyB);
  });

  it("falls back to the absolute path outside a git repository", async () => {
    const file = path.join(root, "CLAUDE.md");
    writeFileSync(file, "no git here");
    expect(await stableAuditKey(file)).toBe(realpathSync(file));
  });
});
