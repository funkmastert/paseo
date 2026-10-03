import { z } from "zod";

// Why a projection is not a number yet. A plain string union in the wire schema would break an
// older client the day a daemon names a new reason, so the reason is a plain string here and the
// known values are documented in docs/usage-history.md.
export const UsageWindowProjectionSchema = z.object({
  // "unknown"   - not enough honest evidence to give a rate; `reason` says which rule stopped it.
  // "projected" - a measured rate. `capsAt` is set only when the cap lands before the reset.
  // "capped"    - the window already reads 100%.
  status: z.enum(["unknown", "projected", "capped"]),
  reason: z.string().optional(),
  samples: z.number().int().nonnegative(),
  spanMinutes: z.number().nonnegative(),
  ratePctPerHour: z.number().optional(),
  projectedPctAtReset: z.number().optional(),
  capsAt: z.string().optional(),
  minutesToCap: z.number().nonnegative().optional(),
  confidence: z.enum(["low", "ok"]).optional(),
});

export const UsageHistoryWindowSchema = z.object({
  windowId: z.string(),
  label: z.string(),
  usedPct: z.number(),
  resetsAt: z.string().nullable(),
  sampledAt: z.string(),
  projection: UsageWindowProjectionSchema,
});

export const UsageHistoryAccountSchema = z.object({
  providerId: z.string(),
  windows: z.array(UsageHistoryWindowSchema),
});

export const UsageHistoryAgentPointSchema = z.object({
  at: z.string(),
  // Cost-weighted tokens (docs/token-burn.md), cumulative across reloads and daemon restarts.
  weightedTokens: z.number().nonnegative(),
});

export const UsageHistoryAgentSchema = z.object({
  agentId: z.string(),
  totalWeightedTokens: z.number().nonnegative(),
  points: z.array(UsageHistoryAgentPointSchema),
});

// COMPAT(usageHistory): added in v0.8.2, remove gating after 2027-09-23. Gated on
// `server_info.features.usageHistory`.
export const UsageHistoryGetRequestSchema = z.object({
  type: z.literal("usage.history.get.request"),
  requestId: z.string(),
  // Absent means account projections only.
  agentId: z.string().min(1).optional(),
});

export const UsageHistoryGetResponseSchema = z.object({
  type: z.literal("usage.history.get.response"),
  payload: z.object({
    requestId: z.string(),
    generatedAt: z.string(),
    accounts: z.array(UsageHistoryAccountSchema),
    // Present only when the request named an agent that has recorded spend.
    agent: UsageHistoryAgentSchema.optional(),
  }),
});

export type UsageWindowProjection = z.infer<typeof UsageWindowProjectionSchema>;
export type UsageHistoryWindow = z.infer<typeof UsageHistoryWindowSchema>;
export type UsageHistoryAccount = z.infer<typeof UsageHistoryAccountSchema>;
export type UsageHistoryAgentPoint = z.infer<typeof UsageHistoryAgentPointSchema>;
export type UsageHistoryAgent = z.infer<typeof UsageHistoryAgentSchema>;
export type UsageHistoryGetRequest = z.infer<typeof UsageHistoryGetRequestSchema>;
export type UsageHistoryGetResponse = z.infer<typeof UsageHistoryGetResponseSchema>;
