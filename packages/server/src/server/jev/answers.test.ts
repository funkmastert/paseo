import { describe, expect, it } from "vitest";

import { confidentChoice, confidentScore, noulOf, shadowAnswers } from "./answers.js";
import type { JevAnswer, JevCallMeta, JevOutcome } from "./contract.js";

const meta: JevCallMeta = {
  model: "jev-fake",
  elapsedMs: 1,
  attempts: 1,
  inputTokens: 1,
  outputTokens: 0,
  stateBytes: 1,
  bodyBytes: 1,
  redactions: 0,
  cost: { usd: 0, source: "fake" },
};

const answers: Record<string, JevAnswer> = {
  route: {
    type: "choice",
    choice: "needs_person",
    probabilities: { needs_person: 0.84, other: 0.16 },
    confidence: 0.84,
  },
  current: { type: "noul", noul: 0.3 },
  reasoning: {
    type: "score",
    score: 1.7,
    legend: { "0": "a", "1": "b", "2": "c" },
    probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
    confidence: 0.8,
  },
};

const answered: JevOutcome = { kind: "answered", callId: "c", answers, meta };

describe("reading an outcome", () => {
  it("returns the answer when answered above the floor", () => {
    expect(confidentChoice(answered, "route", 0.8)).toBe("needs_person");
    expect(noulOf(answered, "current")).toBe(0.3);
    expect(confidentScore(answered, "reasoning", 0.5)).toBe(1.7);
  });

  it("returns null, today's behaviour, for a low-confidence answer", () => {
    expect(confidentChoice(answered, "route", 0.85)).toBeNull();
    expect(confidentScore(answered, "reasoning", 0.9)).toBeNull();
  });

  it("returns null for every outcome other than answered", () => {
    const others: JevOutcome[] = [
      { kind: "shadow", callId: "c", answers, meta },
      { kind: "unavailable", callId: "c", reason: "no-key" },
      { kind: "unavailable", callId: "c", reason: "disabled" },
      { kind: "unavailable", callId: "c", reason: "saturated" },
      { kind: "failed", callId: "c", reason: "timeout", meta },
      { kind: "failed", callId: "c", reason: "contract", meta: null },
    ];
    for (const outcome of others) {
      expect(confidentChoice(outcome, "route", 0)).toBeNull();
      expect(noulOf(outcome, "current")).toBeNull();
      expect(confidentScore(outcome, "reasoning")).toBeNull();
    }
  });

  it("returns null for a missing or mistyped answer", () => {
    expect(confidentChoice(answered, "current", 0)).toBeNull();
    expect(noulOf(answered, "route")).toBeNull();
    expect(confidentScore(answered, "absent")).toBeNull();
  });

  it("exposes shadow answers only for the would-have record", () => {
    expect(shadowAnswers({ kind: "shadow", callId: "c", answers, meta })).toBe(answers);
    expect(shadowAnswers(answered)).toBeNull();
  });
});
