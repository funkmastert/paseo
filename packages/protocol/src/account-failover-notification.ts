/**
 * Push-notification `data.reason` value for the account-failover monitor. Untyped JSON on the
 * wire (not part of the closed `attentionReason` enum — see agent-types.ts), so this is safe
 * for old apps: they fall back to opening by `agentId`.
 */
export type AccountFailoverNotificationReason = "account_failover";

export interface AccountFailoverNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  /** The successor's id — tapping the push opens the agent that is actually still running. */
  agentId: string;
  reason: AccountFailoverNotificationReason;
}

export interface AccountFailoverNotificationPayload {
  title: string;
  body: string;
  data: AccountFailoverNotificationData;
}

function resolveAgentLabel(agentTitle: string | null | undefined): string {
  const trimmed = agentTitle?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "An agent";
}

interface BuildAccountFailoverNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  oldAgentId: string;
  oldAgentTitle: string | null | undefined;
  newAgentId: string;
  targetProviderId: string;
}

/**
 * Single-migration notification: old id -> new id -> target account, so Tyler can find both
 * ends without opening the daemon. When the ids match, the agent changed account in place and
 * there is only one end to find. `title`/`body` are hardcoded English, matching
 * resource-monitor-notification.ts/token-burn-notification.ts's precedent — this payload never
 * crosses the app i18n pipeline, it's built server-side and sent verbatim to the push provider.
 */
export function buildAccountFailoverNotificationPayload(
  input: BuildAccountFailoverNotificationPayloadInput,
): AccountFailoverNotificationPayload {
  const label = resolveAgentLabel(input.oldAgentTitle);
  const movedInPlace = input.newAgentId === input.oldAgentId;
  return {
    title: "Agent moved to a new account",
    body: movedInPlace
      ? `${label} hit its account's usage limit and now runs on ${input.targetProviderId}, ` +
        `still as ${input.newAgentId}.`
      : `${label} hit its account's usage limit and moved from ${input.oldAgentId} to ` +
        `${input.newAgentId} on ${input.targetProviderId}.`,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.newAgentId,
      reason: "account_failover",
    },
  };
}
