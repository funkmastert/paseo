import type { Agent } from "@/stores/session-store";

export type OrchestrationRowBadge = "needs-input" | "failed";

export interface OrchestrationRowPresentation {
  /** The one row state that is happening now rather than having happened. */
  isRunning: boolean;
  /** No provider runtime behind this agent — it has to be resumed before it can do anything. */
  isClosed: boolean;
  /** A badge only for the states an orchestrator has to act on. */
  badge: OrchestrationRowBadge | null;
  /**
   * Whether to show `lastActivitySummary` as what the agent is doing.
   *
   * Only while it is running. The field keeps its last value when the agent goes quiet, so on a
   * finished row it is the last thing that happened before it stopped — put in the "doing now"
   * column, with no time attached, that reads as current work hours after the agent stopped.
   */
  showActivity: boolean;
}

function resolveBadge(
  hasPendingPermission: boolean,
  hasFailed: boolean,
): OrchestrationRowBadge | null {
  if (hasPendingPermission) return "needs-input";
  if (hasFailed) return "failed";
  return null;
}

/** What a row shows, given the agent's state. Pure so the rules are testable without rendering. */
export function resolveOrchestrationRowPresentation(agent: Agent): OrchestrationRowPresentation {
  const isRunning = agent.status === "running";
  const hasPendingPermission =
    agent.pendingPermissions.length > 0 || agent.attentionReason === "permission";
  const hasFailed = agent.status === "error" || agent.attentionReason === "error";
  // "finished" attention deliberately gets no badge: it is the ordinary end state of most of the
  // fleet, the status dot already carries it, and a badge on thirty rows is not a signal.
  const badge: OrchestrationRowBadge | null = resolveBadge(hasPendingPermission, hasFailed);
  return {
    isRunning,
    isClosed: agent.status === "closed",
    badge,
    showActivity: isRunning && Boolean(agent.lastActivitySummary),
  };
}
