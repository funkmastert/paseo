/**
 * Lean projections of the heavy Paseo MCP tool outputs (OR-H4). A leader pays for every byte of
 * every call, so `list_agents`, `get_agent_status` and `get_agent_activity` default to the fields
 * an agent decides with and take `full: true` for the rest.
 *
 * What was measured, on 46 unarchived agents read from a real daemon's agent records:
 *   - list_agents: about 914 model-visible bytes per agent. A third of that was JSON indentation
 *     (see paseo-tool-serialization.ts); of the rest, labels, timestamps nobody reads
 *     (createdAt, lastUserMessageAt, attentionTimestamp), thinking-option ids and per-agent
 *     `paseo.open-agent-tab.*` UI labels were the bulk.
 *   - get_agent_status: about 4.7 KB per call, 4.3 KB of it `persistence` (the provider's native
 *     resume handle and its metadata), which an agent cannot act on.
 *   - get_agent_activity: unbounded by default, the largest single call a leader makes.
 *
 * Pure functions, no I/O, so the projection can be tested against a fixture fleet.
 */

import { isOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import type { AgentListItemPayload, AgentSnapshotPayload } from "../../messages.js";

/** `get_agent_activity` shows this many entries unless the caller passes `limit` or `full`. */
export const COMPACT_ACTIVITY_LIMIT = 30;

/**
 * Fields kept per row. `cwd` stays because `list_agents` filters by it and paths are how agents
 * tell worktrees apart; `updatedAt` stays because the list is sorted by it.
 */
export type CompactAgentListItem = Pick<
  AgentListItemPayload,
  "id" | "title" | "provider" | "model" | "status" | "cwd" | "updatedAt" | "labels"
> &
  Partial<
    Pick<
      AgentListItemPayload,
      | "requiresAttention"
      | "attentionReason"
      | "providerUnavailable"
      | "lastActivitySummary"
      | "recentTokenRate"
      | "totalTokens"
      | "tokenBurnAlert"
      | "resourceAlert"
      | "archivedAt"
    >
  >;

export function toCompactAgentListItem(item: AgentListItemPayload): CompactAgentListItem {
  const labels = Object.fromEntries(
    Object.entries(item.labels).filter(([key]) => !isOpenAgentTabLabel(key)),
  );
  return {
    id: item.id,
    title: item.title,
    provider: item.provider,
    model: item.model,
    status: item.status,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
    labels,
    // Only what is set: an absent flag reads the same as false, and a null reason as none.
    ...(item.requiresAttention
      ? { requiresAttention: true, attentionReason: item.attentionReason }
      : {}),
    ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}),
    ...(item.providerUnavailable ? { providerUnavailable: true } : {}),
    ...(item.lastActivitySummary !== undefined
      ? { lastActivitySummary: item.lastActivitySummary }
      : {}),
    ...(item.recentTokenRate !== undefined ? { recentTokenRate: item.recentTokenRate } : {}),
    ...(item.totalTokens !== undefined ? { totalTokens: item.totalTokens } : {}),
    ...(item.tokenBurnAlert !== undefined ? { tokenBurnAlert: item.tokenBurnAlert } : {}),
    ...(item.resourceAlert !== undefined ? { resourceAlert: item.resourceAlert } : {}),
  };
}

/**
 * The snapshot without the parts an agent cannot act on: the provider resume handle
 * (`persistence`), capability flags, the mode catalogue, and MCP server status. What remains
 * still answers "what is this agent doing, what does it need, what is it running".
 */
export type CompactAgentSnapshot = Omit<
  AgentSnapshotPayload,
  "persistence" | "capabilities" | "availableModes" | "mcpServerStatuses"
>;

export function toCompactAgentSnapshot(snapshot: AgentSnapshotPayload): CompactAgentSnapshot {
  const {
    persistence: _persistence,
    capabilities: _capabilities,
    availableModes: _availableModes,
    mcpServerStatuses: _mcpServerStatuses,
    ...rest
  } = snapshot;
  return {
    ...rest,
    labels: Object.fromEntries(
      Object.entries(rest.labels).filter(([key]) => !isOpenAgentTabLabel(key)),
    ),
  };
}
