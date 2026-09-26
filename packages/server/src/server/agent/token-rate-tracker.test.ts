import { expect, test } from "vitest";
import {
  computeTokenRate,
  recordTokenDelta,
  TOKEN_BURN_WEIGHTS,
  TOKEN_RATE_TRACKER_WINDOW_MS,
  weighTokenUsage,
} from "./token-rate-tracker.js";

const BASE_MS = 1_700_000_000_000;

test("weighTokenUsage prices cache reads at a tenth and output at five times a fresh input token", () => {
  expect(TOKEN_BURN_WEIGHTS).toEqual({ input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 });
  expect(
    weighTokenUsage({
      inputTokens: 100,
      cacheCreationInputTokens: 40,
      cacheReadInputTokens: 1000,
      outputTokens: 10,
    }),
  ).toBe(100 + 50 + 100 + 50);
});

test("weighTokenUsage treats missing, negative, and non-finite counts as zero", () => {
  expect(weighTokenUsage({})).toBe(0);
  expect(
    weighTokenUsage({ inputTokens: -5, cacheReadInputTokens: Number.NaN, outputTokens: undefined }),
  ).toBe(0);
});

test("a 300K-context agent's short turn no longer reads as a burn spike", () => {
  // The real trace behind the false alarms: 4 fresh input tokens, 1.18M cache-read tokens,
  // 847 output tokens for one short answer. Raw it was ~1.18M; weighted it is ~123K.
  const weighted = weighTokenUsage({
    inputTokens: 4,
    cacheReadInputTokens: 1_183_978,
    outputTokens: 847,
  });
  expect(Math.round(weighted)).toBe(122_637);
});

test("recordTokenDelta accumulates within the same 30s bucket", () => {
  const first = recordTokenDelta([], 100, BASE_MS);
  const second = recordTokenDelta(first, 50, BASE_MS + 1_000);
  expect(second).toEqual([{ bucketStartMs: Math.floor(BASE_MS / 30_000) * 30_000, tokens: 150 }]);
});

test("recordTokenDelta opens a new bucket once the 30s window advances", () => {
  const first = recordTokenDelta([], 100, BASE_MS);
  const second = recordTokenDelta(first, 50, BASE_MS + 30_000);
  expect(second).toHaveLength(2);
  expect(second[0]?.tokens).toBe(100);
  expect(second[1]?.tokens).toBe(50);
});

test("recordTokenDelta prunes buckets older than the trailing window", () => {
  const old = recordTokenDelta([], 100, BASE_MS);
  const later = recordTokenDelta(old, 50, BASE_MS + TOKEN_RATE_TRACKER_WINDOW_MS + 60_000);
  expect(later).toHaveLength(1);
  expect(later[0]?.tokens).toBe(50);
});

test("recordTokenDelta ignores zero and negative deltas, returning the input unchanged", () => {
  const buckets = recordTokenDelta([], 100, BASE_MS);
  expect(recordTokenDelta(buckets, 0, BASE_MS + 1_000)).toBe(buckets);
  expect(recordTokenDelta(buckets, -5, BASE_MS + 1_000)).toBe(buckets);
});

test("computeTokenRate is undefined for an empty ring buffer", () => {
  expect(computeTokenRate([], BASE_MS)).toBeUndefined();
  expect(computeTokenRate(undefined, BASE_MS)).toBeUndefined();
});

test("computeTokenRate is undefined once every bucket has aged out of the trailing window", () => {
  // A hand-built stale buffer, independent of recordTokenDelta's own write-time pruning — a read
  // long after the last turn must report absence, not a rate computed from ancient activity.
  const staleBucket = {
    bucketStartMs: BASE_MS - TOKEN_RATE_TRACKER_WINDOW_MS - 60_000,
    tokens: 500,
  };
  expect(computeTokenRate([staleBucket], BASE_MS)).toBeUndefined();
});

test("computeTokenRate divides by elapsed span, clamped to a 30s floor", () => {
  // A single fresh bucket read a moment after it opened would otherwise imply a huge
  // instantaneous rate; the floor keeps it sane instead of near-infinite.
  const buckets = recordTokenDelta([], 300, BASE_MS);
  const rate = computeTokenRate(buckets, BASE_MS + 1_000);
  expect(rate).toEqual({ tokensPerMinute: 300 / (30_000 / 60_000), asOfMs: BASE_MS + 1_000 });
});

test("computeTokenRate sums every surviving bucket across the trailing window", () => {
  let buckets = recordTokenDelta([], 100, BASE_MS);
  buckets = recordTokenDelta(buckets, 200, BASE_MS + 60_000);
  const nowMs = BASE_MS + 90_000;
  const earliestBucketStartMs = Math.floor(BASE_MS / 30_000) * 30_000;
  const rate = computeTokenRate(buckets, nowMs);
  expect(rate?.tokensPerMinute).toBeCloseTo(300 / ((nowMs - earliestBucketStartMs) / 60_000), 5);
});
