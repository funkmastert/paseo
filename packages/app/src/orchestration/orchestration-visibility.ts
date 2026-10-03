import type { Agent } from "@/stores/session-store";
import type { OrchestrationFlatRow } from "./orchestration-panel-model";

/**
 * How long an agent stays in the default view after it last moved.
 *
 * Six hours is one working session. Archiving is the only thing that removes a row and nobody
 * archives, so an unfiltered panel is a log of every agent the machine has run this week: measured
 * on one daemon, 39 unarchived agents of which 1 was running, 22 idle and 16 closed, the oldest
 * six weeks old. The panel answers "what is happening now", and a closed agent from Tuesday is not
 * an answer to it.
 */
export const ORCHESTRATION_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Whether this agent has to stay on screen however old it is.
 *
 * Alive, blocked, failed, or over budget: the three states an orchestrator has to act on plus the
 * one it is watching. Nothing here ages out — an agent that has been waiting on a permission since
 * Tuesday is exactly the one a recency filter must not swallow.
 *
 * Unread "finished" attention is deliberately not on this list. It is an unread marker, not a
 * request: it is set on every finish, a human clears it by opening the agent, and nothing else
 * ever does (docs/agent-lifecycle.md). Pinning on it would hold a third of the fleet open forever,
 * which is the problem this filter exists to fix. The row already declines to badge it for the
 * same reason.
 */
export function isPinnedOrchestrationAgent(agent: Agent): boolean {
  if (agent.status === "running" || agent.status === "initializing") return true;
  if (agent.status === "error" || agent.attentionReason === "error") return true;
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") return true;
  // A report its parent is still owed: the parent is waiting on something that has not come.
  if (agent.owedFinishReport) return true;
  return Boolean(agent.tokenBurnAlert);
}

export interface SelectVisibleOrchestrationRowsInput {
  nowMs: number;
  recentWindowMs?: number;
  /** Kept whatever its age — the agent the tab is scoped to, so its tree never renders headless. */
  alwaysKeepAgentId?: string | null;
}

export interface VisibleOrchestrationRows {
  rows: OrchestrationFlatRow[];
  /** How many rows the window dropped. The panel shows this; it never filters silently. */
  hiddenCount: number;
}

/**
 * The rows the default view shows, and the count it is hiding.
 *
 * A row survives if it is pinned, if it moved inside the window, or if it is an ancestor of a row
 * that did — a kept child under a dropped parent would render at a depth with nothing above it and
 * read as a root. Ancestor survival is also what keeps `depth` correct without renumbering.
 */
export function selectVisibleOrchestrationRows(
  rows: readonly OrchestrationFlatRow[],
  input: SelectVisibleOrchestrationRowsInput,
): VisibleOrchestrationRows {
  const windowMs = input.recentWindowMs ?? ORCHESTRATION_RECENT_WINDOW_MS;
  const oldestAllowedMs = input.nowMs - windowMs;

  // The flatten is depth-first pre-order, so a row's parent is the nearest earlier row one level
  // shallower — recoverable from depth alone, without carrying parent ids through the list.
  const parentIndexByIndex: number[] = [];
  const openAncestorIndexByDepth: number[] = [];
  const keep: boolean[] = [];
  for (const [index, row] of rows.entries()) {
    parentIndexByIndex.push(row.depth === 0 ? -1 : (openAncestorIndexByDepth[row.depth - 1] ?? -1));
    openAncestorIndexByDepth[row.depth] = index;
    keep.push(
      isPinnedOrchestrationAgent(row.agent) ||
        row.agent.updatedAt.getTime() >= oldestAllowedMs ||
        row.agent.id === input.alwaysKeepAgentId,
    );
  }

  // Backwards: a parent marked by one of its children is itself visited afterwards, so the mark
  // carries all the way to the root in one pass.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!keep[index]) continue;
    const parentIndex = parentIndexByIndex[index] ?? -1;
    if (parentIndex >= 0) keep[parentIndex] = true;
  }

  const visible: OrchestrationFlatRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (keep[index]) visible.push(row);
  }
  return { rows: visible, hiddenCount: rows.length - visible.length };
}
