import { describe, expect, test } from "vitest";

import type {
  JevSavingsDecision,
  JevSavingsFeature,
  JevSavingsMode,
  JevSavingsValidation,
} from "./contract.js";
import {
  estimateContextTokens,
  evaluateEvidence,
  evidenceCounters,
  extraStepTokens,
  normalizeSavingsModel,
  priceSavings,
  priceWeight,
  usdToOpusTokens,
  type JevSavingsFacts,
} from "./savings-formulas.js";

function price(
  feature: JevSavingsFeature,
  mode: JevSavingsMode,
  decision: Partial<JevSavingsDecision>,
  facts: JevSavingsFacts,
  validation: JevSavingsValidation | null = null,
) {
  return priceSavings({
    feature,
    mode,
    decision: { did: "", wouldBe: null, changed: false, ...decision },
    facts,
    validation,
  });
}

const held: JevSavingsValidation = { outcome: "held", signal: null, afterMinutes: 60 };

describe("the unit", () => {
  test("price weights against Opus 5.5, whatever the spelling", () => {
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

  test("2.35 characters a token, $0.0001 of JEV is 25 tokens, S(C) = 0.1C + 2,200", () => {
    expect(estimateContextTokens(2_350)).toBe(1_000);
    expect(estimateContextTokens(0)).toBe(0);
    expect(usdToOpusTokens(0.0001)).toBeCloseTo(25, 6);
    expect(extraStepTokens(228_000)).toBe(25_000);
  });
});

describe("feature 2, spawn hint: W x (w(base) - w(m))", () => {
  test("a shadow move down prices the would-be model", () => {
    const result = price(
      "spawnHint",
      "shadow",
      { did: "standard", wouldBe: "mechanical" },
      {
        baseModel: "claude-sonnet-5",
        wouldModel: "claude-haiku-4-5",
        runningModel: "claude-sonnet-5",
        agentTotalTokens: 100_000,
      },
    );
    expect(result).toMatchObject({ benefit: "tokens", tokens: 25_000, pending: false });
    expect(result.basis?.inputs).toMatchObject({ W: 100_000, "w(base)": 0.5, "w(m)": 0.25 });
  });

  test("a live move up is negative: the model that ran costs more", () => {
    const result = price(
      "spawnHint",
      "live",
      { did: "hard", wouldBe: "hard", changed: true },
      {
        baseModel: "claude-sonnet-5",
        wouldModel: "claude-opus-5-5",
        runningModel: "claude-opus-5-5",
        agentTotalTokens: 100_000,
      },
    );
    expect(result.tokens).toBe(-50_000);
  });

  test("pending until the child's tokens arrive; partial then settles with no figure", () => {
    const facts = { baseModel: "claude-sonnet-5", wouldModel: "claude-haiku-4-5" };
    expect(price("spawnHint", "shadow", {}, facts)).toMatchObject({ pending: true, tokens: null });
    expect(price("spawnHint", "shadow", {}, { ...facts, partial: true })).toMatchObject({
      pending: false,
      tokens: null,
    });
  });

  test("an unknown model gives null", () => {
    const result = price(
      "spawnHint",
      "shadow",
      {},
      {
        baseModel: "claude-sonnet-5",
        wouldModel: "gpt-5.4",
        agentTotalTokens: 1_000,
      },
    );
    expect(result).toMatchObject({ tokens: null, pending: false });
  });
});

describe("feature 3a, remediation triage", () => {
  const skip = { did: "start-agent", wouldBe: "person" };

  test("a shadow skip whose agent ended NOT FIXED saves A x w(m), would-have", () => {
    const result = price("remediationTriage", "shadow", skip, {
      fixed: false,
      agentTotalTokens: 40_000,
      agentModel: "claude-sonnet-5",
    });
    expect(result).toMatchObject({ tokens: 20_000, pending: false });
  });

  test("a shadow skip whose agent fixed it saves nothing", () => {
    expect(
      price("remediationTriage", "shadow", skip, { fixed: true, agentTotalTokens: 40_000 }).tokens,
    ).toBe(0);
  });

  test("a shadow skip waits on the agent's end", () => {
    expect(price("remediationTriage", "shadow", skip, {}).pending).toBe(true);
  });

  test("a live person skip is the kind's median: the agent never ran", () => {
    const result = price(
      "remediationTriage",
      "live",
      { did: "person", wouldBe: "person", changed: true },
      {
        medianTokens: 30_000,
        medianSamples: 7,
      },
    );
    expect(result).toMatchObject({ tokens: 30_000, pending: false });
  });

  test("a live defer counts only when the condition cleared during the hold with no agent", () => {
    const defer = { did: "defer", wouldBe: "defer", changed: true };
    expect(price("remediationTriage", "live", defer, { medianTokens: 30_000 }).pending).toBe(true);
    expect(
      price("remediationTriage", "live", defer, {
        medianTokens: 30_000,
        closed: true,
        clearedDuringHold: true,
        agentRan: false,
      }).tokens,
    ).toBe(30_000);
    expect(
      price("remediationTriage", "live", defer, {
        medianTokens: 30_000,
        closed: true,
        clearedDuringHold: false,
      }).tokens,
    ).toBe(0);
  });

  test("an answer that keeps the agent saves nothing", () => {
    expect(
      price("remediationTriage", "shadow", { did: "start-agent", wouldBe: "start-agent" }, {})
        .tokens,
    ).toBe(0);
  });
});

describe("feature 3b, finish triage: attention, never tokens", () => {
  test("a would-be notice is one push held, and no token figure", () => {
    const result = price("notificationTriage", "shadow", { did: "alert", wouldBe: "notice" }, {});
    expect(result).toMatchObject({
      benefit: "attention",
      tokens: null,
      otherBenefit: { unit: "pushes-held", value: 1 },
    });
  });

  test("a contradicted notice held nothing", () => {
    const result = price(
      "notificationTriage",
      "shadow",
      { did: "alert", wouldBe: "notice" },
      {},
      { outcome: "contradicted", signal: "messaged-within-30m", afterMinutes: 4 },
    );
    expect(result.otherBenefit).toEqual({ unit: "pushes-held", value: 0 });
  });

  test("an alert that stays an alert holds nothing", () => {
    expect(
      price("notificationTriage", "shadow", { did: "alert", wouldBe: "alert" }, {}).otherBenefit,
    ).toBeNull();
  });
});

describe("features 4-6, agent tools", () => {
  const facts = {
    tool: "ask_jev_file_bool",
    answered: true,
    tAvoided: 10_000,
    tResult: 200,
    callerContextTokens: 100_000,
    model: "claude-sonnet-5",
  };

  test("held: (T_avoided - T_result) x R x w(m) - S(C) x w(m)", () => {
    expect(price("agentTools", "live", { did: "answered" }, facts, held).tokens).toBe(64_950);
  });

  test("pending until the regret window closes; no figure when nothing watched it", () => {
    expect(price("agentTools", "live", { did: "answered" }, facts)).toMatchObject({
      tokens: null,
      pending: true,
    });
    for (const regretWatch of ["unobserved", "none"]) {
      expect(
        price("agentTools", "live", { did: "answered" }, { ...facts, regretWatch }),
      ).toMatchObject({ benefit: "tokens", tokens: null, pending: false });
    }
  });

  test("a regret read costs the result's residency and the extra step", () => {
    const result = price("agentTools", "live", { did: "answered" }, facts, {
      outcome: "regret",
      signal: "reread",
      afterMinutes: 3,
    });
    expect(result.tokens).toBe(-7_550);
  });

  test("ask_jev_diff_risk claims nothing; an unanswered call saves nothing", () => {
    expect(price("agentTools", "live", {}, { ...facts, tool: "ask_jev_diff_risk" })).toMatchObject({
      benefit: "none",
      tokens: null,
    });
    expect(price("agentTools", "live", {}, { ...facts, answered: false }).tokens).toBe(0);
  });

  test("an unknown caller context uses the fleet median and says so", () => {
    const result = price("agentTools", "live", {}, { ...facts, callerContextTokens: null }, held);
    expect(result.basis?.inputs["C source"]).toContain("fleet median");
  });
});

describe("feature 10, stall judgment", () => {
  test("a shadow person-first label whose agent ended NOT FIXED saves its A x w(m)", () => {
    const result = price(
      "stallJudgment",
      "shadow",
      {},
      {
        personFirst: true,
        agentRan: true,
        fixed: false,
        agentTotalTokens: 50_000,
        agentModel: "claude-haiku-4-5",
      },
    );
    expect(result).toMatchObject({ tokens: 12_500, pending: false });
  });

  test("the loop watch and a stall that never reached rung 2 save nothing", () => {
    expect(
      price("stallJudgment", "shadow", {}, { personFirst: false, activity: "looping" }).tokens,
    ).toBe(0);
    expect(
      price("stallJudgment", "shadow", {}, { personFirst: true, reachedRung2: false }).tokens,
    ).toBe(0);
  });

  test("live, the ladder honoured personFirst: the median", () => {
    expect(
      price(
        "stallJudgment",
        "live",
        {},
        { personFirst: true, personFirstSkipped: true, medianTokens: 20_000 },
      ).tokens,
    ).toBe(20_000);
  });

  test("a person-first label waits on the joined remediation record", () => {
    expect(price("stallJudgment", "shadow", {}, { personFirst: true }).pending).toBe(true);
  });
});

describe("feature 14, away reply: minutes, never tokens", () => {
  test("a dry-run reply Tyler matched saves his answer's wait, would-have", () => {
    const result = price(
      "awayReply",
      "shadow",
      {},
      { action: "would-reply", sameChoice: true, minutesAfterDecision: 42 },
    );
    expect(result).toMatchObject({
      benefit: "time",
      tokens: null,
      otherBenefit: { unit: "minutes", value: 42 },
    });
  });

  test("a different choice saves nothing; no follow-up yet is pending", () => {
    expect(
      price(
        "awayReply",
        "shadow",
        {},
        { action: "would-reply", sameChoice: false, minutesAfterDecision: 42 },
      ).otherBenefit,
    ).toEqual({ unit: "minutes", value: 0 });
    expect(price("awayReply", "shadow", {}, { action: "would-reply" }).pending).toBe(true);
  });

  test("a sent reply has no follow-up to count", () => {
    expect(price("awayReply", "live", {}, { action: "replied" })).toMatchObject({
      otherBenefit: null,
      pending: false,
    });
  });
});

describe("feature 16, read check", () => {
  const skip = { did: "read", wouldBe: "would-skip" };

  test("a shadow would-skip that held saves T x R x w(m), would-have", () => {
    expect(
      price("readCheck", "shadow", skip, { contextTokens: 10_000, model: "claude-opus-5-5" }, held)
        .tokens,
    ).toBe(145_000);
  });

  test("a false skip saves nothing, and no validation yet is pending", () => {
    const facts = { contextTokens: 10_000, model: "claude-opus-5-5" };
    expect(
      price("readCheck", "shadow", skip, facts, {
        outcome: "false-skip",
        signal: "edited",
        afterMinutes: 2,
      }).tokens,
    ).toBe(0);
    expect(price("readCheck", "shadow", skip, facts).pending).toBe(true);
  });

  test("a live regret costs one extra step", () => {
    const result = price(
      "readCheck",
      "live",
      { did: "deny", wouldBe: "would-skip", changed: true },
      { contextTokens: 10_000, model: "claude-opus-5-5", agentContextTokens: 100_000 },
      { outcome: "regret", signal: "reread", afterMinutes: 1 },
    );
    expect(result.tokens).toBe(-12_200);
  });

  test("a needed read saves nothing", () => {
    expect(price("readCheck", "shadow", { did: "read", wouldBe: "needed" }, {}).tokens).toBe(0);
  });
});

describe("features that claim nothing", () => {
  test("Ask JEV and compaction timing have no token figure", () => {
    expect(price("askJev", "live", {}, {})).toMatchObject({ benefit: "none", tokens: null });
    expect(price("compactionTiming", "shadow", {}, {})).toMatchObject({
      benefit: "none",
      tokens: null,
    });
  });
});

describe("evidence rules", () => {
  function counters(n: Record<string, number>) {
    return n;
  }

  test("spawn hint: not enough data below 50 settled children, then the sum's sign", () => {
    expect(
      evaluateEvidence("spawnHint", counters({ settledShadow: 49, settledShadowTokens: 9 }), 0).met,
    ).toBeNull();
    expect(
      evaluateEvidence("spawnHint", counters({ settledShadow: 50, settledShadowTokens: 9 }), 0).met,
    ).toBe(true);
    expect(
      evaluateEvidence("spawnHint", counters({ settledShadow: 50, settledShadowTokens: -1 }), 0)
        .met,
    ).toBe(false);
  });

  test("remediation triage: 20 would-be skips, at most 1 in 5 contradicted", () => {
    expect(evaluateEvidence("remediationTriage", { wouldSkip: 19 }, 0).met).toBeNull();
    expect(
      evaluateEvidence("remediationTriage", { wouldSkip: 20, wouldSkipContradicted: 4 }, 0).met,
    ).toBe(true);
    expect(
      evaluateEvidence("remediationTriage", { wouldSkip: 20, wouldSkipContradicted: 5 }, 0).met,
    ).toBe(false);
  });

  test("finish triage: 50 notices with a follow-up, 80% held", () => {
    expect(evaluateEvidence("notificationTriage", { noticeFollowedUp: 49 }, 0).met).toBeNull();
    expect(
      evaluateEvidence("notificationTriage", { noticeFollowedUp: 50, noticeHeld: 40 }, 0).met,
    ).toBe(true);
    expect(
      evaluateEvidence("notificationTriage", { noticeFollowedUp: 50, noticeHeld: 39 }, 0).met,
    ).toBe(false);
  });

  test("agent tools: live -> off once over half the file-tool calls regret", () => {
    expect(
      evaluateEvidence("agentTools", { fileToolCalls: 19, fileToolRegrets: 19 }, 0).met,
    ).toBeNull();
    expect(evaluateEvidence("agentTools", { fileToolCalls: 20, fileToolRegrets: 11 }, 0).met).toBe(
      true,
    );
    expect(evaluateEvidence("agentTools", { fileToolCalls: 20, fileToolRegrets: 10 }, 0).met).toBe(
      false,
    );
  });

  test("stall judgment: 10 person-first agents, 70% NOT FIXED", () => {
    expect(evaluateEvidence("stallJudgment", { personFirstAgentRan: 9 }, 0).met).toBeNull();
    expect(
      evaluateEvidence("stallJudgment", { personFirstAgentRan: 10, personFirstNotFixed: 7 }, 0).met,
    ).toBe(true);
    expect(
      evaluateEvidence("stallJudgment", { personFirstAgentRan: 10, personFirstNotFixed: 6 }, 0).met,
    ).toBe(false);
  });

  test("away reply: 20 follow-ups, 90% same choice", () => {
    expect(evaluateEvidence("awayReply", { followUps: 19 }, 0).met).toBeNull();
    expect(evaluateEvidence("awayReply", { followUps: 20, sameChoice: 18 }, 0).met).toBe(true);
    expect(evaluateEvidence("awayReply", { followUps: 20, sameChoice: 17 }, 0).met).toBe(false);
  });

  test("read check: 200 big would-skips, at most 30% false, a positive net after JEV's cost", () => {
    expect(evaluateEvidence("readCheck", { bigWouldSkip: 199 }, 0).met).toBeNull();
    const base = { bigWouldSkip: 200, bigWouldSkipFalse: 60, bigWouldSkipProjected: 1_000 };
    expect(evaluateEvidence("readCheck", base, 0).met).toBe(true);
    expect(evaluateEvidence("readCheck", { ...base, bigWouldSkipFalse: 61 }, 0).met).toBe(false);
    // $0.0001 is 25 tokens: $0.05 is 12,500, more than the projected 1,000.
    expect(evaluateEvidence("readCheck", base, 0.05).met).toBe(false);
  });

  test("counters come from the record: a shadow would-skip of a big read counts once", () => {
    const facts = { contextTokens: 9_000, model: "claude-opus-5-5" };
    const decision = { did: "read", wouldBe: "would-skip", changed: false };
    const priced = priceSavings({
      feature: "readCheck",
      mode: "shadow",
      decision,
      facts,
      validation: held,
    });
    expect(
      evidenceCounters({
        feature: "readCheck",
        mode: "shadow",
        decision,
        facts,
        validation: held,
        price: priced,
      }),
    ).toEqual({ bigWouldSkip: 1, bigWouldSkipProjected: 130_500 });
  });
});
