import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { isFinishedSubagent } from "@/subagents/archive-finished";
import type { PaseoSubagentRow } from "@/subagents/select";
import { useSessionStore, type Agent } from "@/stores/session-store";

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

export interface SelectOrchestrationTreeParams {
  serverId: string;
}

export interface OrchestrationTreeNode {
  agent: Agent;
  children: OrchestrationTreeNode[];
  /** 0 for a root, incrementing by one per generation below it. */
  depth: number;
  /** True when any strict descendant (not this node itself) requires attention. */
  descendantRequiresAttention: boolean;
  /** True when this node or any descendant requires attention. */
  requiresAttentionInSubtree: boolean;
}

const EMPTY_ORCHESTRATION_ROOTS: OrchestrationTreeNode[] = [];

function byCreatedAt(left: Agent, right: Agent): number {
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/**
 * Roots and full recursive descendant trees for a server, assembled from the live (non-archived,
 * non-pending-archive) agents in the session store. Spans every workspace on the server — a child
 * living in a different workspace than its parent still nests under it. A root is any live agent
 * whose parent is absent or itself not live (archived, pending-archive, or on another server).
 */
export function selectOrchestrationTree(
  state: SessionStoreSnapshot,
  params: SelectOrchestrationTreeParams,
  pendingArchiveIds: ReadonlySet<string>,
): OrchestrationTreeNode[] {
  const agents = state.sessions[params.serverId]?.agents;
  if (!agents || agents.size === 0) {
    return EMPTY_ORCHESTRATION_ROOTS;
  }

  const liveAgents = new Map<string, Agent>();
  for (const agent of agents.values()) {
    if (agent.archivedAt || pendingArchiveIds.has(agent.id)) continue;
    liveAgents.set(agent.id, agent);
  }
  if (liveAgents.size === 0) {
    return EMPTY_ORCHESTRATION_ROOTS;
  }

  const childrenByParentId = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of liveAgents.values()) {
    const parentId = agent.parentAgentId;
    if (!parentId || !liveAgents.has(parentId)) {
      roots.push(agent);
      continue;
    }
    const siblings = childrenByParentId.get(parentId);
    if (siblings) siblings.push(agent);
    else childrenByParentId.set(parentId, [agent]);
  }
  if (roots.length === 0) {
    return EMPTY_ORCHESTRATION_ROOTS;
  }

  roots.sort(byCreatedAt);
  for (const siblings of childrenByParentId.values()) siblings.sort(byCreatedAt);

  // Every live agent has exactly one parentAgentId, so the graph reachable from the roots found
  // above is already cycle-free (a cycle's members all have live parents, so none of them is ever
  // classified as a root). ancestorIds is still tracked and consulted while descending so a bad
  // snapshot can never turn into an infinite loop — it just drops the offending subtree.
  const buildNode = (
    agent: Agent,
    depth: number,
    ancestorIds: ReadonlySet<string>,
  ): OrchestrationTreeNode => {
    const nextAncestorIds = new Set(ancestorIds);
    nextAncestorIds.add(agent.id);
    const childAgents = childrenByParentId.get(agent.id) ?? [];
    const children = childAgents
      .filter((child) => !nextAncestorIds.has(child.id))
      .map((child) => buildNode(child, depth + 1, nextAncestorIds));
    const descendantRequiresAttention = children.some((child) => child.requiresAttentionInSubtree);
    return {
      agent,
      children,
      depth,
      descendantRequiresAttention,
      requiresAttentionInSubtree: Boolean(agent.requiresAttention) || descendantRequiresAttention,
    };
  };

  return roots.map((agent) => buildNode(agent, 0, new Set()));
}

export function useOrchestrationTree(
  params: SelectOrchestrationTreeParams,
): OrchestrationTreeNode[] {
  const pendingArchiveIds = usePendingArchiveAgentIds(params.serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectOrchestrationTree(state, params, pendingArchiveIds),
    equal,
  );
}

/** Adapts an Agent into the minimal row shape `isFinishedSubagent` reads, without duplicating its status check. */
function toFinishedCheckRow(agent: Agent): PaseoSubagentRow {
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

/**
 * Every finished (idle or error) Paseo agent in a subtree, including the node itself — the set a
 * tree-level "Archive finished" bulk action should act on. Reuses the subagents track's finished
 * predicate rather than re-deriving it.
 */
export function listFinishedAgentsInSubtree(node: OrchestrationTreeNode): Agent[] {
  const finished: Agent[] = [];
  const visit = (current: OrchestrationTreeNode) => {
    if (isFinishedSubagent(toFinishedCheckRow(current.agent))) {
      finished.push(current.agent);
    }
    for (const child of current.children) visit(child);
  };
  visit(node);
  return finished;
}
