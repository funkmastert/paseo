import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffReports } from "../../../token-audit/diff.js";
import { mergeSameKeyRows, stableAuditKey } from "./memory.js";
import { row, type TokenAuditReport, type TokenSeverity } from "./types.js";

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

describe("mergeSameKeyRows", () => {
  const KEY = "memory:file:/Users/t/paseo/.git:CLAUDE.md";
  const BOZEO = "/Users/t/paseo-worktrees/bozeo/CLAUDE.md";
  const CI_GREEN = "/Users/t/paseo-worktrees/wk-ci-green/CLAUDE.md";

  function fileRow(severity: TokenSeverity, tokens: number) {
    return row("memory", KEY, severity, "project memory file", `${tokens} tokens`, "cost", {
      "memory.fileTokens": tokens,
    });
  }

  function report(bozeo: TokenSeverity, ciGreen: TokenSeverity): TokenAuditReport {
    const tokens = (severity: TokenSeverity) => (severity === "RED" ? 9_000 : 1_000);
    return {
      version: 1,
      generatedAt: "2026-09-29T00:00:00.000Z",
      source: "job",
      rows: mergeSameKeyRows([
        { row: fileRow(bozeo, tokens(bozeo)), path: BOZEO },
        { row: fileRow(ciGreen, tokens(ciGreen)), path: CI_GREEN },
      ]),
    };
  }

  it("folds sibling worktrees' rows into one: worst severity, largest metric, every path", () => {
    const other = row("memory", "memory:total:/elsewhere", "GREEN", "total", "e", "c");
    const merged = mergeSameKeyRows([
      { row: fileRow("GREEN", 1_000), path: BOZEO },
      { row: other, path: "/elsewhere" },
      { row: fileRow("RED", 9_000), path: CI_GREEN },
    ]);

    expect(merged.map((r) => r.key)).toEqual([KEY, "memory:total:/elsewhere"]);
    expect(merged[0]).toMatchObject({ severity: "RED", metrics: { "memory.fileTokens": 9_000 } });
    expect(merged[0]?.evidence).toContain(BOZEO);
    expect(merged[0]?.evidence).toContain(CI_GREEN);
    expect(merged[1]).toBe(other);
  });

  it("a measured severity wins over UNKNOWN", () => {
    const [merged] = mergeSameKeyRows([
      { row: row("memory", KEY, "UNKNOWN", "f", "e", "c"), path: BOZEO },
      { row: fileRow("GREEN", 1_000), path: CI_GREEN },
    ]);
    expect(merged?.severity).toBe("GREEN");
  });

  it("an unchanged RED in one sibling worktree does not re-escalate the next week", () => {
    const diff = diffReports(report("RED", "GREEN"), report("RED", "GREEN"));
    expect(diff.newRed).toEqual([]);
    expect(diff.escalate).toBe(false);
  });

  it("the repo's file going RED in any worktree is a new RED", () => {
    const diff = diffReports(report("GREEN", "GREEN"), report("RED", "GREEN"));
    expect(diff.newRed.map((r) => r.key)).toEqual([KEY]);
    expect(diff.escalate).toBe(true);
  });

  it("a RED that moves between sibling worktrees is the same repo item, still RED", () => {
    const diff = diffReports(report("GREEN", "RED"), report("RED", "GREEN"));
    expect(diff.newRed).toEqual([]);
  });
});
