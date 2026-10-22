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

  it("prices Claude Haiku 5.5 even though it is absent from the Claude Code model manifest", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-haiku-5-5",
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });

    expect(cost).toBeCloseTo(0.1 + 0.125 + 0.01 + 0.5, 6);
  });

  it("prices a manifest [1m] id at its base model's rate", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-opus-4-8[1m]",
      input: 1_000_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(cost).toBeCloseTo(5.0, 6);
  });

  it("prices Claude Sonnet 5.5 cache reads at $0.20/MTok, the same rate as Sonnet 5", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-sonnet-5-5",
      input: 0,
      cacheWrite: 0,
      cacheRead: 1_000_000,
      output: 0,
    });

    expect(cost).toBeCloseTo(0.2, 6);
  });

  it("prices Claude Haiku 5.5 at its long-prompt tier when the row's average prompt exceeds 100K tokens", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-haiku-5-5",
      input: 150_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1_000,
      responses: 1,
    });

    expect(cost).toBeCloseTo((150_000 * 0.5 + 1_000 * 2.5) / 1_000_000, 6);
  });

  it("keeps Claude Haiku 5.5 at its base tier when the row's average prompt is 100K tokens or less", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-haiku-5-5",
      input: 100_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1_000,
      responses: 1,
    });

    expect(cost).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1_000_000, 6);
  });

  it("falls back to Claude Haiku 5.5's base tier when the row carries no responses count", () => {
    const cost = priceTokenUsage({
      provider: "claude",
      model: "claude-haiku-5-5",
      input: 150_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });

    expect(cost).toBeCloseTo((150_000 * 0.1) / 1_000_000, 6);
  });

  it("prices the fork's unpriced Codex models at OpenAI's <=272K-token rates", () => {
    const cases: Array<{ model: string; input: number; cacheRead: number; output: number }> = [
      { model: "gpt-6-astra", input: 10, cacheRead: 1, output: 50 },
      { model: "gpt-6.1-sol", input: 2, cacheRead: 0.1, output: 10 },
      { model: "gpt-6-sol", input: 2, cacheRead: 0.2, output: 10 },
      { model: "gpt-6-luna", input: 0.1, cacheRead: 0.01, output: 0.5 },
      { model: "gpt-5.6-sol", input: 4, cacheRead: 0.4, output: 20 },
      { model: "gpt-5.6-terra", input: 2, cacheRead: 0.2, output: 12 },
      { model: "gpt-5.6-luna", input: 0.2, cacheRead: 0.02, output: 1.2 },
    ];

    for (const { model, input, cacheRead, output } of cases) {
      const cost = priceTokenUsage({
        provider: "codex",
        model,
        input: 1_000_000,
        cacheWrite: 0,
        cacheRead: 1_000_000,
        output: 1_000_000,
      });

      expect(cost).toBeCloseTo(input + cacheRead + output, 6);
    }
  });

  it("prices a fork Codex model at OpenAI's >272K-token tier when the row's average prompt exceeds it", () => {
    const cost = priceTokenUsage({
      provider: "codex",
      model: "gpt-6-astra",
      input: 300_000,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1_000,
      responses: 1,
    });

    expect(cost).toBeCloseTo((300_000 * 20 + 1_000 * 75) / 1_000_000, 6);
  });

  it("still returns null for Codex models absent from OpenAI's current pricing page", () => {
    for (const model of ["gpt-5-codex", "gpt-5.1-codex", "gpt-5.1-codex-max"]) {
      const cost = priceTokenUsage({
        provider: "codex",
        model,
        input: 1_000,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
      });

      expect(cost).toBeNull();
    }
  });
});
