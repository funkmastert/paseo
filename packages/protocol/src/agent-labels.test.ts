import { describe, expect, test } from "vitest";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  COMPLETION_LABEL,
  COMPLETION_NOTE_LABEL,
  COMPLETION_NOTE_MAX_LENGTH,
  followMigratedTo,
  getCompletionNoteFromLabels,
  getCompletionStateFromLabels,
  getMigratedToFromLabels,
  getParentAgentIdFromLabels,
  getOpenAgentTabLabel,
  hasOpenAgentTab,
  isDaemonAutomationAgent,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("recognizes a remediation agent or a schedule run as daemon automation", () => {
    expect(isDaemonAutomationAgent({ labels: { "paseo.remediation": "system-memory" } })).toBe(
      true,
    );
    expect(isDaemonAutomationAgent({ labels: { "paseo.remediation-key": "system-memory" } })).toBe(
      true,
    );
    expect(isDaemonAutomationAgent({ labels: { "paseo.schedule-id": "sched-1" } })).toBe(true);
    expect(isDaemonAutomationAgent({ labels: { "paseo.schedule-run": "run-1" } })).toBe(true);
  });

  test("does not treat an ordinary root agent as daemon automation", () => {
    expect(isDaemonAutomationAgent({ labels: {} })).toBe(false);
    expect(isDaemonAutomationAgent({ labels: undefined })).toBe(false);
  });

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });
});

describe("following a moved agent to its live successor", () => {
  const records: Record<string, Record<string, string>> = {
    live: {},
    "moved-once": { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "live" },
    "moved-twice": { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: " moved-once " },
    revived: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "   " },
    dangling: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "gone" },
    "loop-a": { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "loop-b" },
    "loop-b": { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "loop-a" },
  };
  const labelsOf = (agentId: string) => records[agentId] ?? null;

  test("an agent that never moved is its own live end", () => {
    expect(followMigratedTo("live", labelsOf)).toEqual({ kind: "self", agentId: "live" });
    expect(followMigratedTo("revived", labelsOf)).toEqual({ kind: "self", agentId: "revived" });
  });

  test("a moved handle resolves to the end of its chain", () => {
    expect(followMigratedTo("moved-twice", labelsOf)).toEqual({
      kind: "moved",
      agentId: "live",
      chain: ["moved-twice", "moved-once", "live"],
    });
  });

  test("a pointer to an agent that no longer exists stops at the last one that does", () => {
    expect(followMigratedTo("dangling", labelsOf)).toEqual({ kind: "self", agentId: "dangling" });
  });

  test("a chain that loops is refused, naming the loop", () => {
    expect(followMigratedTo("loop-a", labelsOf)).toEqual({
      kind: "loop",
      chain: ["loop-a", "loop-b", "loop-a"],
    });
  });

  test("blank migrated-to reads as unset", () => {
    expect(getMigratedToFromLabels({ [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: " " })).toBeNull();
    expect(getMigratedToFromLabels(undefined)).toBeNull();
  });
});

describe("completion state", () => {
  test("reads a recognized completion state", () => {
    expect(getCompletionStateFromLabels({ [COMPLETION_LABEL]: "ready-to-merge" })).toBe(
      "ready-to-merge",
    );
    expect(getCompletionStateFromLabels({ [COMPLETION_LABEL]: "done" })).toBe("done");
  });

  test("treats absent, empty, or unrecognized values as no claim", () => {
    expect(getCompletionStateFromLabels({})).toBeNull();
    expect(getCompletionStateFromLabels(undefined)).toBeNull();
    expect(getCompletionStateFromLabels({ [COMPLETION_LABEL]: "finished" })).toBeNull();
    expect(getCompletionStateFromLabels({ [COMPLETION_LABEL]: "" })).toBeNull();
    expect(getCompletionStateFromLabels({ [COMPLETION_LABEL]: 1 })).toBeNull();
    expect(getCompletionStateFromLabels(null)).toBeNull();
  });

  test("reads and trims the note", () => {
    expect(getCompletionNoteFromLabels({ [COMPLETION_NOTE_LABEL]: "  PR #41 merged  " })).toBe(
      "PR #41 merged",
    );
  });

  test("treats an absent, blank, or non-string note as no note", () => {
    expect(getCompletionNoteFromLabels(null)).toBeNull();
    expect(getCompletionNoteFromLabels({})).toBeNull();
    expect(getCompletionNoteFromLabels({ [COMPLETION_NOTE_LABEL]: "   " })).toBeNull();
    expect(getCompletionNoteFromLabels({ [COMPLETION_NOTE_LABEL]: 42 })).toBeNull();
  });

  test("caps the note at its maximum length", () => {
    const note = getCompletionNoteFromLabels({
      [COMPLETION_NOTE_LABEL]: "x".repeat(COMPLETION_NOTE_MAX_LENGTH + 50),
    });
    expect(note).toHaveLength(COMPLETION_NOTE_MAX_LENGTH);
  });
});
