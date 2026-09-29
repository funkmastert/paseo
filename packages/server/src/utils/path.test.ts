import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  areEquivalentPaths,
  canonicalizePath,
  createPathEquivalenceMatcher,
  getRealpathAwareRelativePath,
  isPathInsideRoot,
} from "./path.js";

describe("path equivalence", () => {
  test.each([
    ["C:/Users/Administrator/GhostFactory", "C:\\Users\\Administrator\\GhostFactory"],
    ["d:\\Projects\\paseo", "D:\\Projects\\paseo"],
    ["C:\\Users\\Administrator\\GhostFactory\\", "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\C:\Users\Administrator\GhostFactory`, "C:\\Users\\Administrator\\GhostFactory"],
    [String.raw`\\?\UNC\server\share\GhostFactory`, String.raw`\\server\share\GhostFactory`],
  ])("matches Windows-equivalent cwd forms", (left, right) => {
    expect(areEquivalentPaths(left, right)).toBe(true);
    expect(createPathEquivalenceMatcher(left)(right)).toBe(true);
  });

  test("keeps POSIX path casing significant", () => {
    expect(
      areEquivalentPaths("/Users/Administrator/GhostFactory", "/users/administrator/ghostfactory"),
    ).toBe(false);
  });

  test("checks POSIX root containment without prefix false positives", () => {
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo/node_modules/@getpaseo/server")).toBe(true);
    expect(isPathInsideRoot("/opt/paseo", "/opt/paseo-other")).toBe(false);
  });

  test("checks Windows root containment case-insensitively", () => {
    expect(
      isPathInsideRoot("C:\\Paseo\\node_modules", "c:/paseo/node_modules/@getpaseo/server"),
    ).toBe(true);
    expect(isPathInsideRoot("C:\\Paseo\\node_modules", "C:\\Paseo\\node_modules-other")).toBe(
      false,
    );
  });

  test("preserves the casing of Windows relative suffixes", () => {
    expect(getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\HEAD")).toBe("HEAD");
    expect(
      getRealpathAwareRelativePath("C:\\Repo\\.git", "c:\\repo\\.git\\refs\\heads\\FeatureCase"),
    ).toBe("refs\\heads\\FeatureCase");
  });

  test.skipIf(process.platform === "win32")(
    "derives the contained suffix from a realpath-equivalent root",
    () => {
      const tempDir = mkdtempSync(join(tmpdir(), "paseo-path-"));
      try {
        const realRoot = join(tempDir, "real-root");
        const nestedPath = join(realRoot, "packages", "app");
        const aliasRoot = join(tempDir, "root-alias");
        mkdirSync(nestedPath, { recursive: true });
        symlinkSync(realRoot, aliasRoot, "dir");

        expect(getRealpathAwareRelativePath(aliasRoot, nestedPath)).toBe(join("packages", "app"));
        expect(getRealpathAwareRelativePath(aliasRoot, tempDir)).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("canonicalizePath", () => {
  function aliasedTree(): { tempDir: string; realRoot: string; aliasRoot: string } {
    const tempDir = mkdtempSync(join(tmpdir(), "paseo-canonical-"));
    const realRoot = join(realpathSync(tempDir), "real-root");
    const aliasRoot = join(tempDir, "root-alias");
    mkdirSync(join(realRoot, "worktree"), { recursive: true });
    symlinkSync(realRoot, aliasRoot, "dir");
    return { tempDir, realRoot, aliasRoot };
  }

  test("spells an existing directory by its realpath, whatever spelling it was given", () => {
    const { tempDir, realRoot, aliasRoot } = aliasedTree();
    try {
      expect(canonicalizePath(join(aliasRoot, "worktree"))).toBe(join(realRoot, "worktree"));
      expect(canonicalizePath(join(realRoot, "worktree", "."))).toBe(join(realRoot, "worktree"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("spells a missing path by its deepest existing ancestor's realpath and the rest", () => {
    const { tempDir, realRoot, aliasRoot } = aliasedTree();
    try {
      expect(canonicalizePath(join(aliasRoot, "worktree", "packages", "app"))).toBe(
        join(realRoot, "worktree", "packages", "app"),
      );
      expect(canonicalizePath("/no-such-root/a/b")).toBe("/no-such-root/a/b");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
