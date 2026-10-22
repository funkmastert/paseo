import { describe, expect, it } from "vitest";
import { priceTokenUsage } from "./token-usage-pricing.js";

describe("priceTokenUsage", () => {
  it("prices a known Claude model from its input/cacheWrite/cacheRead/output counts", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-opus-5-5",
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });

    expect(cost).toBeCloseTo(4.0 + 5.0 + 0.2 + 20.0, 6);
  });

  it("prices a known Codex model", () => {
    const cost = priceTokenUsage({
      provider: "codex",
      model: "gpt-5.3-codex",
      input: 1_000_000,
      cacheWrite: 0,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });

    expect(cost).toBeCloseTo(1.75 + 0.175 + 14.0, 6);
  });

  it("normalizes a dated Claude snapshot id to its canonical price", () => {
    const dated = priceTokenUsage({
      provider: "claude",
      model: "claude-opus-5-20260724",
      input: 1_000_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(dated).toBeCloseTo(5.0, 6);
  });

  it("normalizes a [1m] long-context suffix to its canonical price", () => {
    const longContext = priceTokenUsage({
      provider: "claude",
      model: "claude-sonnet-5-5[1m]",
      input: 1_000_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(longContext).toBeCloseTo(2.0, 6);
  });

  it("returns 0, not null, for an all-zero-usage row on a known model", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-opus-5-5",
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(cost).toBe(0);
  });

  it("returns null for an unrecognized Claude model", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-opus-99",
      input: 1_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(cost).toBeNull();
  });

  it("returns null for a Codex model not on OpenAI's current pricing page", () => {
    const cost = priceTokenUsage({
      provider: "codex",
      model: "gpt-5-codex",
      input: 1_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(cost).toBeNull();
  });

  it("returns null for an unrecognized provider", () => {
    const cost = priceTokenUsage({
      provider: "opencode",
      model: "claude-opus-5-5",
      input: 1_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(cost).toBeNull();
  });
});
