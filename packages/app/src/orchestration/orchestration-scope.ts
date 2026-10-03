import type { Agent } from "@/stores/session-store";
import type { OrchestrationTreeNode } from "./select";

/**
 * Which slice of the host's agents an orchestration tab shows.
 *
 * `leader` is a tab opened from inside a session: it shows the tree that session belongs to and
 * nothing else. `all` is the host-wide view. The two are separate tabs (separate targets, separate
 * identities) rather than a mode of one, so a split can hold both.
 */
export type OrchestrationScope = { kind: "all" } | { kind: "leader"; agentId: string };

export function resolveOrchestrationScope(scopeAgentId: string | undefined): OrchestrationScope {
  return scopeAgentId ? { kind: "leader", agentId: scopeAgentId } : { kind: "all" };
}

function subtreeContains(node: OrchestrationTreeNode, agentId: string): boolean {
  if (node.agent.id === agentId) return true;
  return node.children.some((child) => subtreeContains(child, agentId));
}

/**
 * The root of the tree `agentId` belongs to, or null when no live tree holds it.
 *
 * "This leader" for an agent that is itself a subagent means the top of its tree, so the scope is
 * the same whichever member of the tree you opened the tab from. The walk is over the assembled
 * tree rather than over `parentAgentId` hops because the tree already decides who counts as a root
 * — an agent whose parent is archived, pending-archive, or on another server is one — and already
 * refuses to follow a cyclic snapshot.
 */
export function findOrchestrationRootAgentId(
  roots: readonly OrchestrationTreeNode[],
  agentId: string,
): string | null {
  for (const root of roots) {
    if (subtreeContains(root, agentId)) return root.agent.id;
  }
  return null;
}

/**
 * The roots a scope renders: every root for `all`, and the one tree holding the scoped agent for
 * `leader`. An empty result for a `leader` scope means the tree is gone — archived, or on a host
 * that has not replied yet — which the panel reports rather than showing as "no agents".
 */
export function selectScopedOrchestrationRoots(
  roots: readonly OrchestrationTreeNode[],
  scope: OrchestrationScope,
): OrchestrationTreeNode[] {
  if (scope.kind === "all") return roots as OrchestrationTreeNode[];
  const rootAgentId = findOrchestrationRootAgentId(roots, scope.agentId);
  if (!rootAgentId) return [];
  return roots.filter((root) => root.agent.id === rootAgentId);
}

/** The title to name a scoped tab by: the leader's, not the agent the tab was opened from. */
export function resolveScopedLeaderAgent(
  roots: readonly OrchestrationTreeNode[],
  scope: OrchestrationScope,
): Agent | null {
  if (scope.kind === "all") return null;
  const rootAgentId = findOrchestrationRootAgentId(roots, scope.agentId);
  if (!rootAgentId) return null;
  return roots.find((root) => root.agent.id === rootAgentId)?.agent ?? null;
}
