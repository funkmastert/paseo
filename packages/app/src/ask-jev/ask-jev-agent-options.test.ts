import { describe, expect, it } from "vitest";
import {
  buildPinnedAgentOptions,
  findPinnedWorkspacesMissingAgents,
  selectPinnedWorkspacesForServer,
  type AskJevAgentCandidate,
  type AskJevPinnedWorkspace,
} from "./ask-jev-agent-options";

function workspace(
  input: Partial<AskJevPinnedWorkspace> & { workspaceId: string },
): AskJevPinnedWorkspace {
  return { serverId: "host-1", name: "Chat", ...input };
}

function agent(input: Partial<AskJevAgentCandidate> & { id: string }): AskJevAgentCandidate {
  return { serverId: "host-1", workspaceId: "ws-1", archivedAt: null, title: null, ...input };
}

describe("selectPinnedWorkspacesForServer", () => {
  it("keeps only the pinned chats on the given host", () => {
    const pinned = [
      workspace({ workspaceId: "ws-1", serverId: "host-1" }),
      workspace({ workspaceId: "ws-2", serverId: "host-2" }),
    ];
    expect(selectPinnedWorkspacesForServer(pinned, "host-1")).toEqual([
      workspace({ workspaceId: "ws-1", serverId: "host-1" }),
    ]);
  });

  it("returns nothing when no host is selected", () => {
    expect(selectPinnedWorkspacesForServer([workspace({ workspaceId: "ws-1" })], null)).toEqual([]);
  });
});

describe("buildPinnedAgentOptions", () => {
  it("offers only agents inside a pinned workspace, not every agent on the host", () => {
    const options = buildPinnedAgentOptions({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1", name: "Pinned chat" })],
      agents: [
        agent({ id: "pinned-agent", workspaceId: "ws-1" }),
        agent({ id: "unpinned-agent", workspaceId: "ws-2" }),
      ],
    });
    expect(options).toEqual([{ id: "pinned-agent", label: "Pinned chat" }]);
  });

  it("excludes archived agents even inside a pinned workspace", () => {
    const options = buildPinnedAgentOptions({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1", name: "Pinned chat" })],
      agents: [agent({ id: "dead", workspaceId: "ws-1", archivedAt: new Date(1) })],
    });
    expect(options).toEqual([]);
  });

  it("labels by chat name alone when a pinned workspace has one agent", () => {
    const options = buildPinnedAgentOptions({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1", name: "Fix the bug" })],
      agents: [agent({ id: "solo", workspaceId: "ws-1", title: "Investigate the crash" })],
    });
    expect(options).toEqual([{ id: "solo", label: "Fix the bug" }]);
  });

  it("labels by chat name and agent title when a pinned workspace has several agents", () => {
    const options = buildPinnedAgentOptions({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1", name: "Fix the bug" })],
      agents: [
        agent({ id: "a", workspaceId: "ws-1", title: "Investigate the crash" }),
        agent({ id: "b", workspaceId: "ws-1", title: "" }),
      ],
    });
    expect(options).toEqual([
      { id: "a", label: "Fix the bug — Investigate the crash" },
      { id: "b", label: "Fix the bug — Untitled agent" },
    ]);
  });

  it("only matches an agent on the same host as the pinned workspace", () => {
    const options = buildPinnedAgentOptions({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1", serverId: "host-1" })],
      agents: [agent({ id: "other-host", workspaceId: "ws-1", serverId: "host-2" })],
    });
    expect(options).toEqual([]);
  });
});

describe("findPinnedWorkspacesMissingAgents", () => {
  it("names a pinned workspace with no live agent in the loaded set", () => {
    const missing = findPinnedWorkspacesMissingAgents({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1" }), workspace({ workspaceId: "ws-2" })],
      agents: [agent({ id: "a", workspaceId: "ws-1" })],
    });
    expect(missing).toEqual(["ws-2"]);
  });

  it("treats a pinned workspace whose only agent is archived as missing", () => {
    const missing = findPinnedWorkspacesMissingAgents({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a", workspaceId: "ws-1", archivedAt: new Date(1) })],
    });
    expect(missing).toEqual(["ws-1"]);
  });

  it("reports nothing missing once every pinned workspace has a live agent", () => {
    const missing = findPinnedWorkspacesMissingAgents({
      pinnedWorkspaces: [workspace({ workspaceId: "ws-1" })],
      agents: [agent({ id: "a", workspaceId: "ws-1" })],
    });
    expect(missing).toEqual([]);
  });
});
