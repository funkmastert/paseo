import { describe, expect, it } from "vitest";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  selectBroadcastPinnedLeaderTargets,
  type BroadcastPinnedAgentCandidate,
  type BroadcastPinnedWorkspace,
} from "./broadcast-pinned-targets";

function workspace(
  input: Partial<BroadcastPinnedWorkspace> & { workspaceId: string },
): BroadcastPinnedWorkspace {
  return { serverId: "host-1", name: "Chat", currentBranch: null, ...input };
}

function agent(
  input: Partial<BroadcastPinnedAgentCandidate> & { id: string; movedTo?: string },
): BroadcastPinnedAgentCandidate {
  const labels: Record<string, string> = { ...input.labels };
  if (input.movedTo) {
    labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL] = input.movedTo;
  }
  return {
    serverId: "host-1",
    workspaceId: "ws-1",
    parentAgentId: null,
    archivedAt: null,
    lastActivityAt: new Date(0),
    createdAt: new Date(0),
    status: "idle",
    title: "Leader",
    ...input,
    labels,
  };
}

function selectTargets(input: {
  pinnedChats: readonly BroadcastPinnedWorkspace[];
  agents: readonly BroadcastPinnedAgentCandidate[];
  workspaceTitleSource?: "title" | "branch";
}) {
  return selectBroadcastPinnedLeaderTargets({
    workspaceTitleSource: "title",
    ...input,
  });
}

describe("selectBroadcastPinnedLeaderTargets", () => {
  it("includes the single root agent in a pinned workspace", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1", name: "Pinned chat" })],
      agents: [agent({ id: "a1" })],
    });
    expect(targets).toEqual([
      {
        id: "a1",
        serverId: "host-1",
        workspaceId: "ws-1",
        workspaceName: "Pinned chat",
        label: "Pinned chat",
        agentTitle: "Leader",
        status: "idle",
      },
    ]);
  });

  it("labels the row with the workspace's current name, not the agent's title, after a rename", () => {
    // Renaming a pinned workspace updates its `name` but leaves the agent's own `title`
    // (a conversation topic set independently) untouched — the row must track the workspace.
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1", name: "Renamed workspace" })],
      agents: [agent({ id: "a1", title: "Original agent title" })],
    });
    expect(targets[0]?.label).toBe("Renamed workspace");
    expect(targets[0]?.agentTitle).toBe("Original agent title");
  });

  it("labels the row with the branch when workspaceTitleSource is 'branch', matching the sidebar", () => {
    const targets = selectTargets({
      pinnedChats: [
        workspace({ workspaceId: "ws-1", name: "Workspace name", currentBranch: "feature/x" }),
      ],
      agents: [agent({ id: "a1", title: "Agent title" })],
      workspaceTitleSource: "branch",
    });
    expect(targets[0]?.label).toBe("feature/x");
  });

  it("falls back to the workspace name when workspaceTitleSource is 'branch' but there is no branch", () => {
    const targets = selectTargets({
      pinnedChats: [
        workspace({ workspaceId: "ws-1", name: "Workspace name", currentBranch: null }),
      ],
      agents: [agent({ id: "a1" })],
      workspaceTitleSource: "branch",
    });
    expect(targets[0]?.label).toBe("Workspace name");
  });

  it("picks only the grid's chosen agent when a pinned workspace holds two root agents", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [
        agent({ id: "stale", lastActivityAt: new Date(10) }),
        agent({ id: "active", lastActivityAt: new Date(30), title: "Most recent" }),
      ],
    });
    expect(targets.map((t) => t.id)).toEqual(["active"]);
  });

  it("targets the live successor of an agent account failover retired", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [
        agent({ id: "retired", lastActivityAt: new Date(30), movedTo: "successor" }),
        agent({ id: "successor", lastActivityAt: new Date(10), title: "Live end" }),
      ],
    });
    expect(targets).toEqual([
      {
        id: "successor",
        serverId: "host-1",
        workspaceId: "ws-1",
        workspaceName: "Chat",
        label: "Chat",
        agentTitle: "Live end",
        status: "idle",
      },
    ]);
  });

  it("excludes a child agent even though its workspace is pinned", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "child", parentAgentId: "root-1" })],
    });
    expect(targets).toEqual([]);
  });

  it("excludes an archived root agent with no other live agent in the workspace", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a1", archivedAt: new Date() })],
    });
    expect(targets).toEqual([]);
  });

  it("still targets a closed-but-not-archived agent, matching what the grid cell shows", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a1", status: "closed" })],
    });
    expect(targets.map((t) => t.id)).toEqual(["a1"]);
  });

  it("excludes an agent whose workspace is not pinned", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-other" })],
      agents: [agent({ id: "a1", workspaceId: "ws-1" })],
    });
    expect(targets).toEqual([]);
  });

  it("returns one target per pinned workspace, scoped by server", () => {
    const targets = selectTargets({
      pinnedChats: [
        workspace({ workspaceId: "ws-1", serverId: "host-1", name: "First" }),
        workspace({ workspaceId: "ws-1", serverId: "host-2", name: "Second" }),
      ],
      agents: [agent({ id: "a1", serverId: "host-1" }), agent({ id: "a2", serverId: "host-2" })],
    });
    expect(targets.map((t) => t.id).sort()).toEqual(["a1", "a2"]);
  });

  it("reports a null agentTitle when the agent has no title", () => {
    const targets = selectTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a1", title: null })],
    });
    expect(targets[0]?.agentTitle).toBeNull();
    expect(targets[0]?.label).toBe("Chat");
  });

  it("returns an empty list for empty inputs without throwing", () => {
    expect(selectTargets({ pinnedChats: [], agents: [] })).toEqual([]);
    expect(
      selectTargets({
        pinnedChats: [workspace({ workspaceId: "ws-1" })],
        agents: [],
      }),
    ).toEqual([]);
  });
});
