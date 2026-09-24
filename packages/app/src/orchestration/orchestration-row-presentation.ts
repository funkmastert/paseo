import type { Agent } from "@/stores/session-store";

export type OrchestrationRowBadge = "needs-input" | "failed" | "owes-report" | "report-undelivered";

/** Keys of `agentList.status` — the words the compact row's second line falls back to. */
export type OrchestrationRowStatusKey = "initializing" | "idle" | "running" | "error" | "closed";

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
  /** What the compact row's second line says when it has no activity to show. */
  statusKey: OrchestrationRowStatusKey;
}

function resolveStatusKey(status: Agent["status"]): OrchestrationRowStatusKey {
  switch (status) {
    case "initializing":
    case "running":
    case "error":
    case "closed":
      return status;
    default:
      return "idle";
  }
}

function resolveBadge(agent: Agent): OrchestrationRowBadge | null {
  if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
    return "needs-input";
  }
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  const owed = agent.owedFinishReport;
  if (!owed) return null;
  // `state` is open on the wire; anything but "parked" means the report is stuck in delivery.
  return owed.state === "parked" ? "owes-report" : "report-undelivered";
}

/** What a row shows, given the agent's state. Pure so the rules are testable without rendering. */
export function resolveOrchestrationRowPresentation(agent: Agent): OrchestrationRowPresentation {
  const isRunning = agent.status === "running";
  // "finished" attention deliberately gets no badge: it is the ordinary end state of most of the
  // fleet, the status dot already carries it, and a badge on thirty rows is not a signal. An
  // owed report does: a parent is waiting on it, and nothing else on the row says so.
  const badge = resolveBadge(agent);
  return {
    isRunning,
    isClosed: agent.status === "closed",
    badge,
    showActivity: isRunning && Boolean(agent.lastActivitySummary),
    statusKey: resolveStatusKey(agent.status),
  };
}
