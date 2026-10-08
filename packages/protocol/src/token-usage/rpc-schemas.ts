import { z } from "zod";

// Token usage by model and role, built by the daemon from the Claude and Codex transcripts on
// disk. See docs/token-usage.md.

export const TokenUsageRangeSchema = z.enum(["24h", "7d", "30d"]);

// "leader"  - the session belongs to a Paseo agent with no parent agent
// "worker"  - the session belongs to a Paseo agent spawned by another agent
// "outside" - no Paseo agent owns the session
export const TokenUsageRoleSchema = z.enum(["leader", "worker", "outside"]);

// One provider x model x role with any usage in the range. Counts are the provider's own per-
// response numbers summed; `weighted` is the cost-weighted total (docs/token-burn.md).
export const TokenUsageRowSchema = z.object({
  provider: z.string(),
  // "unknown" when the response carried no model.
  model: z.string(),
  role: TokenUsageRoleSchema,
  input: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  output: z.number().nonnegative(),
  weighted: z.number().nonnegative(),
  responses: z.number().nonnegative(),
});

export const TokenUsageBackfillSchema = z.object({
  // "pending" - enabled, the first sweep has not run yet
  // "running" - reading the last 30 days of transcripts
  // "done"    - caught up; later sweeps only read appended lines
  // "off"     - the feature is turned off in config
  state: z.enum(["pending", "running", "done", "off"]),
  filesDone: z.number().nonnegative(),
  filesTotal: z.number().nonnegative(),
});

export const TokenUsageCoverageSchema = z.object({
  enabled: z.boolean(),
  // When the daemon started recording on this host; null before the first sweep.
  recordingSinceMs: z.number().nullable(),
  backfill: TokenUsageBackfillSchema,
});

// COMPAT(tokenUsage): added in v0.8.x, remove gating after 2027-10-07. Gated on
// `server_info.features.tokenUsage`.
export const TokenUsageGetBreakdownRequestSchema = z.object({
  type: z.literal("usage.tokens.get_breakdown.request"),
  requestId: z.string(),
  range: TokenUsageRangeSchema,
});

export const TokenUsageGetBreakdownResponseSchema = z.object({
  type: z.literal("usage.tokens.get_breakdown.response"),
  payload: z.object({
    requestId: z.string(),
    generatedAt: z.string(),
    range: TokenUsageRangeSchema,
    rangeStartMs: z.number(),
    rows: z.array(TokenUsageRowSchema),
    coverage: TokenUsageCoverageSchema,
    error: z.string().optional(),
  }),
});

export type TokenUsageRange = z.infer<typeof TokenUsageRangeSchema>;
export type TokenUsageRole = z.infer<typeof TokenUsageRoleSchema>;
export type TokenUsageRow = z.infer<typeof TokenUsageRowSchema>;
export type TokenUsageBackfill = z.infer<typeof TokenUsageBackfillSchema>;
export type TokenUsageCoverage = z.infer<typeof TokenUsageCoverageSchema>;
export type TokenUsageGetBreakdownRequest = z.infer<typeof TokenUsageGetBreakdownRequestSchema>;
export type TokenUsageGetBreakdownResponse = z.infer<typeof TokenUsageGetBreakdownResponseSchema>;
