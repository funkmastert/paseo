import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isBackupEligibleIgnoredPath,
  resolveBackupIgnoredPaths,
} from "./backup-eligible-ignored.js";

describe("resolveBackupIgnoredPaths", () => {
  test("accepts an ordinary suffix or glob pattern", () => {
    expect(
      resolveBackupIgnoredPaths([".worker-logs/", "*.cache/"], () => {
        throw new Error("should not reject");
      }),
    ).toEqual([".worker-logs/", "*.cache/"]);
  });

  test("rejects a pattern that could match a secret, and reports it", () => {
    const rejected: string[] = [];
    expect(resolveBackupIgnoredPaths([".env", ".worker-logs/"], (p) => rejected.push(p))).toEqual([
      ".worker-logs/",
    ]);
    expect(rejected).toEqual([".env"]);
  });

  // #7: the JEV secret globs are end-anchored, so a trailing slash used to hide a secret-named
  // directory pattern from the rejection check.
  test("rejects a secret-named directory pattern with a trailing slash", () => {
    const rejected: string[] = [];
    expect(resolveBackupIgnoredPaths([".env/", ".worker-logs/"], (p) => rejected.push(p))).toEqual([
      ".worker-logs/",
    ]);
    expect(rejected).toEqual([".env/"]);
  });

  test("rejects a secret-named directory pattern without a trailing slash too", () => {
    const rejected: string[] = [];
    expect(resolveBackupIgnoredPaths([".env"], (p) => rejected.push(p))).toEqual([]);
    expect(rejected).toEqual([".env"]);
  });

  test("rejects a pattern that is only wildcards", () => {
    const rejected: string[] = [];
    expect(resolveBackupIgnoredPaths(["*", "**"], (p) => rejected.push(p))).toEqual([]);
    expect(rejected).toEqual(["*", "**"]);
  });

  test("undefined or empty input resolves to no patterns", () => {
    const fail = () => {
      throw new Error("should not be called");
    };
    expect(resolveBackupIgnoredPaths(undefined, fail)).toEqual([]);
    expect(resolveBackupIgnoredPaths([], fail)).toEqual([]);
  });
});

describe("isBackupEligibleIgnoredPath", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = mkdtempSync(join(tmpdir(), "backup-eligible-ignored-"));
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  test("a small file matching a configured pattern is eligible", async () => {
    writeFileSync(join(worktreePath, "worker.log"), "line one\nline two\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: "worker.log",
        patterns: ["*.log"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(true);
  });

  test("a file that matches no configured pattern is not eligible", async () => {
    writeFileSync(join(worktreePath, "notes.txt"), "hand-written\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: "notes.txt",
        patterns: ["*.log"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  test("a file over the size cap is not eligible", async () => {
    writeFileSync(join(worktreePath, "worker.log"), "x".repeat(2048));

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: "worker.log",
        patterns: ["*.log"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  test("a secret-shaped file is not eligible even if it matches a pattern", async () => {
    mkdirSync(join(worktreePath, ".worker-logs"));
    writeFileSync(join(worktreePath, ".worker-logs", ".env"), "API_KEY=1\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: ".worker-logs/",
        patterns: [".worker-logs/"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  test("a directory matching a pattern is eligible when every file inside is small and plain", async () => {
    mkdirSync(join(worktreePath, ".worker-logs", "nested"), { recursive: true });
    writeFileSync(join(worktreePath, ".worker-logs", "a.log"), "a\n");
    writeFileSync(join(worktreePath, ".worker-logs", "nested", "b.log"), "b\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: ".worker-logs/",
        patterns: [".worker-logs/"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(true);
  });

  test("a directory with one oversized file inside is not eligible as a whole", async () => {
    mkdirSync(join(worktreePath, ".worker-logs"));
    writeFileSync(join(worktreePath, ".worker-logs", "small.log"), "small\n");
    writeFileSync(join(worktreePath, ".worker-logs", "big.log"), "x".repeat(2048));

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: ".worker-logs/",
        patterns: [".worker-logs/"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  test("a symlink inside a matching directory makes the whole directory ineligible", async () => {
    mkdirSync(join(worktreePath, ".worker-logs"));
    writeFileSync(join(worktreePath, "outside.log"), "elsewhere\n");
    symlinkSync(join(worktreePath, "outside.log"), join(worktreePath, ".worker-logs", "link.log"));

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: ".worker-logs/",
        patterns: [".worker-logs/"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  // #7: a secret-shaped entry (a directory, here) is never eligible even when a broad pattern
  // would otherwise match it -- the trailing slash must not hide it from the check.
  test("a secret-named directory entry is not eligible even when a pattern matches it", async () => {
    mkdirSync(join(worktreePath, ".env"));
    writeFileSync(join(worktreePath, ".env", "local"), "DATABASE_PASSWORD=hunter2\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: ".env/",
        patterns: [".env/"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  // #7: a file under a secret-shaped ancestor directory is ineligible even when the top-level
  // matched entry (a plain "logs/") is not itself secret-shaped.
  test("a file under a secret-shaped ancestor directory is not eligible", async () => {
    mkdirSync(join(worktreePath, "logs", ".env"), { recursive: true });
    writeFileSync(join(worktreePath, "logs", ".env", "local"), "DATABASE_PASSWORD=hunter2\n");
    writeFileSync(join(worktreePath, "logs", "plain.log"), "fine\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: "logs/",
        patterns: ["logs/"],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });

  test("no patterns configured means nothing is eligible", async () => {
    writeFileSync(join(worktreePath, "worker.log"), "line\n");

    await expect(
      isBackupEligibleIgnoredPath({
        worktreePath,
        entry: "worker.log",
        patterns: [],
        maxFileBytes: 1024,
      }),
    ).resolves.toBe(false);
  });
});
