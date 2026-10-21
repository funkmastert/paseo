import { describe, expect, test } from "vitest";
import { estimatedSavedWeightedTokens, stepCost } from "./compaction-ledger-cost.js";

describe("stepCost", () => {
  test("diffs totalTokens snapshots when both are present", () => {
    expect(stepCost(100_000, 100_450)).toBe(450);
  });

  test("is null when the start snapshot is missing", () => {
    expect(stepCost(undefined, 100_450)).toBeNull();
  });

  test("is null when the end snapshot is missing", () => {
    expect(stepCost(100_000, undefined)).toBeNull();
  });

  test("clamps a negative diff to zero rather than reporting a negative cost", () => {
    expect(stepCost(100_450, 100_000)).toBe(0);
  });
});

describe("estimatedSavedWeightedTokens", () => {
  test("multiplies dropped tokens by requests since, at the cache-read weight", () => {
    expect(estimatedSavedWeightedTokens(400_000, 20_000, 10)).toBe(380_000);
  });

  test("is null when contextBeforeTokens is missing", () => {
    expect(estimatedSavedWeightedTokens(null, 20_000, 10)).toBeNull();
  });

  test("is null when contextAfterTokens is missing", () => {
    expect(estimatedSavedWeightedTokens(400_000, null, 10)).toBeNull();
  });

  test("zero requests since yields zero saved, not null", () => {
    expect(estimatedSavedWeightedTokens(400_000, 20_000, 0)).toBe(0);
  });

  test("clamps a non-shrinking compaction to zero dropped tokens", () => {
    expect(estimatedSavedWeightedTokens(20_000, 400_000, 10)).toBe(0);
  });
});
