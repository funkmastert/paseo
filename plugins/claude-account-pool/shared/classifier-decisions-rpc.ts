/**
 * The classifier-decisions dashboard's plugin RPC pair (docs/arena-ranking.md,
 * "Decisions ledger and dashboard"), following the existing plugin pattern
 * (`shared/role-policy-rpc.ts`'s `defineRpc`) rather than core
 * `docs/rpc-namespacing.md`'s `.request`/`.response` suffix convention, which
 * is for core WebSocket session RPCs, not plugin RPCs.
 */

import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { ClassifierDecisionRowSchema } from "./classifier-decisions-schema";

export const ClassifierDecisionOutcomeSchema = z.object({
  state: z.enum(["running", "finished", "errored", "archived", "unknown"]),
  completion: z.enum(["ready-to-merge", "done"]).nullable(),
  moved: z.boolean(),
  tokens: z.number().nullable(),
  durationMs: z.number().nullable(),
});

export const ClassifierDecisionRowWithOutcomeSchema = ClassifierDecisionRowSchema.extend({
  outcome: ClassifierDecisionOutcomeSchema,
});
export type ClassifierDecisionRowWithOutcomeWire = z.infer<typeof ClassifierDecisionRowWithOutcomeSchema>;

const ClassifierDecisionsFiltersSchema = z.object({
  disagreementsOnly: z.boolean().optional(),
  role: z.string().optional(),
  workKind: z.string().optional(),
});

const ClassifierDecisionsWorkKindSummarySchema = z.object({
  rankedCount: z.number().int(),
  fallbackCount: z.number().int(),
  agreementRate: z.number().nullable(),
  fallbackReasonCounts: z.record(z.string(), z.number().int()),
});

const ClassifierDecisionsOutcomeBucketSchema = z.object({
  model: z.string(),
  workKind: z.string(),
  total: z.number().int(),
  finished: z.number().int(),
  errored: z.number().int(),
  running: z.number().int(),
  archived: z.number().int(),
  unknown: z.number().int(),
  medianTokens: z.number().nullable(),
});

export const ClassifierDecisionsSummarySchema = z.object({
  totalRows: z.number().int(),
  rankedCount: z.number().int(),
  fallbackCount: z.number().int(),
  agreementRate: z.number().nullable(),
  pickDistributionByModel: z.record(z.string(), z.number().int()),
  pickDistributionByTier: z.object({ top: z.number().int(), mid: z.number().int() }),
  topTierRate: z.number().nullable(),
  fallbackReasonCounts: z.record(z.string(), z.number().int()),
  byWorkKind: z.record(z.string(), ClassifierDecisionsWorkKindSummarySchema),
  outcomesByModelAndWorkKind: z.array(ClassifierDecisionsOutcomeBucketSchema),
  caveat: z.string(),
});

/**
 * RPC method names are lowercase-only (`defineRpc`'s `RPC_NAME` regex), so
 * the wire names are kebab-case even though this object's own property names
 * read as `classifierDecisions.list` etc. in prose.
 */
export const classifierDecisionsRpc = {
  list: defineRpc({
    name: "classifier-decisions.list",
    input: ClassifierDecisionsFiltersSchema.extend({
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    output: z.object({
      rows: z.array(ClassifierDecisionRowWithOutcomeSchema),
      nextCursor: z.string().optional(),
    }),
  }),
  summary: defineRpc({
    name: "classifier-decisions.summary",
    input: ClassifierDecisionsFiltersSchema.omit({ disagreementsOnly: true }),
    output: ClassifierDecisionsSummarySchema,
  }),
};
