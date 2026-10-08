export type KnowledgeBaseViewMode = "list" | "graph";

/**
 * Non-React persistence for the List/Graph toggle (U9, KTD-11). On compact layouts, selecting a
 * graph node pushes the note as a separate route; the Knowledge screen's own route then blurs and
 * `knowledge-base-screen.tsx` unmounts its content while blurred, so a plain `useState` resets to
 * "list" on the way back. Keeping the last choice here, outside React state, is what makes Back
 * land back on the graph instead of silently dropping it.
 */
const lastViewMode = new Map<string, KnowledgeBaseViewMode>();

export function getLastKnowledgeViewMode(serverId: string | null): KnowledgeBaseViewMode {
  if (!serverId) return "list";
  return lastViewMode.get(serverId) ?? "list";
}

export function setLastKnowledgeViewMode(
  serverId: string | null,
  mode: KnowledgeBaseViewMode,
): void {
  if (!serverId) return;
  lastViewMode.set(serverId, mode);
}
