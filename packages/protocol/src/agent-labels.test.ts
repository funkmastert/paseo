import { describe, expect, test } from "vitest";
import {
  ACCOUNT_FAILOVER_MIGRATED_TO_LABEL,
  followMigratedTo,
  getMigratedToFromLabels,
  getParentAgentIdFromLabels,
  getOpenAgentTabLabel,
  hasOpenAgentTab,
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
