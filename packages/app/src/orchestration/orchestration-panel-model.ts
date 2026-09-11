import type { PaseoSubagentRow } from "@/subagents/select";
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

/** Every finished agent across every root's subtree — the header's "Archive finished" bulk set. */
export function collectFinishedAgentsAcrossRoots(roots: readonly OrchestrationTreeNode[]): Agent[] {
  return roots.flatMap((root) => listFinishedAgentsInSubtree(root));
}

/** A row opens the agent panel for its own agent — the payload the open-target helper expects. */
export function buildOrchestrationRowOpenTarget(agent: Agent): WorkspaceTabTarget {
  return { kind: "agent", agentId: agent.id };
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

/** Adapts an Agent into the row shape `runArchiveFinished` reads, mirroring select.ts's own. */
export function toOrchestrationArchiveRow(agent: Agent): PaseoSubagentRow {
  return {
    kind: "paseo",
    id: agent.id,
    provider: agent.provider,
    title: agent.title,
    description: null,
    subtitle: agent.lastActivitySummary ?? null,
    status: agent.status,
    turn: agent.turn,
    requiresAttention: agent.requiresAttention ?? false,
    createdAt: agent.createdAt,
  };
}
