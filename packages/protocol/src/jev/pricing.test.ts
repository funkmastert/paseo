import { describe, expect, test } from "vitest";

import { normalizeSavingsModel, priceWeight } from "./pricing.js";

describe("priceWeight", () => {
  test("prices against Opus 5.5, whatever the spelling", () => {
    expect(priceWeight("claude-opus-5-5")).toBe(1);
    expect(priceWeight("claude-opus-5-5[1m]")).toBe(1);
    expect(priceWeight("us.anthropic.claude-opus-5-5-v1:0")).toBe(1);
    expect(priceWeight("claude-opus-5")).toBe(1.25);
    expect(priceWeight("claude-sonnet-5-5")).toBe(0.5);
    expect(priceWeight("claude-sonnet-5")).toBe(0.5);
    expect(priceWeight("claude/claude-haiku-4-5-20251001")).toBe(0.25);
    expect(normalizeSavingsModel("Claude-Haiku-4-5")).toBe("claude-haiku-4-5");
  });

  test("an unknown model has no weight", () => {
    expect(priceWeight("gpt-5.4")).toBeNull();
    expect(priceWeight("opus")).toBeNull();
    expect(priceWeight(null)).toBeNull();
  });
});
