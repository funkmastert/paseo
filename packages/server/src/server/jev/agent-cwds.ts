import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

/** One agent as the D7 scope sees it: where it works and who its parent is. */
export interface JevAgentPlacement {
  id: string;
  cwd: string;
  labels: Readonly<Record<string, string>>;
  /** ISO time, or null/undefined while the agent is live. */
  archivedAt?: string | null;
}

/** An agent archived longer ago than this no longer counts as a descendant. */
export const JEV_ARCHIVED_DESCENDANT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Every cwd whose content can reach a call about `agentIds` (docs/jev.md, "The scope"): each
 * agent's own cwd, every ancestor's, and every descendant's, live or archived in the last 24 hours.
 * Null when any id is unknown, so the call is excluded rather than checked against less than its
 * whole tree.
 */
export function resolveJevAgentCwds(
  agentIds: readonly string[],
  placements: readonly JevAgentPlacement[],
  now: number,
): string[] | null {
  const byId = new Map(placements.map((placement) => [placement.id, placement]));
  const children = new Map<string, JevAgentPlacement[]>();
  for (const placement of placements) {
    const parentId = getParentAgentIdFromLabels(placement.labels);
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(placement);
    children.set(parentId, siblings);
  }
  const cwds = new Set<string>();
  for (const agentId of agentIds) {
    const own = byId.get(agentId);
    if (!own) return null;
    const seen = new Set<string>();
    let cursor: JevAgentPlacement | undefined = own;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cwds.add(cursor.cwd);
      const parentId = getParentAgentIdFromLabels(cursor.labels);
      cursor = parentId ? byId.get(parentId) : undefined;
    }
    const queue = [...(children.get(own.id) ?? [])];
    while (queue.length > 0) {
      const child = queue.shift()!;
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.archivedAt) {
        const archivedAt = Date.parse(child.archivedAt);
        if (Number.isFinite(archivedAt) && now - archivedAt > JEV_ARCHIVED_DESCENDANT_WINDOW_MS) {
          continue;
        }
      }
      cwds.add(child.cwd);
      queue.push(...(children.get(child.id) ?? []));
    }
  }
  return [...cwds];
}
