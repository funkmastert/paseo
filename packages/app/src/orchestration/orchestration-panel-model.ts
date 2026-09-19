import { toSubagentRow } from "@/subagents/select";
import type {
  HostRuntimeAgentDirectoryStatus,
  HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { listFinishedAgentsInSubtree, type OrchestrationTreeNode } from "./select";

export interface OrchestrationFlatRow {
  agent: Agent;
  /** 0 for a root, incrementing by one per generation below it — mirrors the source node's depth. */
  depth: number;
  /** True when any strict descendant of this row requires attention (the rollup indicator). */
  descendantRequiresAttention: boolean;
}

/**
 * Depth-first pre-order flatten of the tree for a virtualized list: a node always appears
 * immediately before its children, so indentation reads as nesting without a separate tree widget.
 */
export function flattenOrchestrationTree(
  roots: readonly OrchestrationTreeNode[],
): OrchestrationFlatRow[] {
  const rows: OrchestrationFlatRow[] = [];
  const visit = (node: OrchestrationTreeNode) => {
    rows.push({
      agent: node.agent,
      depth: node.depth,
      descendantRequiresAttention: node.descendantRequiresAttention,
    });
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return rows;
}

/** Distinct providers across every root's subtree, first-seen order — the budget strip's input. */
export function collectOrchestrationProviderIds(roots: readonly OrchestrationTreeNode[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const visit = (node: OrchestrationTreeNode) => {
    if (!seen.has(node.agent.provider)) {
      seen.add(node.agent.provider);
      ids.push(node.agent.provider);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return ids;
}

/** Whether the tab affordance (panel tab, track-bar pill) should show its attention mark. */
export function resolveOrchestrationTreeAttention(
  roots: readonly OrchestrationTreeNode[],
): boolean {
  return roots.some((root) => root.requiresAttentionInSubtree);
}

/** Depth-first search for the node representing `agentId`, or null if it isn't in the tree. */
export function findOrchestrationNode(
  nodes: readonly OrchestrationTreeNode[],
  agentId: string,
): OrchestrationTreeNode | null {
  for (const node of nodes) {
    if (node.agent.id === agentId) return node;
    const found = findOrchestrationNode(node.children, agentId);
    if (found) return found;
  }
  return null;
}

/**
 * Every finished agent across every root's descendants — the header's "Archive finished" bulk
 * set. Roots are excluded: a root is a tree leader, and archiving a finished leader is not the
 * same action as archiving its finished subagents.
 */
export function collectFinishedAgentsAcrossRoots(roots: readonly OrchestrationTreeNode[]): Agent[] {
  return roots.flatMap((root) => root.children.flatMap(listFinishedAgentsInSubtree));
}

/** A row opens the agent panel for its own agent — the payload the open-target helper expects. */
export function buildOrchestrationRowOpenTarget(agent: Agent): WorkspaceTabTarget {
  return { kind: "agent", agentId: agent.id };
}

/**
 * What pressing a row should do: open its tab target in the current workspace, or navigate to a
 * different workspace entirely (a child agent can live in a workspace other than its parent's).
 */
export type OrchestrationRowOpenAction =
  | { kind: "same-workspace"; target: WorkspaceTabTarget }
  | { kind: "cross-workspace"; workspaceId: string };

/** Decides which of the two open actions a row press should take, for `handleOpenAgent` to run. */
export function resolveOrchestrationRowOpenAction(
  agent: Agent,
  currentWorkspaceId: string,
): OrchestrationRowOpenAction {
  if (agent.workspaceId && agent.workspaceId !== currentWorkspaceId) {
    return { kind: "cross-workspace", workspaceId: agent.workspaceId };
  }
  return { kind: "same-workspace", target: buildOrchestrationRowOpenTarget(agent) };
}

/**
 * Groups agents by immediate parent for the bulk archive loop: `runArchiveFinished`'s liveness
 * check compares a row's live `parentAgentId` against one expected value, so a mixed set spanning
 * several parents (and true roots, whose `parentAgentId` is null) has to run one group at a time.
 */
export function groupAgentsByParent(agents: readonly Agent[]): Map<string | null, Agent[]> {
  const groups = new Map<string | null, Agent[]>();
  for (const agent of agents) {
    const key = agent.parentAgentId;
    const bucket = groups.get(key);
    if (bucket) bucket.push(agent);
    else groups.set(key, [agent]);
  }
  return groups;
}

/** Adapts an Agent into the row shape `runArchiveFinished` reads — the shared adapter from subagents/select.ts. */
export const toOrchestrationArchiveRow = toSubagentRow;

/**
 * Whether what the panel is rendering is actually being kept current.
 *
 * The tree is a replica: it keeps its last contents when the socket drops, so a disconnected
 * panel looks exactly like a connected one whose agents happen not to have moved. On a machine
 * where connections drop routinely that is the whole of "the status seems out of date" — the
 * rows are not wrong, they are just frozen, and nothing on screen says so.
 */
export type OrchestrationFreshness =
  | { kind: "live" }
  /** A refresh is in flight, or the host is still connecting. Resolves on its own; say nothing. */
  | { kind: "syncing" }
  /** The rows on screen are the last known state and nothing is updating them. */
  | { kind: "stale" };

export function resolveOrchestrationFreshness(input: {
  connectionStatus: HostRuntimeConnectionStatus;
  directoryStatus: HostRuntimeAgentDirectoryStatus;
}): OrchestrationFreshness {
  if (input.connectionStatus === "connecting") return { kind: "syncing" };
  if (input.connectionStatus !== "online") return { kind: "stale" };
  switch (input.directoryStatus) {
    case "initial_loading":
    case "revalidating":
      return { kind: "syncing" };
    // A refresh that failed after a good one leaves the replica populated but unattended: the
    // socket is up, so nothing will retry until something else asks.
    case "error_after_ready":
    case "error_before_first_success":
      return { kind: "stale" };
    default:
      return { kind: "live" };
  }
}
