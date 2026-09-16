import { describe, expect, it } from "vitest";
import { parseStoredAgentRecord, type StoredAgentRecord } from "./agent-storage.js";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  HANDOFF_FROM_LABEL,
} from "./account-failover-detector.js";
import {
  buildResumePrompt,
  findExistingSuccessor,
  formatMovedTitle,
  stripMovedTitlePrefix,
} from "./account-failover-migration.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

function record(input: {
  id: string;
  provider: string;
  createdAt: string;
  sessionId?: string;
  labels?: Record<string, string>;
  archivedAt?: string;
}): StoredAgentRecord {
  return parseStoredAgentRecord({
    id: input.id,
    provider: input.provider,
    cwd: "/tmp/work",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    labels: input.labels ?? {},
    persistence: input.sessionId
      ? { provider: input.provider, sessionId: input.sessionId, nativeHandle: input.sessionId }
      : null,
    ...(input.archivedAt ? { archivedAt: input.archivedAt } : {}),
  });
}

const predecessor = record({
  id: "old",
  provider: "claude",
  createdAt: "2026-09-15T10:00:00.000Z",
  sessionId: SESSION,
});

describe("findExistingSuccessor", () => {
  it("finds a successor named by the handoff-from label, even on another session", () => {
    const labeled = record({
      id: "manual",
      provider: "claude-backup",
      createdAt: "2026-09-15T09:00:00.000Z",
      sessionId: "some-other-session",
      labels: { [HANDOFF_FROM_LABEL]: "old" },
    });

    expect(findExistingSuccessor(predecessor, [predecessor, labeled])?.id).toBe("manual");
  });

  it("finds an unlabeled import of the same session created later, archived or not", () => {
    const unlabeled = record({
      id: "imported",
      provider: "claude-personal",
      createdAt: "2026-09-16T00:10:00.000Z",
      sessionId: SESSION,
      archivedAt: "2026-09-16T02:00:00.000Z",
    });

    expect(findExistingSuccessor(predecessor, [predecessor, unlabeled])?.id).toBe("imported");
  });

  it("does not mistake an older agent on the same session for a successor", () => {
    const ancestor = record({
      id: "ancestor",
      provider: "claude-personal",
      createdAt: "2026-09-14T10:00:00.000Z",
      sessionId: SESSION,
      labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "old" },
    });

    expect(findExistingSuccessor(predecessor, [ancestor, predecessor])).toBeNull();
  });

  it("does not count a successor that has since handed the conversation back", () => {
    const handedBack = record({
      id: "hop",
      provider: "claude-backup",
      createdAt: "2026-09-15T11:00:00.000Z",
      sessionId: SESSION,
      labels: { [HANDOFF_FROM_LABEL]: "old", [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "old" },
    });

    expect(findExistingSuccessor(predecessor, [predecessor, handedBack])).toBeNull();
  });

  it("still counts a successor that moved on to a third agent", () => {
    const middle = record({
      id: "middle",
      provider: "claude-personal",
      createdAt: "2026-09-15T11:00:00.000Z",
      sessionId: SESSION,
      labels: { [HANDOFF_FROM_LABEL]: "old", [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "latest" },
    });
    const latest = record({
      id: "latest",
      provider: "claude-backup",
      createdAt: "2026-09-15T12:00:00.000Z",
      sessionId: SESSION,
      labels: { [HANDOFF_FROM_LABEL]: "middle" },
    });

    expect(findExistingSuccessor(predecessor, [predecessor, middle, latest])?.id).toBe("middle");
  });

  it("returns null when nothing continues the conversation", () => {
    const unrelated = record({
      id: "unrelated",
      provider: "claude-personal",
      createdAt: "2026-09-16T00:00:00.000Z",
      sessionId: "another-session",
    });

    expect(findExistingSuccessor(predecessor, [predecessor, unrelated])).toBeNull();
  });
});

describe("formatMovedTitle", () => {
  it("prefixes the title with the successor id", () => {
    expect(formatMovedTitle("Build the failover service", "new-1")).toBe(
      "[MOVED → new-1, out of budget] Build the failover service",
    );
  });

  it("replaces an existing prefix instead of stacking a second one", () => {
    const manual = "[MOVED → 0734543f, out of budget] Build the failover service";
    expect(formatMovedTitle(manual, "new-1")).toBe(
      "[MOVED → new-1, out of budget] Build the failover service",
    );
    expect(stripMovedTitlePrefix(manual)).toBe("Build the failover service");
  });
});

describe("buildResumePrompt", () => {
  const prompt = buildResumePrompt({
    oldAgentId: "0734543f",
    oldProviderId: "claude",
    targetProviderId: "claude-personal",
    model: "claude-opus-5",
    thinkingOptionId: "max",
    modeId: "bypassPermissions",
    resetHint: "3:10pm (America/Los_Angeles)",
  });

  it("names the target provider and model explicitly for new subagents", () => {
    expect(prompt).toContain('provider "claude-personal/claude-opus-5"');
    expect(prompt).toContain('"claude" is out of budget');
  });

  it("states the restored settings, the old id, and the reset hint", () => {
    expect(prompt).toContain("model claude-opus-5, thinking max, mode bypassPermissions");
    expect(prompt).toContain("agent 0734543f");
    expect(prompt).toContain("3:10pm (America/Los_Angeles)");
    expect(prompt).toContain("still parented to 0734543f");
  });

  it("does not claim settings it does not know", () => {
    const bare = buildResumePrompt({
      oldAgentId: "a",
      oldProviderId: "claude",
      targetProviderId: "claude-backup",
      model: undefined,
      thinkingOptionId: undefined,
      modeId: undefined,
      resetHint: null,
    });
    expect(bare).toContain('provider "claude-backup/<model>"');
    expect(bare).not.toContain(" with model");
    expect(bare).not.toContain("reset");
  });
});
