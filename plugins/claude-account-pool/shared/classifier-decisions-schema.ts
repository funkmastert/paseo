/**
 * The durable counterpart to `decision-log.ts`'s `classifier-decision` line
 * (docs/arena-ranking.md, "Decisions ledger and dashboard"): one row per
 * create whose decision reached an arena outcome (ranked or fallback), kept
 * across log rotation and daemon restarts so the classifier-decisions
 * dashboard has history to show.
 */

import { z } from "zod";

export const ArenaPickSnapshotSchema = z.object({
  ref: z.string(),
  rating: z.number(),
  ratingLower: z.number(),
  ratingUpper: z.number(),
  votes: z.number(),
  effort: z.string(),
  proxy: z.boolean(),
});
export type ArenaPickSnapshot = z.infer<typeof ArenaPickSnapshotSchema>;

/** Mirrors `arena-model-pick.ts`'s `ArenaPickDecision`, as `decision-log.ts`'s `describeRanking()` serializes it. */
export const ClassifierDecisionArenaSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("fallback"), reason: z.string() }),
  z.object({
    outcome: z.literal("ranked"),
    applied: z.boolean(),
    ref: z.string(),
    tier: z.enum(["top", "mid"]),
    board: z.string(),
    publishDate: z.string(),
    pick: ArenaPickSnapshotSchema,
    comparedTo: ArenaPickSnapshotSchema.optional(),
  }),
]);
export type ClassifierDecisionArena = z.infer<typeof ClassifierDecisionArenaSchema>;

export const ClassifierDecisionRowSchema = z.object({
  /** Same correlation id `decisionLog.tag`/`untag` use for this create — stable, opaque, not an agent id. */
  id: z.string(),
  /** ISO. When the create was decided (fallback: when the agent was created, the nearest timestamp on hand). */
  at: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  role: z.string().nullable(),
  taskClass: z.string().nullable(),
  workKind: z.string().nullable(),
  /** The model that actually ran, as `decision-log.ts`'s `finalModel()` reports it. */
  modelRan: z.string().nullable(),
  arena: ClassifierDecisionArenaSchema,
  /** True for a row reconstructed from historical `paseo.arena-pick` labels (U3) rather than written live. */
  backfilled: z.boolean(),
});
export type ClassifierDecisionRow = z.infer<typeof ClassifierDecisionRowSchema>;

export const ClassifierDecisionsFileSchema = z.object({
  v: z.literal(1),
  rows: z.array(ClassifierDecisionRowSchema),
  /** Set once the historical backfill (U3) has run; its absence is what gates the one-time sweep. */
  backfilledAt: z.string().optional(),
});
export type ClassifierDecisionsFile = z.infer<typeof ClassifierDecisionsFileSchema>;
