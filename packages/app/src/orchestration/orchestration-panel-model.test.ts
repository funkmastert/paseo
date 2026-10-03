import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  buildOrchestrationRowOpenTarget,
  collectFinishedAgentsAcrossRoots,
  findOrchestrationNode,
  flattenOrchestrationTree,
  groupAgentsByParent,
  resolveOrchestrationRowOpenAction,
  resolveOrchestrationTreeAttention,
  toOrchestrationArchiveRow,
} from "./orchestration-panel-model";
import { selectOrchestrationTree } from "./select";

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");
const EMPTY_PENDING_ARCHIVE_IDS = new Set<string>();

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function setAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

function buildTree() {
  return selectOrchestrationTree(
    useSessionStore.getState(),
    { serverId: SERVER_ID },
    EMPTY_PENDING_ARCHIVE_IDS,
  );
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("flattenOrchestrationTree", () => {
  it("preserves depth and pre-order (parent before children) across multiple roots", () => {
    setAgents([
      makeAgent({ id: "root-a", createdAt: new Date("2026-03-08T10:00:00.000Z") }),
      makeAgent({
        id: "root-a-child",
        parentAgentId: "root-a",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      }),
      makeAgent({ id: "root-b", createdAt: new Date("2026-03-08T10:02:00.000Z") }),
    ]);

    const rows = flattenOrchestrationTree(buildTree());

    expect(rows.map((row) => [row.agent.id, row.depth])).toEqual([
      ["root-a", 0],
      ["root-a-child", 1],
      ["root-b", 0],
    ]);
  });
});

describe("resolveOrchestrationTreeAttention", () => {
  it("is true when any root's subtree requires attention", () => {
    setAgents([
      makeAgent({ id: "root-a" }),
      makeAgent({ id: "root-b" }),
      makeAgent({ id: "child-b", parentAgentId: "root-b", requiresAttention: true }),
    ]);

    expect(resolveOrchestrationTreeAttention(buildTree())).toBe(true);
  });

  it("is false when nothing in any subtree requires attention", () => {
    setAgents([makeAgent({ id: "root-a" }), makeAgent({ id: "root-b" })]);

    expect(resolveOrchestrationTreeAttention(buildTree())).toBe(false);
  });
});

describe("findOrchestrationNode", () => {
  it("locates a nested node by agent id", () => {
    setAgents([
      makeAgent({ id: "root" }),
      makeAgent({ id: "child", parentAgentId: "root" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
    ]);

    const found = findOrchestrationNode(buildTree(), "grandchild");

    expect(found?.agent.id).toBe("grandchild");
    expect(found?.depth).toBe(2);
  });

  it("returns null when the agent isn't in the tree", () => {
    setAgents([makeAgent({ id: "root" })]);

    expect(findOrchestrationNode(buildTree(), "missing")).toBeNull();
  });
});

describe("collectFinishedAgentsAcrossRoots", () => {
  it("aggregates finished descendants across every root, excluding the roots themselves", () => {
    setAgents([
      makeAgent({ id: "root-a", status: "idle" }),
      makeAgent({ id: "child-a", parentAgentId: "root-a", status: "idle" }),
      makeAgent({ id: "root-b", status: "idle" }),
      makeAgent({ id: "child-b", parentAgentId: "root-b", status: "idle" }),
      makeAgent({ id: "grandchild-b", parentAgentId: "child-b", status: "running" }),
    ]);

    const finished = collectFinishedAgentsAcrossRoots(buildTree());

    expect(finished.map((agent) => agent.id).sort()).toEqual(["child-a", "child-b"].sort());
  });
});

describe("buildOrchestrationRowOpenTarget", () => {
  it("opens the agent panel kind for the row's own agent", () => {
    const agent = makeAgent({ id: "agent-1" });

    expect(buildOrchestrationRowOpenTarget(agent)).toEqual({ kind: "agent", agentId: "agent-1" });
  });
});

describe("resolveOrchestrationRowOpenAction", () => {
  it("opens in the current workspace when the agent has no workspaceId or matches it", () => {
    const agent = makeAgent({ id: "agent-1", workspaceId: "workspace-1" });

    expect(resolveOrchestrationRowOpenAction(agent, "workspace-1")).toEqual({
      kind: "same-workspace",
      target: { kind: "agent", agentId: "agent-1" },
    });
    expect(resolveOrchestrationRowOpenAction(makeAgent({ id: "agent-2" }), "workspace-1")).toEqual({
      kind: "same-workspace",
      target: { kind: "agent", agentId: "agent-2" },
    });
  });

  it("navigates to the agent's own workspace when it differs from the current one", () => {
    const agent = makeAgent({ id: "agent-1", workspaceId: "workspace-2" });

    expect(resolveOrchestrationRowOpenAction(agent, "workspace-1")).toEqual({
      kind: "cross-workspace",
      workspaceId: "workspace-2",
    });
  });
});

describe("groupAgentsByParent", () => {
  it("groups true roots under a null key and nested agents under their immediate parent", () => {
    const root = makeAgent({ id: "root", parentAgentId: null });
    const child = makeAgent({ id: "child", parentAgentId: "root" });
    const otherRoot = makeAgent({ id: "other-root", parentAgentId: null });

    const groups = groupAgentsByParent([root, child, otherRoot]);

    expect(
      groups
        .get(null)
        ?.map((agent) => agent.id)
        .sort(),
    ).toEqual(["other-root", "root"]);
    expect(groups.get("root")?.map((agent) => agent.id)).toEqual(["child"]);
  });
});

describe("toOrchestrationArchiveRow", () => {
  it("carries the fields the shared archive loop reads", () => {
    const agent = makeAgent({
      id: "agent-1",
      status: "idle",
      requiresAttention: true,
      lastActivitySummary: "Reviewing diff",
    });

    expect(toOrchestrationArchiveRow(agent)).toMatchObject({
      kind: "paseo",
      id: "agent-1",
      status: "idle",
      requiresAttention: true,
      subtitle: "Reviewing diff",
    });
  });
});
