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
  return { serverId: "host-1", name: "Chat", ...input };
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

describe("selectBroadcastPinnedLeaderTargets", () => {
  it("includes the single root agent in a pinned workspace", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1", name: "Pinned chat" })],
      agents: [agent({ id: "a1" })],
    });
    expect(targets).toEqual([
      {
        id: "a1",
        serverId: "host-1",
        workspaceId: "ws-1",
        workspaceName: "Pinned chat",
        label: "Leader",
        status: "idle",
      },
    ]);
  });

  it("picks only the grid's chosen agent when a pinned workspace holds two root agents", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [
        agent({ id: "stale", lastActivityAt: new Date(10) }),
        agent({ id: "active", lastActivityAt: new Date(30), title: "Most recent" }),
      ],
    });
    expect(targets.map((t) => t.id)).toEqual(["active"]);
  });

  it("targets the live successor of an agent account failover retired", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
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
        label: "Live end",
        status: "idle",
      },
    ]);
  });

  it("excludes a child agent even though its workspace is pinned", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "child", parentAgentId: "root-1" })],
    });
    expect(targets).toEqual([]);
  });

  it("excludes an archived root agent with no other live agent in the workspace", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a1", archivedAt: new Date() })],
    });
    expect(targets).toEqual([]);
  });

  it("still targets a closed-but-not-archived agent, matching what the grid cell shows", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a1", status: "closed" })],
    });
    expect(targets.map((t) => t.id)).toEqual(["a1"]);
  });

  it("excludes an agent whose workspace is not pinned", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-other" })],
      agents: [agent({ id: "a1", workspaceId: "ws-1" })],
    });
    expect(targets).toEqual([]);
  });

  it("returns one target per pinned workspace, scoped by server", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [
        workspace({ workspaceId: "ws-1", serverId: "host-1", name: "First" }),
        workspace({ workspaceId: "ws-1", serverId: "host-2", name: "Second" }),
      ],
      agents: [agent({ id: "a1", serverId: "host-1" }), agent({ id: "a2", serverId: "host-2" })],
    });
    expect(targets.map((t) => t.id).sort()).toEqual(["a1", "a2"]);
  });

  it("falls back to 'Untitled agent' when the agent has no title", () => {
    const targets = selectBroadcastPinnedLeaderTargets({
      pinnedChats: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a1", title: null })],
    });
    expect(targets[0]?.label).toBe("Untitled agent");
  });

  it("returns an empty list for empty inputs without throwing", () => {
    expect(selectBroadcastPinnedLeaderTargets({ pinnedChats: [], agents: [] })).toEqual([]);
    expect(
      selectBroadcastPinnedLeaderTargets({
        pinnedChats: [workspace({ workspaceId: "ws-1" })],
        agents: [],
      }),
    ).toEqual([]);
  });
});
