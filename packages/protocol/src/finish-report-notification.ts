/**
 * Push-notification `data.reason` value for a finish report nobody could be given. Untyped JSON
 * on the wire (not part of the closed `attentionReason` enum — see agent-types.ts), so this is
 * safe for old apps: they fall back to opening by `agentId`.
 */
export type FinishReportNotificationReason = "finish_report_undelivered";

export interface FinishReportNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  /** The agent whose report was lost — tapping the push opens it, and its result is there. */
  agentId: string;
  reason: FinishReportNotificationReason;
  /** The agent the report was owed to. */
  ownerAgentId: string;
}

export interface FinishReportNotificationPayload {
  title: string;
  body: string;
  data: FinishReportNotificationData;
}

interface BuildFinishReportNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  agentTitle: string | null | undefined;
  ownerAgentId: string;
  ownerTitle: string | null | undefined;
  /** What happened to the agent, as the finish report words it: "finished", "errored", … */
  outcome: string;
}

function label(title: string | null | undefined, fallback: string): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

/**
 * The last rung of the finish-report ladder (docs/finish-reports.md): the parent and every agent
 * above it were tried and none could be told. `title`/`body` are hardcoded English, matching
 * account-failover-notification.ts — built server-side and sent verbatim to the push provider.
 */
export function buildFinishReportNotificationPayload(
  input: BuildFinishReportNotificationPayloadInput,
): FinishReportNotificationPayload {
  const agent = label(input.agentTitle, input.agentId);
  const owner = label(input.ownerTitle, input.ownerAgentId);
  return {
    title: "Subagent report undelivered",
    body:
      `${agent} ${input.outcome}, but its parent ${owner} could not be told, and neither could ` +
      `any agent above it. Open it to read what it did.`,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.agentId,
      reason: "finish_report_undelivered",
      ownerAgentId: input.ownerAgentId,
    },
  };
}
