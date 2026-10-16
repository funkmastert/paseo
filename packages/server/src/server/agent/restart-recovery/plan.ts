import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  RestartRecoveryCheck,
  RestartRecoveryCheckStatus,
  RestartRecoveryReadiness,
} from "@getpaseo/protocol/restart-recovery/rpc-schemas";

/**
 * Pure rules for restart recovery's plan. The service gathers facts (records, probes, what this
 * daemon already did) and these decide what they mean. See docs/restart-recovery.md.
 */

/**
 * Roll a readiness verdict up from its checks. A red check means it cannot be resumed as it
 * stands. A check that could not say (its probe threw, or the provider cannot tell) makes the
 * verdict `unknown`, never `not_restorable`: not knowing is not a no.
 */
export function rollUpReadiness(checks: readonly RestartRecoveryCheck[]): RestartRecoveryReadiness {
  const statuses = new Set<RestartRecoveryCheckStatus>(checks.map((check) => check.status));
  if (statuses.has("red")) return "not_restorable";
  if (statuses.has("unknown")) return "unknown";
  if (statuses.has("yellow")) return "restorable_with_caveats";
  return "restorable";
}

/** Recovery tries everything that is not known to fail. */
export function isResumable(readiness: RestartRecoveryReadiness): boolean {
  return readiness !== "not_restorable";
}

export interface AgentLineage {
  id: string;
  labels: Record<string, string>;
}

/**
 * How many of an agent's ancestors are also in the recovery set. Recovery resumes depth 0 first,
 * so a leader is running again before its children are, and can be told they are coming back.
 * The walk goes through ancestors outside the set too: a mid-turn grandparent still comes before
 * a mid-turn grandchild whose own parent was idle.
 */
export function computeRecoveryDepths(
  recoveringIds: ReadonlySet<string>,
  lineage: readonly AgentLineage[],
): Map<string, number> {
  const parentById = new Map<string, string | null>();
  for (const agent of lineage) {
    parentById.set(agent.id, getParentAgentIdFromLabels(agent.labels));
  }
  const depths = new Map<string, number>();
  for (const id of recoveringIds) {
    let depth = 0;
    const seen = new Set<string>([id]);
    let parent = parentById.get(id) ?? null;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (recoveringIds.has(parent)) depth += 1;
      parent = parentById.get(parent) ?? null;
    }
    depths.set(id, depth);
  }
  return depths;
}

/** Leaders first, then by when the interrupted run started. */
export function orderForRecovery<
  T extends { agentId: string; depth: number; runStartedAt: string },
>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      a.depth - b.depth ||
      a.runStartedAt.localeCompare(b.runStartedAt) ||
      a.agentId.localeCompare(b.agentId),
  );
}

/** Group ordered entries into waves of equal depth. Each wave waits for the one before it. */
export function groupByDepth<T extends { depth: number }>(ordered: readonly T[]): T[][] {
  const waves: T[][] = [];
  for (const entry of ordered) {
    const last = waves.at(-1);
    if (last && last[0]!.depth === entry.depth) {
      last.push(entry);
    } else {
      waves.push([entry]);
    }
  }
  return waves;
}

/**
 * The nearest ancestor that recovery is also resuming, found through the same walk as the depth.
 * Null when no ancestor is in the set.
 */
export function nearestRecoveringAncestor(
  agentId: string,
  recoveringIds: ReadonlySet<string>,
  lineage: readonly AgentLineage[],
): string | null {
  const parentById = new Map(
    lineage.map((agent) => [agent.id, getParentAgentIdFromLabels(agent.labels)] as const),
  );
  const seen = new Set<string>([agentId]);
  let parent = parentById.get(agentId) ?? null;
  while (parent && !seen.has(parent)) {
    if (recoveringIds.has(parent)) return parent;
    seen.add(parent);
    parent = parentById.get(parent) ?? null;
  }
  return null;
}
