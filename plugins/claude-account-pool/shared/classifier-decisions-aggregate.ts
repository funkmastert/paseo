/**
 * Pure aggregation for the classifier-decisions dashboard (docs/arena-ranking.md,
 * "Decisions ledger and dashboard"): joins a durable ledger row (U2/U3) with
 * the agent's CURRENT state (KTD-1 — outcome is never stored on the row
 * itself, since an agent's status changes after its decision was made) and
 * rolls rows up into the dashboard's summary. No I/O: callers fetch the
 * ledger rows and the agent snapshots; this module only computes.
 */

import { getCompletionStateFromLabels, ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import type { ClassifierDecisionRow } from "./classifier-decisions-schema";

/** The subset of an agent snapshot (`paseo.agents.list()`'s per-entry `agent`) the join needs. */
export interface AgentOutcomeSnapshot {
  lastStatus?: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
  /** Cost-weighted total, as the snapshot's own `totalTokens` reports it. */
  totalTokens?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type ClassifierDecisionOutcomeState = "running" | "finished" | "errored" | "archived" | "unknown";

export interface ClassifierDecisionOutcome {
  state: ClassifierDecisionOutcomeState;
  completion: "ready-to-merge" | "done" | null;
  /** Cheap signal only (docs/arena-ranking.md's Deferred note): whether a failover move ever touched this agent, not a full history. */
  moved: boolean;
  tokens: number | null;
  durationMs: number | null;
}

const UNKNOWN_OUTCOME: ClassifierDecisionOutcome = { state: "unknown", completion: null, moved: false, tokens: null, durationMs: null };

function durationMsFor(agent: AgentOutcomeSnapshot): number | null {
  if (!agent.createdAt) {
    return null;
  }
  const start = Date.parse(agent.createdAt);
  if (Number.isNaN(start)) {
    return null;
  }
  const completionAt = agent.labels?.["paseo.completion-at"];
  const candidates = [agent.updatedAt, agent.archivedAt, completionAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => !Number.isNaN(value));
  if (candidates.length === 0) {
    return null;
  }
  const end = Math.max(...candidates);
  return end >= start ? end - start : null;
}

/** An agent the sweep could no longer find (deleted project dir) reads as `state: "unknown"` rather than failing the response. */
export function joinOutcome(agent: AgentOutcomeSnapshot | undefined): ClassifierDecisionOutcome {
  if (!agent) {
    return UNKNOWN_OUTCOME;
  }
  const state: ClassifierDecisionOutcomeState =
    agent.archivedAt != null
      ? "archived"
      : agent.lastStatus === "error"
        ? "errored"
        : agent.lastStatus === "running" || agent.lastStatus === "initializing"
          ? "running"
          : "finished";
  return {
    state,
    completion: getCompletionStateFromLabels(agent.labels),
    moved: agent.labels?.[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL] !== undefined,
    tokens: typeof agent.totalTokens === "number" ? agent.totalTokens : null,
    durationMs: durationMsFor(agent),
  };
}

export interface ClassifierDecisionWithOutcome {
  row: ClassifierDecisionRow;
  outcome: ClassifierDecisionOutcome;
}

const UNKNOWN_KEY = "unknown";

function bucketKey(value: string | null): string {
  return value ?? UNKNOWN_KEY;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export interface ClassifierDecisionsWorkKindSummary {
  rankedCount: number;
  fallbackCount: number;
  /** Ranked rows where the would-be pick's ref equals the model that ran, over ranked rows in this bucket. `null` when there are none. */
  agreementRate: number | null;
  fallbackReasonCounts: Record<string, number>;
}

export interface ClassifierDecisionsOutcomeBucket {
  model: string;
  workKind: string;
  total: number;
  finished: number;
  errored: number;
  running: number;
  archived: number;
  unknown: number;
  /** `null` when no row in this bucket has a known token total. */
  medianTokens: number | null;
}

export interface ClassifierDecisionsSummary {
  totalRows: number;
  rankedCount: number;
  fallbackCount: number;
  agreementRate: number | null;
  pickDistributionByModel: Record<string, number>;
  pickDistributionByTier: { top: number; mid: number };
  /** Share of ranked rows whose pick was a `topTier` ref. `null` when there are no ranked rows. */
  topTierRate: number | null;
  fallbackReasonCounts: Record<string, number>;
  byWorkKind: Record<string, ClassifierDecisionsWorkKindSummary>;
  /** The only real performance evidence there is, since a would-be pick never ran (R4). */
  outcomesByModelAndWorkKind: ClassifierDecisionsOutcomeBucket[];
  caveat: string;
}

export const CLASSIFIER_DECISIONS_CAVEAT =
  "A would-be pick never ran, so the only real performance evidence here is the outcome rate of the model that actually ran, split by model and work kind — not a comparison of the would-be pick against anything it did.";

/** Rolls up ledger rows, each joined with its current outcome, into the dashboard summary (R4). */
export function summarize(entries: readonly ClassifierDecisionWithOutcome[]): ClassifierDecisionsSummary {
  let rankedCount = 0;
  let fallbackCount = 0;
  let agreeCount = 0;
  let topTierCount = 0;
  const pickDistributionByModel: Record<string, number> = {};
  const pickDistributionByTier = { top: 0, mid: 0 };
  const fallbackReasonCounts: Record<string, number> = {};
  const byWorkKind: Record<string, ClassifierDecisionsWorkKindSummary & { agreeCount: number }> = {};
  const outcomeBuckets = new Map<
    string,
    { model: string; workKind: string; total: number; finished: number; errored: number; running: number; archived: number; unknown: number; tokens: number[] }
  >();

  const workKindBucket = (workKind: string) =>
    (byWorkKind[workKind] ??= { rankedCount: 0, fallbackCount: 0, agreementRate: null, fallbackReasonCounts: {}, agreeCount: 0 });

  for (const { row, outcome } of entries) {
    const workKind = bucketKey(row.workKind);
    const wk = workKindBucket(workKind);

    if (row.arena.outcome === "ranked") {
      rankedCount += 1;
      wk.rankedCount += 1;
      increment(pickDistributionByModel, row.arena.ref);
      pickDistributionByTier[row.arena.tier] += 1;
      if (row.arena.tier === "top") {
        topTierCount += 1;
      }
      if (row.modelRan !== null && row.modelRan === row.arena.ref) {
        agreeCount += 1;
        wk.agreeCount += 1;
      }
    } else {
      fallbackCount += 1;
      wk.fallbackCount += 1;
      increment(fallbackReasonCounts, row.arena.reason);
      increment(wk.fallbackReasonCounts, row.arena.reason);
    }

    const model = bucketKey(row.modelRan);
    const bucketId = `${model}\u0000${workKind}`;
    const bucket = outcomeBuckets.get(bucketId) ?? {
      model,
      workKind,
      total: 0,
      finished: 0,
      errored: 0,
      running: 0,
      archived: 0,
      unknown: 0,
      tokens: [],
    };
    bucket.total += 1;
    bucket[outcome.state] += 1;
    if (outcome.tokens !== null) {
      bucket.tokens.push(outcome.tokens);
    }
    outcomeBuckets.set(bucketId, bucket);
  }

  const resolvedByWorkKind: Record<string, ClassifierDecisionsWorkKindSummary> = {};
  for (const [workKind, wk] of Object.entries(byWorkKind)) {
    const { agreeCount, ...rest } = wk;
    resolvedByWorkKind[workKind] = { ...rest, agreementRate: wk.rankedCount > 0 ? agreeCount / wk.rankedCount : null };
  }

  return {
    totalRows: entries.length,
    rankedCount,
    fallbackCount,
    agreementRate: rankedCount > 0 ? agreeCount / rankedCount : null,
    pickDistributionByModel,
    pickDistributionByTier,
    topTierRate: rankedCount > 0 ? topTierCount / rankedCount : null,
    fallbackReasonCounts,
    byWorkKind: resolvedByWorkKind,
    outcomesByModelAndWorkKind: [...outcomeBuckets.values()].map((bucket) => ({
      model: bucket.model,
      workKind: bucket.workKind,
      total: bucket.total,
      finished: bucket.finished,
      errored: bucket.errored,
      running: bucket.running,
      archived: bucket.archived,
      unknown: bucket.unknown,
      medianTokens: median(bucket.tokens),
    })),
    caveat: CLASSIFIER_DECISIONS_CAVEAT,
  };
}
