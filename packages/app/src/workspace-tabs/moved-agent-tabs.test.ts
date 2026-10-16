import { describe, expect, it } from "vitest";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import { decideMovedAgentTabActions, planMovedAgentTabs } from "@/workspace-tabs/moved-agent-tabs";
import type { WorkspaceTab } from "@/workspace-tabs/model";

function agentTab(tabId: string, agentId: string): WorkspaceTab {
  return { tabId, target: { kind: "agent", agentId }, createdAt: 1 };
}

const held = new Map([
  ["live", { workspaceId: "ws-1", labels: {} }],
  ["retired", { workspaceId: "ws-1", labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "live" } }],
  ["moved-away", { workspaceId: "ws-1", labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "far" } }],
  ["far", { workspaceId: "ws-2", labels: {} }],
  ["stranded", { workspaceId: "ws-1", labels: { [ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]: "gone" } }],
]);
const lookup = (agentId: string) => held.get(agentId);

describe("planMovedAgentTabs", () => {
  it("leaves tabs on live agents and on other kinds alone", () => {
    expect(
      planMovedAgentTabs({
        tabs: [
          agentTab("t1", "live"),
          { tabId: "t2", target: { kind: "working_diff" }, createdAt: 1 },
        ],
        workspaceId: "ws-1",
        lookup,
      }),
    ).toEqual([]);
  });

  it("follows a retired handle to a successor in the same workspace", () => {
    expect(
      planMovedAgentTabs({ tabs: [agentTab("t1", "retired")], workspaceId: "ws-1", lookup }),
    ).toEqual([{ kind: "retarget", tabId: "t1", fromAgentId: "retired", toAgentId: "live" }]);
  });

  it("sends a handle whose successor lives in another workspace there", () => {
    expect(
      planMovedAgentTabs({ tabs: [agentTab("t1", "moved-away")], workspaceId: "ws-1", lookup }),
    ).toEqual([{ kind: "navigate", tabId: "t1", fromAgentId: "moved-away", toAgentId: "far" }]);
  });

  it("keeps a stranded handle and names where it went", () => {
    expect(
      planMovedAgentTabs({ tabs: [agentTab("t1", "stranded")], workspaceId: "ws-1", lookup }),
    ).toEqual([{ kind: "stranded", tabId: "t1", fromAgentId: "stranded", movedToAgentId: "gone" }]);
  });
});

describe("decideMovedAgentTabActions", () => {
  const retarget = {
    kind: "retarget",
    tabId: "t1",
    fromAgentId: "retired",
    toAgentId: "live",
  } as const;
  const navigate = {
    kind: "navigate",
    tabId: "t2",
    fromAgentId: "moved-away",
    toAgentId: "far",
  } as const;
  const stranded = {
    kind: "stranded",
    tabId: "t3",
    fromAgentId: "stranded",
    movedToAgentId: "gone",
  } as const;
  const ready = {
    routeFocused: true,
    layoutHydrated: true,
    workspaceKey: "ws-key",
    notedStrandedAgentIds: new Set<string>(),
  };

  it("does nothing while the workspace is not in view or its layout has not hydrated", () => {
    const steps = [retarget, navigate, stranded];
    for (const gate of [
      { routeFocused: false },
      { layoutHydrated: false },
      { workspaceKey: null },
    ]) {
      expect(decideMovedAgentTabActions({ ...ready, ...gate, steps, focusedTabId: "t1" })).toEqual(
        [],
      );
    }
  });

  it("retargets a background tab and carries its draft without a note", () => {
    expect(
      decideMovedAgentTabActions({ ...ready, steps: [retarget], focusedTabId: "other" }),
    ).toEqual([
      { kind: "moveDraft", fromAgentId: "retired", toAgentId: "live" },
      { kind: "follow", workspaceKey: "ws-key", fromAgentId: "retired", toAgentId: "live" },
    ]);
  });

  it("notes the move when the retargeted tab is the one in view", () => {
    expect(decideMovedAgentTabActions({ ...ready, steps: [retarget], focusedTabId: "t1" })).toEqual(
      [
        { kind: "moveDraft", fromAgentId: "retired", toAgentId: "live" },
        { kind: "follow", workspaceKey: "ws-key", fromAgentId: "retired", toAgentId: "live" },
        { kind: "announce", agentId: "live" },
      ],
    );
  });

  it("leaves for another workspace only from the tab in view", () => {
    expect(
      decideMovedAgentTabActions({ ...ready, steps: [navigate], focusedTabId: "other" }),
    ).toEqual([]);
    expect(decideMovedAgentTabActions({ ...ready, steps: [navigate], focusedTabId: "t2" })).toEqual(
      [
        { kind: "moveDraft", fromAgentId: "moved-away", toAgentId: "far" },
        { kind: "closeTab", workspaceKey: "ws-key", tabId: "t2" },
        { kind: "navigateToAgent", agentId: "far" },
        { kind: "announce", agentId: "far" },
      ],
    );
  });

  it("names where a stranded handle went once, and only while it is in view", () => {
    expect(
      decideMovedAgentTabActions({ ...ready, steps: [stranded], focusedTabId: "other" }),
    ).toEqual([]);
    expect(decideMovedAgentTabActions({ ...ready, steps: [stranded], focusedTabId: "t3" })).toEqual(
      [
        { kind: "noteStranded", agentId: "stranded" },
        { kind: "announce", agentId: "gone" },
      ],
    );
    expect(
      decideMovedAgentTabActions({
        ...ready,
        notedStrandedAgentIds: new Set(["stranded"]),
        steps: [stranded],
        focusedTabId: "t3",
      }),
    ).toEqual([]);
  });
});
