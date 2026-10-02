import { followMigratedTo, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

type LabelsOf = (agentId: string) => Record<string, unknown> | null | undefined;

/**
 * The agent a child answers to now. A child keeps the parent id it was spawned under, but account
 * failover may since have moved that parent's conversation to another id (`migrated-to`), and
 * settle-back may move it back. Following the label from that id reaches whoever holds the
 * conversation today. Null for a root. A parent whose moves loop is taken at its word.
 */
export function liveParentOf(
  labels: Record<string, unknown> | null | undefined,
  labelsOf: LabelsOf,
): string | null {
  const parentId = getParentAgentIdFromLabels(labels);
  if (!parentId) return null;
  const end = followMigratedTo(parentId, labelsOf);
  return end.kind === "loop" ? parentId : end.agentId;
}
