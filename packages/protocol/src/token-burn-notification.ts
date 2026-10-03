import type { TokenBurnAlert } from "./agent-types.js";

/**
 * Push-notification `data.reason` values for the token-burn monitor. Untyped JSON on the
 * wire (not part of the closed `attentionReason` enum — see agent-types.ts's TokenBurnAlert),
 * so adding a value here is safe for old apps: they fall back to opening by `agentId`.
 */
export type TokenBurnNotificationReason =
  | "token_burn_rate"
  | "token_burn_total"
  | "token_burn_multi"
  | "token_burn_governor"
  | "token_burn_account_pressure";

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

/**
 * The graduated actions the spend governor can take when an agent crosses its per-task budget
 * (server agent/spend-governor.ts). Kept as a plain string union here rather than a wire enum:
 * it only ever reaches an app inside `TokenBurnAlert.governorStage`, which is
 * `z.string().optional()` for exactly that reason.
 */
export type SpendGovernorStage = "notify" | "downgrade" | "stopFanOut" | "pause";

interface BuildSpendGovernorNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  agentTitle?: string | null;
  stage: SpendGovernorStage;
  budgetTokens: number;
  spentTokens: number;
  /** Nothing was actually done — the governor is in dryRun. */
  dryRun: boolean;
  /** Stage-specific tail, e.g. the model an agent was moved to. */
  detail?: string;
}

const SPEND_GOVERNOR_TITLES: Record<SpendGovernorStage, string> = {
  notify: "Agent is nearing its budget",
  downgrade: "Agent moved to a cheaper model",
  stopFanOut: "Agent can no longer create agents",
  pause: "Agent paused: over budget",
};

function describeSpendGovernorOutcome(
  stage: SpendGovernorStage,
  detail: string | undefined,
): string {
  switch (stage) {
    case "downgrade":
      return `moved to ${detail ?? "a cheaper model"}`;
    case "stopFanOut":
      return "blocked from creating more agents";
    case "pause":
      return "paused mid-turn";
    case "notify":
      return "warned";
  }
}

/**
 * One push per governor action. Deliberately one per action rather than one per agent: the
 * four stages are different events with different consequences, and collapsing them would
 * hide the one that matters (a pause) behind the one that doesn't (a 75% warning).
 */
export function buildSpendGovernorNotificationPayload(
  input: BuildSpendGovernorNotificationPayloadInput,
): TokenBurnNotificationPayload {
  const label = resolveAgentLabel(input.agentTitle);
  const pct = Math.round((input.spentTokens / input.budgetTokens) * 100);
  const spend = `${formatTokenCount(input.spentTokens)} of its ${formatTokenCount(
    input.budgetTokens,
  )} budget (${pct}%)`;
  const title = input.dryRun
    ? `Dry run: ${SPEND_GOVERNOR_TITLES[input.stage].toLowerCase()}`
    : SPEND_GOVERNOR_TITLES[input.stage];
  const verb = input.dryRun ? "would have been" : "was";
  const body =
    input.stage === "notify"
      ? `${label} has used ${spend}.`
      : `${label} used ${spend} and ${verb} ${describeSpendGovernorOutcome(
          input.stage,
          input.detail,
        )}.`;

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.agentId,
      reason: "token_burn_governor",
      stage: input.stage,
      dryRun: input.dryRun,
    },
  };
}

interface BuildAccountUsagePressureNotificationPayloadInput {
  serverId: string;
  providerId: string;
  displayName: string;
  windowLabel: string;
  usedPct: number;
  resetsAt?: string | null;
}

/**
 * Account-level usage pressure. Report-only by design: acting on it belongs to the account
 * pool plugin (which routes new agents away from a hot account) and AccountFailoverMonitor
 * (which moves stuck agents at 100%). There is no `agentId` to open — the data carries the
 * provider instead, and `agentId` is empty so an old app that keys off it simply opens the
 * server rather than a wrong agent.
 */
export function buildAccountUsagePressureNotificationPayload(
  input: BuildAccountUsagePressureNotificationPayloadInput,
): TokenBurnNotificationPayload {
  const resets = input.resetsAt ? ` Resets ${input.resetsAt}.` : "";
  return {
    title: "Account usage is nearly exhausted",
    body: `${input.displayName} is at ${Math.round(input.usedPct)}% of ${input.windowLabel}.${resets}`,
    data: {
      serverId: input.serverId,
      agentId: "",
      reason: "token_burn_account_pressure",
      providerId: input.providerId,
      windowLabel: input.windowLabel,
      usedPct: input.usedPct,
    },
  };
}
