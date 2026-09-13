import type { AgentTokenRate, AgentTokenRateBucket } from "./agent-sdk-types.js";

/** Bucket width and trailing-window size — see docs/plans/2026-09-12-005-feat-token-burn-indicator-plan.md. */
const BUCKET_WINDOW_MS = 30_000;
const MAX_BUCKETS = 10;
export const TOKEN_RATE_TRACKER_WINDOW_MS = BUCKET_WINDOW_MS * MAX_BUCKETS;

const MIN_SPAN_MS = BUCKET_WINDOW_MS;
const MAX_SPAN_MS = TOKEN_RATE_TRACKER_WINDOW_MS;

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
