import { describe, expect, it } from "vitest";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import { pickPinnedWorkspaceAgentId, pickPinnedWorkspaceAgents } from "./resolve-pinned-agent";

function agent(input: {
  id: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  lastActivityAt?: number;
  createdAt?: number;
  movedTo?: string;
}) {
  const labels: Record<string, string> = {};
  if (input.movedTo) {
    labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL] = input.movedTo;
  }
  return {
    id: input.id,
    workspaceId: input.workspaceId ?? "ws-1",
    parentAgentId: input.parentAgentId ?? null,
    archivedAt: input.archivedAt ?? null,
    lastActivityAt: new Date(input.lastActivityAt ?? 0),
    createdAt: new Date(input.createdAt ?? 0),
    labels,
  };
}

describe("pickPinnedWorkspaceAgentId", () => {
  it("shows the live end of a conversation account failover moved", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [
        agent({ id: "retired", lastActivityAt: 30, movedTo: "successor" }),
        agent({ id: "successor", lastActivityAt: 10 }),
        agent({ id: "other", lastActivityAt: 20 }),
      ],
      workspaceId: "ws-1",
    });
    expect(id).toBe("successor");
  });

  it("does not show a successor that lives in another workspace", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [
        agent({ id: "retired", lastActivityAt: 30, movedTo: "elsewhere" }),
        agent({ id: "elsewhere", workspaceId: "ws-2", lastActivityAt: 40 }),
        agent({ id: "local", lastActivityAt: 10 }),
      ],
      workspaceId: "ws-1",
    });
    expect(id).toBe("local");
  });

  it("does not show an archived successor", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [
        agent({ id: "retired", lastActivityAt: 30, movedTo: "archived" }),
        agent({ id: "archived", archivedAt: new Date(1), lastActivityAt: 40 }),
        agent({ id: "local", lastActivityAt: 10 }),
      ],
      workspaceId: "ws-1",
    });
    expect(id).toBe("local");
  });

  it("ranks a moved conversation by the most recent activity of any of its handles", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [
        agent({ id: "retired", lastActivityAt: 50, movedTo: "successor" }),
        agent({ id: "successor", lastActivityAt: 5 }),
        agent({ id: "other", lastActivityAt: 20, createdAt: 0 }),
      ],
      workspaceId: "ws-1",
    });
    expect(id).toBe("successor");
  });

  it("keeps a handle whose successor this host does not list", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [agent({ id: "retired", lastActivityAt: 30, movedTo: "gone" })],
      workspaceId: "ws-1",
    });
    expect(id).toBe("retired");
  });

  it("picks the most recently active agent in the workspace", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [
        agent({ id: "old", lastActivityAt: 10 }),
        agent({ id: "new", lastActivityAt: 30 }),
        agent({ id: "mid", lastActivityAt: 20 }),
      ],
      workspaceId: "ws-1",
    });
    expect(id).toBe("new");
  });

  it("ignores other workspaces, archived agents and subagents", () => {
    const id = pickPinnedWorkspaceAgentId({
      agents: [
        agent({ id: "other", workspaceId: "ws-2", lastActivityAt: 90 }),
        agent({ id: "archived", archivedAt: new Date(1), lastActivityAt: 80 }),
        agent({ id: "leader", lastActivityAt: 10 }),
        agent({ id: "child", parentAgentId: "leader", lastActivityAt: 70 }),
      ],
      workspaceId: "ws-1",
    });
    expect(id).toBe("leader");
  });

  it("returns null when the workspace has no live chat", () => {
    expect(
      pickPinnedWorkspaceAgentId({
        agents: [agent({ id: "archived", archivedAt: new Date(1) })],
        workspaceId: "ws-1",
      }),
    ).toBeNull();
    expect(pickPinnedWorkspaceAgentId({ agents: [], workspaceId: "ws-1" })).toBeNull();
  });
});

describe("pickPinnedWorkspaceAgents", () => {
  it("picks for every workspace what the single-workspace pick returns", () => {
    const agents = [
      agent({ id: "retired", lastActivityAt: 50, movedTo: "successor" }),
      agent({ id: "successor", lastActivityAt: 5 }),
      agent({ id: "other", lastActivityAt: 20 }),
      agent({ id: "ws2-old", workspaceId: "ws-2", lastActivityAt: 10 }),
      agent({ id: "ws2-new", workspaceId: "ws-2", lastActivityAt: 30 }),
      agent({ id: "ws2-child", workspaceId: "ws-2", parentAgentId: "ws2-new", lastActivityAt: 90 }),
      agent({ id: "ws3-archived", workspaceId: "ws-3", archivedAt: new Date(1) }),
      agent({ id: "ws4-retired", workspaceId: "ws-4", lastActivityAt: 30, movedTo: "ws5-live" }),
      agent({ id: "ws5-live", workspaceId: "ws-5", lastActivityAt: 10 }),
    ];

    const picked = new Map(
      [...pickPinnedWorkspaceAgents(new Map(agents.map((a) => [a.id, a])))].map(
        ([workspaceId, liveEnd]) => [workspaceId, liveEnd.id],
      ),
    );

    expect(picked).toEqual(
      new Map([
        ["ws-1", "successor"],
        ["ws-2", "ws2-new"],
        ["ws-5", "ws5-live"],
      ]),
    );
    for (const workspaceId of ["ws-1", "ws-2", "ws-3", "ws-4", "ws-5"]) {
      expect(picked.get(workspaceId) ?? null).toBe(
        pickPinnedWorkspaceAgentId({ agents, workspaceId }),
      );
    }
  });
});
