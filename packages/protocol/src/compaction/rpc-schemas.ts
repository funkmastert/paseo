import { z } from "zod";

// The compaction episode ledger (docs/insights.md): one row per leader-compaction episode, with
// a measured or unmeasured cost and an estimated payback. Gated on
// `server_info.features.compactionLedger`.

// "today" | "7d" | "all"
export const CompactionRangeSchema = z.string();

// Open strings, not closed enums, for the reason every other role/state field in this protocol
// is open (docs/protocol-compatibility.md — never narrow): a daemon that adds a new step outcome,
// trigger kind, or episode source must not fail validation on an older app that doesn't know it.
export const CompactionStepNameSchema = z.string();
export const CompactionStepOutcomeSchema = z.string();
export const CompactionEpisodeSourceSchema = z.string();
export const CompactionEpisodeTriggerSchema = z.string();
export const CompactionEpisodeOutcomeSchema = z.string();
export const CompactionCostBasisSchema = z.string();

export const CompactionStepSchema = z.object({
  step: CompactionStepNameSchema,
  startedAtMs: z.number(),
  endedAtMs: z.number().nullable(),
  outcome: CompactionStepOutcomeSchema,
  costWeightedTokens: z.number().nullable(),
});

export const CompactionQuietGateSchema = z.object({
  quietMinutes: z.number(),
  ceilingTokens: z.number(),
});

export const CompactionEpisodeSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  source: CompactionEpisodeSourceSchema,
  trigger: CompactionEpisodeTriggerSchema,
  triggerReason: z.string().nullable(),
  startedAtMs: z.number(),
  endedAtMs: z.number().nullable(),
  steps: z.array(CompactionStepSchema),
  contextBeforeTokens: z.number().nullable(),
  contextAfterTokens: z.number().nullable(),
  outcome: CompactionEpisodeOutcomeSchema,
  noteLength: z.number().nullable(),
  // Optional until the quiet-gate branch lands (docs/leader-compaction.md); absent on an older
  // daemon or an episode that predates it.
  promptsCarried: z.number().nullable().optional(),
  quietGate: CompactionQuietGateSchema.nullable().optional(),
  costWeightedTokens: z.number().nullable(),
  costBasis: CompactionCostBasisSchema,
  estimatedSavedWeightedTokens: z.number().nullable(),
});

export const CompactionEpisodesListRequestSchema = z.object({
  type: z.literal("compaction.episodes.list.request"),
  requestId: z.string(),
  range: CompactionRangeSchema,
  agentId: z.string().optional(),
  // The previous page's `nextCursor`.
  cursor: z.string().optional(),
  // Default 50, at most 200.
  limit: z.number().optional(),
});

export const CompactionEpisodesListResponseSchema = z.object({
  type: z.literal("compaction.episodes.list.response"),
  payload: z.object({
    requestId: z.string(),
    episodes: z.array(CompactionEpisodeSchema),
    nextCursor: z.string().nullable(),
  }),
});

export const CompactionEpisodesSummarySchema = z.object({
  count: z.number(),
  totalCostWeightedTokens: z.number(),
  averageCostWeightedTokens: z.number(),
  totalEstimatedSavedWeightedTokens: z.number(),
  measuredCount: z.number(),
  unmeasuredCount: z.number(),
});

export const CompactionEpisodesSummaryRequestSchema = z.object({
  type: z.literal("compaction.episodes.summary.request"),
  requestId: z.string(),
  range: CompactionRangeSchema,
  agentId: z.string().optional(),
});

export const CompactionEpisodesSummaryResponseSchema = z.object({
  type: z.literal("compaction.episodes.summary.response"),
  payload: z.object({
    requestId: z.string(),
    summary: CompactionEpisodesSummarySchema,
  }),
});

export type CompactionRange = z.infer<typeof CompactionRangeSchema>;
export type CompactionStep = z.infer<typeof CompactionStepSchema>;
export type CompactionQuietGate = z.infer<typeof CompactionQuietGateSchema>;
export type CompactionEpisode = z.infer<typeof CompactionEpisodeSchema>;
export type CompactionEpisodesListRequest = z.infer<typeof CompactionEpisodesListRequestSchema>;
export type CompactionEpisodesListResponse = z.infer<typeof CompactionEpisodesListResponseSchema>;
export type CompactionEpisodesSummary = z.infer<typeof CompactionEpisodesSummarySchema>;
export type CompactionEpisodesSummaryRequest = z.infer<
  typeof CompactionEpisodesSummaryRequestSchema
>;
export type CompactionEpisodesSummaryResponse = z.infer<
  typeof CompactionEpisodesSummaryResponseSchema
>;
