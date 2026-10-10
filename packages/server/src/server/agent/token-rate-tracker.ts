import type { AgentTokenRate, AgentTokenRateBucket } from "./agent-sdk-types.js";

/** Bucket width and trailing-window size — see docs/plans/2026-09-12-005-feat-token-burn-indicator-plan.md. */
const BUCKET_WINDOW_MS = 30_000;
const MAX_BUCKETS = 10;
export const TOKEN_RATE_TRACKER_WINDOW_MS = BUCKET_WINDOW_MS * MAX_BUCKETS;

const MIN_SPAN_MS = BUCKET_WINDOW_MS;
const MAX_SPAN_MS = TOKEN_RATE_TRACKER_WINDOW_MS;

/**
 * Cost weights relative to one fresh input token, from Anthropic's list-price ratios (cache
 * write 1.25x, cache read 0.1x, output 5x). Every provider-local burn delta goes through
 * `weighTokenUsage`, so `recentTokenRate` and `totalTokens` measure spend-equivalent tokens
 * rather than raw token traffic. Raw counting was the bug behind the monitor's false alarms: a
 * Claude agent with a 300K context re-reads that context from cache on every tool-call step, so
 * one ordinary short turn counted as ~1.2M tokens (237K/min for five straight minutes) and any
 * long-lived agent crossed 5M "total" every couple of dozen steps. See docs/token-burn.md.
 */
export const TOKEN_BURN_WEIGHTS = {
  input: 1,
  cacheCreation: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

export interface TokenUsageBreakdown {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

function countable(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Cost-weighted token count for one request or turn; 0 when nothing countable was reported. */
export function weighTokenUsage(usage: TokenUsageBreakdown): number {
  return (
    countable(usage.inputTokens) * TOKEN_BURN_WEIGHTS.input +
    countable(usage.cacheCreationInputTokens) * TOKEN_BURN_WEIGHTS.cacheCreation +
    countable(usage.cacheReadInputTokens) * TOKEN_BURN_WEIGHTS.cacheRead +
    countable(usage.outputTokens) * TOKEN_BURN_WEIGHTS.output
  );
}

function pruneBuckets(
  buckets: readonly AgentTokenRateBucket[],
  nowMs: number,
): AgentTokenRateBucket[] {
  const cutoff = nowMs - TOKEN_RATE_TRACKER_WINDOW_MS;
  return buckets.filter((bucket) => bucket.bucketStartMs >= cutoff);
}

/**
 * Records one provider-local turn delta into the ring buffer, pruning anything older than the
 * trailing window. Zero/negative/non-finite deltas are ignored (never fabricated activity) and
 * return the input buckets unchanged.
 */
export function recordTokenDelta(
  buckets: readonly AgentTokenRateBucket[],
  delta: number,
  nowMs: number,
): AgentTokenRateBucket[] {
  if (!Number.isFinite(delta) || delta <= 0) {
    return buckets as AgentTokenRateBucket[];
  }

  const bucketStartMs = Math.floor(nowMs / BUCKET_WINDOW_MS) * BUCKET_WINDOW_MS;
  const pruned = pruneBuckets(buckets, nowMs);
  const last = pruned[pruned.length - 1];
  if (last && last.bucketStartMs === bucketStartMs) {
    return [...pruned.slice(0, -1), { bucketStartMs, tokens: last.tokens + delta }];
  }
  return [...pruned, { bucketStartMs, tokens: delta }];
}

/**
 * Derives the current tokens/min rate from the ring buffer, or undefined when there is nothing
 * to measure — an idle/new agent reports absence, never a fabricated zero. The elapsed span is
 * clamped to [30s, 5min] so a single fresh bucket doesn't imply an instantaneous (near-infinite)
 * rate, and a gap-riddled buffer doesn't understate it beyond the tracked window.
 */
export function computeTokenRate(
  buckets: readonly AgentTokenRateBucket[] | undefined,
  nowMs: number,
): AgentTokenRate | undefined {
  const pruned = pruneBuckets(buckets ?? [], nowMs);
  if (pruned.length === 0) {
    return undefined;
  }

  const totalTokens = pruned.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const earliestBucketStartMs = Math.min(...pruned.map((bucket) => bucket.bucketStartMs));
  const rawSpanMs = nowMs - earliestBucketStartMs;
  const spanMs = Math.min(Math.max(rawSpanMs, MIN_SPAN_MS), MAX_SPAN_MS);

  return {
    tokensPerMinute: totalTokens / (spanMs / 60_000),
    asOfMs: nowMs,
  };
}
