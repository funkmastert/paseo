/**
 * Push-notification `data.reason` value for the account-failover monitor. Untyped JSON on the
 * wire (not part of the closed `attentionReason` enum — see agent-types.ts), so this is safe
 * for old apps: they fall back to opening by `agentId`.
 */
export type AccountFailoverNotificationReason = "account_failover";

/** Open on purpose: an app must treat an unrecognised hint as "no hint" and read `body`. */
export type AccountFailoverOutcomeHint = "needs_prompt";

export interface AccountFailoverNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  /** The successor's id — tapping the push opens the agent that is actually still running. */
  agentId: string;
  reason: AccountFailoverNotificationReason;
  /**
   * Present and `"needs_prompt"` only when the move landed but the resume prompt never did, so
   * the agent is healthy, idle, and waiting for any message. Optional and additive: an app that
   * does not read it still gets the whole story from `body`, which states it in words.
   */
  outcome?: AccountFailoverOutcomeHint;
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
  /** False when the resume prompt could not be delivered; defaults to true. */
  resumed?: boolean;
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
  const resumed = input.resumed ?? true;
  const where = movedInPlace
    ? `now runs on ${input.targetProviderId}, still as ${input.newAgentId}`
    : `moved from ${input.oldAgentId} to ${input.newAgentId} on ${input.targetProviderId}`;
  return {
    // An agent that moved but never restarted is not the same event as one that carried on, and
    // it is the only one of the two that needs Tyler to do something. Say which, and say what.
    title: resumed ? "Agent moved to a new account" : "Agent moved but did not restart",
    body: resumed
      ? `${label} hit its account's usage limit and ${where}.`
      : `${label} hit its account's usage limit and ${where}, but could not be restarted. ` +
        `Open it and send any message to continue.`,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.newAgentId,
      reason: "account_failover",
      ...(resumed ? {} : { outcome: "needs_prompt" as const }),
    },
  };
}
