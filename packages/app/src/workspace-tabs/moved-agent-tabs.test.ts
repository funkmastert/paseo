import { describe, expect, it } from "vitest";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import { planMovedAgentTabs } from "@/workspace-tabs/moved-agent-tabs";
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
