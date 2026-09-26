/**
 * Push-notification `data.reason` value for the account-failover monitor. Untyped JSON on the
 * wire (not part of the closed `attentionReason` enum — see agent-types.ts), so this is safe
 * for old apps: they fall back to opening by `agentId`.
 */
export type AccountFailoverNotificationReason = "account_failover";

/**
 * `data.reason` for the pool-exhausted push: no account is left to move anyone to. Its own
 * value rather than `account_failover` because there is nothing to open — no migration
 * happened, and no agent id is the right destination.
 */
export type AccountPoolExhaustedNotificationReason = "account_pool_exhausted";

/** Open on purpose: an app must treat an unrecognised hint as "no hint" and read `body`. */
export type AccountFailoverOutcomeHint = "needs_prompt" | "returned_home";

export interface AccountFailoverNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  /** The successor's id — tapping the push opens the agent that is actually still running. */
  agentId: string;
  reason: AccountFailoverNotificationReason;
  /**
   * `"needs_prompt"` when the move landed but the resume prompt never did, so the agent is
   * healthy, idle, and waiting for any message. `"returned_home"` when the agent went back to
   * the account it was rescued off. Optional and additive: an app that does not read it still
   * gets the whole story from `body`, which states it in words.
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

export interface AccountPoolExhaustedNotificationData {
  [key: string]: unknown;
  serverId: string;
  reason: AccountPoolExhaustedNotificationReason;
  /** Every pool account that is out, so the push names what is actually dead. */
  providerIds: string[];
  /** How many agents are waiting on one of them. */
  strandedAgentCount: number;
}

export interface AccountPoolExhaustedNotificationPayload {
  title: string;
  body: string;
  data: AccountPoolExhaustedNotificationData;
}

interface BuildAccountPoolExhaustedNotificationPayloadInput {
  serverId: string;
  providerIds: readonly string[];
  strandedAgentCount: number;
  /** Free text from the provider's own cap message, e.g. "3:10pm (America/Los_Angeles)". */
  resetHint?: string | null;
}

/**
 * Every pooled account is out of budget, so stuck agents have nowhere to go.
 *
 * Sent instead of a migration, not alongside one. The monitor deliberately moves nobody here:
 * the only remaining targets are accounts that would fail on the first turn, and a rescue onto
 * one of those spends a move and a resume to leave the agent exactly as stuck, on a different
 * account, with its evidence scattered. Stranded and visible beats moved and still broken.
 */
export function buildAccountPoolExhaustedNotificationPayload(
  input: BuildAccountPoolExhaustedNotificationPayloadInput,
): AccountPoolExhaustedNotificationPayload {
  const agents =
    input.strandedAgentCount === 1 ? "1 agent is" : `${input.strandedAgentCount} agents are`;
  const reset = input.resetHint ? ` Earliest reset: ${input.resetHint}.` : "";
  return {
    title: "Every Claude account is out of budget",
    body:
      `${agents} stuck and cannot be moved: ${input.providerIds.join(", ")} are all capped.` +
      `${reset} Sign another account in or raise a limit — nothing will run until one recovers.`,
    data: {
      serverId: input.serverId,
      reason: "account_pool_exhausted",
      providerIds: [...input.providerIds],
      strandedAgentCount: input.strandedAgentCount,
    },
  };
}

interface BuildAccountFailoverReturnNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  agentTitle: string | null | undefined;
  /** The account it was rescued off and has now gone back to. */
  homeProviderId: string;
  /** The rescuer it was spending on until now. */
  fromProviderId: string;
}

/**
 * The return leg of a failover: same agent, same conversation, back on the account it started on.
 * It rides the same `reason` as a rescue because it is the same fact Tyler reads these for — which
 * account an agent spends on changed — and an app that only knows the rescue still renders it and
 * taps through to the agent. Hardcoded English for the same reason as the rescue payload.
 */
export function buildAccountFailoverReturnNotificationPayload(
  input: BuildAccountFailoverReturnNotificationPayloadInput,
): AccountFailoverNotificationPayload {
  const label = resolveAgentLabel(input.agentTitle);
  return {
    title: "Agent returned to its own account",
    body:
      `${label} went back to ${input.homeProviderId} from ${input.fromProviderId} now that ` +
      `${input.homeProviderId}'s usage window has reset.`,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.agentId,
      reason: "account_failover",
      outcome: "returned_home",
    },
  };
}
