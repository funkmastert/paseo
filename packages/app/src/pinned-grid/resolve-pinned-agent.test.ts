import { describe, expect, it } from "vitest";
import { pickPinnedWorkspaceAgentId } from "./resolve-pinned-agent";

function agent(input: {
  id: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  lastActivityAt?: number;
  createdAt?: number;
}) {
  return {
    id: input.id,
    workspaceId: input.workspaceId ?? "ws-1",
    parentAgentId: input.parentAgentId ?? null,
    archivedAt: input.archivedAt ?? null,
    lastActivityAt: new Date(input.lastActivityAt ?? 0),
    createdAt: new Date(input.createdAt ?? 0),
  };
}

describe("pickPinnedWorkspaceAgentId", () => {
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
