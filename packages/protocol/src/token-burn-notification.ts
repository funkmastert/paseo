import type { TokenBurnAlert } from "./agent-types.js";

/**
 * Push-notification `data.reason` values for the token-burn monitor. Untyped JSON on the
 * wire (not part of the closed `attentionReason` enum — see agent-types.ts's TokenBurnAlert),
 * so adding a value here is safe for old apps: they fall back to opening by `agentId`.
 */
export type TokenBurnNotificationReason =
  | "token_burn_rate"
  | "token_burn_total"
  | "token_burn_multi";

export interface TokenBurnNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  agentId: string;
  /** Present only on the batched (storm) variant, alongside the single `agentId` fallback. */
  agentIds?: string[];
  reason: TokenBurnNotificationReason;
}

export interface TokenBurnNotificationPayload {
  title: string;
  body: string;
  data: TokenBurnNotificationData;
}

interface BuildTokenBurnNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  agentTitle?: string | null;
  trigger: TokenBurnAlert["trigger"];
  ratePerMinute?: number;
  totalTokens?: number;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

function resolveAgentLabel(agentTitle: string | null | undefined): string {
  const trimmed = agentTitle?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "An agent";
}

/**
 * Single-agent breach notification. `title`/`body` are hardcoded English here, matching
 * agent-attention-notification.ts's precedent — this payload never crosses the app i18n
 * pipeline, it's built server-side and sent verbatim to the push provider.
 */
export function buildTokenBurnNotificationPayload(
  input: BuildTokenBurnNotificationPayloadInput,
): TokenBurnNotificationPayload {
  const label = resolveAgentLabel(input.agentTitle);
  // Pace and cumulative spend are different complaints and get different titles. Both counts
  // are cost-weighted tokens (server token-rate-tracker.ts), never raw traffic.
  const title =
    input.trigger === "rate" ? "Agent is burning tokens fast" : "Agent has used a lot of tokens";
  const body =
    input.trigger === "rate"
      ? `${label} is burning ${formatTokenCount(input.ratePerMinute ?? 0)} weighted tokens/min.`
      : `${label} has used ${formatTokenCount(input.totalTokens ?? 0)} weighted tokens this session.`;

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.agentId,
      reason: input.trigger === "rate" ? "token_burn_rate" : "token_burn_total",
    },
  };
}

interface BatchedTokenBurnBreach {
  agentId: string;
  workspaceId?: string;
}

interface BuildBatchedTokenBurnNotificationPayloadInput {
  serverId: string;
  breaches: readonly BatchedTokenBurnBreach[];
}

/**
 * Combined notification for a sweep that breaches more than `breachBatchThreshold` agents at
 * once — one push instead of one per agent. Individual agents still get their own
 * `tokenBurnAlert` set (see agent-manager.ts's setTokenBurnAlert), so per-agent UI state is
 * unaffected by batching; only the push is collapsed.
 */
export function buildBatchedTokenBurnNotificationPayload(
  input: BuildBatchedTokenBurnNotificationPayloadInput,
): TokenBurnNotificationPayload {
  const first = input.breaches[0];
  if (!first) {
    throw new Error("buildBatchedTokenBurnNotificationPayload requires at least one breach");
  }

  return {
    title: "Multiple agents are burning tokens fast",
    body: `${input.breaches.length} agents crossed their token-burn threshold.`,
    data: {
      serverId: input.serverId,
      ...(first.workspaceId ? { workspaceId: first.workspaceId } : {}),
      agentId: first.agentId,
      agentIds: input.breaches.map((breach) => breach.agentId),
      reason: "token_burn_multi",
    },
  };
}
