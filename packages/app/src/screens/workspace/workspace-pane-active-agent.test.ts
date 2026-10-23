import { describe, expect, it } from "vitest";
import { selectActivePaneAgentId } from "./workspace-pane-active-agent";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

function tabItem(
  target: WorkspaceTabDescriptor["target"],
  isActive: boolean,
): { tab: WorkspaceTabDescriptor; isActive: boolean } {
  return {
    tab: { key: target.kind, tabId: target.kind, kind: target.kind, target },
    isActive,
  };
}

describe("selectActivePaneAgentId", () => {
  it("returns the active tab's agent id when the active tab is an agent", () => {
    const tabs = [
      tabItem({ kind: "files" }, false),
      tabItem({ kind: "agent", agentId: "agent-123" }, true),
    ];
    expect(selectActivePaneAgentId(tabs)).toBe("agent-123");
  });

  it("returns null when the active tab is not an agent", () => {
    const tabs = [
      tabItem({ kind: "agent", agentId: "agent-123" }, false),
      tabItem({ kind: "files" }, true),
    ];
    expect(selectActivePaneAgentId(tabs)).toBeNull();
  });

  it("returns null when no tab is active", () => {
    const tabs = [
      tabItem({ kind: "agent", agentId: "agent-123" }, false),
      tabItem({ kind: "files" }, false),
    ];
    expect(selectActivePaneAgentId(tabs)).toBeNull();
  });

  it("returns null for an empty tab list", () => {
    expect(selectActivePaneAgentId([])).toBeNull();
  });
});
