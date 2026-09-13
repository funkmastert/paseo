import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  listFinishedAgentsInSubtree,
  selectOrchestrationTree,
  type OrchestrationTreeNode,
} from "./select";
import { useSessionStore, type Agent } from "@/stores/session-store";

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

function buildTree(pendingArchiveIds: ReadonlySet<string> = EMPTY_PENDING_ARCHIVE_IDS) {
  return selectOrchestrationTree(
    useSessionStore.getState(),
    { serverId: SERVER_ID },
    pendingArchiveIds,
  );
}

function findNode(
  nodes: readonly OrchestrationTreeNode[],
  id: string,
): OrchestrationTreeNode | undefined {
  for (const node of nodes) {
    if (node.agent.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("selectOrchestrationTree", () => {
  it("nests grandchildren at depth 2 and beyond", () => {
    setAgents([
      makeAgent({ id: "root" }),
      makeAgent({ id: "child", parentAgentId: "root" }),
      makeAgent({ id: "grandchild", parentAgentId: "child" }),
      makeAgent({ id: "great-grandchild", parentAgentId: "grandchild" }),
    ]);

    const roots = buildTree();

    expect(roots.map((node) => node.agent.id)).toEqual(["root"]);
    expect(roots[0]?.depth).toBe(0);
    const child = roots[0]?.children[0];
    expect(child?.agent.id).toBe("child");
    expect(child?.depth).toBe(1);
    const grandchild = child?.children[0];
    expect(grandchild?.agent.id).toBe("grandchild");
    expect(grandchild?.depth).toBe(2);
    const greatGrandchild = grandchild?.children[0];
    expect(greatGrandchild?.agent.id).toBe("great-grandchild");
    expect(greatGrandchild?.depth).toBe(3);
  });

  it("includes a child living in another workspace under its parent", () => {
    setAgents([
      makeAgent({ id: "root", workspaceId: "workspace-a" }),
      makeAgent({ id: "child", parentAgentId: "root", workspaceId: "workspace-b" }),
    ]);

    const roots = buildTree();

    expect(roots.map((node) => node.agent.id)).toEqual(["root"]);
    expect(roots[0]?.children.map((node) => node.agent.id)).toEqual(["child"]);
  });

  it("excludes archived and pending-archive agents from the tree", () => {
    setAgents([
      makeAgent({ id: "root" }),
      makeAgent({
        id: "archived-child",
        parentAgentId: "root",
        archivedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
      makeAgent({ id: "pending-child", parentAgentId: "root" }),
    ]);

    const roots = buildTree(new Set(["pending-child"]));

    expect(roots.map((node) => node.agent.id)).toEqual(["root"]);
    expect(roots[0]?.children).toEqual([]);
  });

  it("also excludes an archived agent from becoming a root and orphans its children", () => {
    setAgents([
      makeAgent({
        id: "archived-root",
        archivedAt: new Date("2026-03-08T12:00:00.000Z"),
      }),
      makeAgent({ id: "orphan", parentAgentId: "archived-root" }),
    ]);

    const roots = buildTree();

    // The orphan's parent isn't in the live set, so it becomes its own root.
    expect(roots.map((node) => node.agent.id)).toEqual(["orphan"]);
  });

  it("rolls up descendantRequiresAttention for a nested descendant but not for self-only attention", () => {
    setAgents([
      makeAgent({ id: "root" }),
      makeAgent({ id: "child", parentAgentId: "root" }),
      makeAgent({ id: "grandchild", parentAgentId: "child", requiresAttention: true }),
    ]);

    const roots = buildTree();
    const root = roots[0];
    const child = root?.children[0];
    const grandchild = child?.children[0];

    expect(grandchild?.descendantRequiresAttention).toBe(false);
    expect(grandchild?.requiresAttentionInSubtree).toBe(true);
    expect(child?.descendantRequiresAttention).toBe(true);
    expect(child?.requiresAttentionInSubtree).toBe(true);
    expect(root?.descendantRequiresAttention).toBe(true);
    expect(root?.requiresAttentionInSubtree).toBe(true);

    // A node that only requires attention itself (no descendants) has no rolled-up flag.
    expect(root && findNode(root.children, "root")).toBeUndefined();
  });

  it("does not roll up attention when only the node itself requires it", () => {
    setAgents([makeAgent({ id: "root", requiresAttention: true })]);

    const roots = buildTree();
    const root = roots[0];

    expect(root?.descendantRequiresAttention).toBe(false);
    expect(root?.requiresAttentionInSubtree).toBe(true);
  });

  it("terminates instead of looping when agents form a parent-chain cycle", () => {
    setAgents([
      makeAgent({ id: "a", parentAgentId: "b" }),
      makeAgent({ id: "b", parentAgentId: "a" }),
      makeAgent({ id: "root" }),
      makeAgent({ id: "child", parentAgentId: "root" }),
    ]);

    const roots = buildTree();

    // The mutually-parented pair has no live entry point into the tree; only the real
    // root subtree is returned, and the call returns (rather than hanging).
    expect(roots.map((node) => node.agent.id)).toEqual(["root"]);
    expect(roots[0]?.children.map((node) => node.agent.id)).toEqual(["child"]);
  });

  it("terminates when an agent lists itself as its own parent", () => {
    setAgents([makeAgent({ id: "self", parentAgentId: "self" })]);

    const roots = buildTree();

    expect(roots).toEqual([]);
  });

  it("sorts siblings by createdAt ascending", () => {
    setAgents([
      makeAgent({ id: "root" }),
      makeAgent({
        id: "third",
        parentAgentId: "root",
        createdAt: new Date("2026-03-08T10:03:00.000Z"),
      }),
      makeAgent({
        id: "first",
        parentAgentId: "root",
        createdAt: new Date("2026-03-08T10:01:00.000Z"),
      }),
      makeAgent({
        id: "second",
        parentAgentId: "root",
        createdAt: new Date("2026-03-08T10:02:00.000Z"),
      }),
    ]);

    const roots = buildTree();

    expect(roots[0]?.children.map((node) => node.agent.id)).toEqual(["first", "second", "third"]);
  });
});

describe("listFinishedAgentsInSubtree", () => {
  it("returns only idle/error Paseo agents across the whole subtree", () => {
    setAgents([
      makeAgent({ id: "root", status: "idle" }),
      makeAgent({ id: "running-child", parentAgentId: "root", status: "running" }),
      makeAgent({ id: "idle-child", parentAgentId: "root", status: "idle" }),
      makeAgent({
        id: "error-grandchild",
        parentAgentId: "idle-child",
        status: "error",
      }),
      makeAgent({
        id: "running-grandchild",
        parentAgentId: "idle-child",
        status: "running",
      }),
    ]);

    const roots = buildTree();
    const finished = listFinishedAgentsInSubtree(roots[0]!);

    expect(finished.map((agent) => agent.id).sort()).toEqual(
      ["error-grandchild", "idle-child", "root"].sort(),
    );
  });
});
