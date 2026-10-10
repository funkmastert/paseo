import { describe, expect, test } from "vitest";
import {
  evaluateDeletionCandidate,
  type WorktreeCheckoutStatusForSweep,
  type WorktreeRegistryState,
} from "./worktree-disk-sweep-detector.js";

const RETENTION_DAYS = 7;
const NOW_MS = Date.parse("2026-09-12T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const CLEAN_NOT_AHEAD: WorktreeCheckoutStatusForSweep = {
  isGit: true,
  isDirty: false,
  aheadOfOrigin: 0,
};

function archivedAt(daysAgo: number): WorktreeRegistryState {
  return { kind: "archived", referenceAt: new Date(NOW_MS - daysAgo * DAY_MS).toISOString() };
}

function unknownSince(daysAgo: number): WorktreeRegistryState {
  return { kind: "unknown", referenceAt: new Date(NOW_MS - daysAgo * DAY_MS).toISOString() };
}

describe("evaluateDeletionCandidate", () => {
  test("keeps an archived directory still within its retention grace period", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: archivedAt(1),
      retentionDays: RETENTION_DAYS,
      checkoutStatus: CLEAN_NOT_AHEAD,
      nowMs: NOW_MS,
    });

    expect(decision).toBe("keep-in-grace");
  });

  test("deletes an archived, past-retention, clean, not-ahead directory", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: archivedAt(RETENTION_DAYS + 1),
      retentionDays: RETENTION_DAYS,
      checkoutStatus: CLEAN_NOT_AHEAD,
      nowMs: NOW_MS,
    });

    expect(decision).toBe("delete");
  });

  test("keeps a past-retention directory with uncommitted changes", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: archivedAt(RETENTION_DAYS + 1),
      retentionDays: RETENTION_DAYS,
      checkoutStatus: { isGit: true, isDirty: true, aheadOfOrigin: 0 },
      nowMs: NOW_MS,
    });

    expect(decision).toBe("keep-unsafe");
  });

  test("keeps a past-retention directory that is ahead of origin", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: archivedAt(RETENTION_DAYS + 1),
      retentionDays: RETENTION_DAYS,
      checkoutStatus: { isGit: true, isDirty: false, aheadOfOrigin: 2 },
      nowMs: NOW_MS,
    });

    expect(decision).toBe("keep-unsafe");
  });

  test("keeps a past-retention directory with no resolvable ahead-of-origin count", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: archivedAt(RETENTION_DAYS + 1),
      retentionDays: RETENTION_DAYS,
      checkoutStatus: { isGit: true, isDirty: false, aheadOfOrigin: null },
      nowMs: NOW_MS,
    });

    expect(decision).toBe("keep-unsafe");
  });

  test("keeps a past-retention directory git cannot resolve at all (unresolvable status)", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: archivedAt(RETENTION_DAYS + 1),
      retentionDays: RETENTION_DAYS,
      checkoutStatus: { isGit: false },
      nowMs: NOW_MS,
    });

    expect(decision).toBe("keep-unsafe");
  });

  test("keeps a directory with an unparseable reference timestamp", () => {
    const decision = evaluateDeletionCandidate({
      onDiskPath: "/worktrees/proj/slug",
      registryState: { kind: "archived", referenceAt: "not-a-date" },
      retentionDays: RETENTION_DAYS,
      checkoutStatus: CLEAN_NOT_AHEAD,
      nowMs: NOW_MS,
    });

    expect(decision).toBe("keep-unsafe");
  });

  describe("untracked directories get archived semantics", () => {
    test("an unknown directory within its retention window stays in grace", () => {
      const decision = evaluateDeletionCandidate({
        onDiskPath: "/worktrees/proj/orphan",
        registryState: unknownSince(1),
        retentionDays: RETENTION_DAYS,
        checkoutStatus: CLEAN_NOT_AHEAD,
        nowMs: NOW_MS,
      });

      expect(decision).toBe("keep-in-grace");
    });

    test("an unknown, past-retention, clean, not-ahead directory deletes exactly like an archived one", () => {
      const decision = evaluateDeletionCandidate({
        onDiskPath: "/worktrees/proj/orphan",
        registryState: unknownSince(RETENTION_DAYS + 1),
        retentionDays: RETENTION_DAYS,
        checkoutStatus: CLEAN_NOT_AHEAD,
        nowMs: NOW_MS,
      });

      expect(decision).toBe("delete");
    });
  });
});
