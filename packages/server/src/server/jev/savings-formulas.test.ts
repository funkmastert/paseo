import { describe, expect, test } from "vitest";

import type {
  JevSavingsDecision,
  JevSavingsFeature,
  JevSavingsMode,
  JevSavingsValidation,
} from "./contract.js";
import {
  JEV_RESIDENCY,
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

  describe("a shadow defer (review M3): a live defer only holds the agent 10-15 minutes", () => {
    const defer = { did: "start-agent", wouldBe: "defer" };
    const notFixed = {
      fixed: false,
      agentRan: true,
      agentTotalTokens: 2_000_000,
      agentModel: "claude-sonnet-5",
      deferMinutes: 10,
    };

    test("an agent that ended NOT FIXED while the condition outlasted the hold saves nothing", () => {
      const result = price("remediationTriage", "shadow", defer, {
        ...notFixed,
        closed: true,
        minutesSinceTriage: 40,
      });
      expect(result).toMatchObject({ tokens: 0, pending: false });
    });

    test("a condition that cleared inside the hold, the agent not fixing it, saves A x w(m)", () => {
      const result = price("remediationTriage", "shadow", defer, {
        ...notFixed,
        closed: true,
        minutesSinceTriage: 8,
      });
      expect(result).toMatchObject({ tokens: 1_000_000, pending: false });
    });

    test("an agent that fixed it saves nothing; an open episode waits for its close", () => {
      expect(
        price("remediationTriage", "shadow", defer, { ...notFixed, fixed: true }),
      ).toMatchObject({ tokens: 0, pending: false });
      expect(price("remediationTriage", "shadow", defer, notFixed).pending).toBe(true);
    });

    test("a shadow defer is not a would-be skip in the evidence; it has its own counters", () => {
      const view = (validation: JevSavingsValidation | null) => ({
        feature: "remediationTriage" as const,
        mode: "shadow" as const,
        decision: { did: "start-agent", wouldBe: "defer", changed: false },
        facts: { ...notFixed, closed: true, minutesSinceTriage: 8 },
        validation,
        price: price(
          "remediationTriage",
          "shadow",
          defer,
          { ...notFixed, closed: true, minutesSinceTriage: 8 },
          validation,
        ),
      });
      expect(evidenceCounters(view(held))).toEqual({ wouldDefer: 1, wouldDeferCleared: 1 });
      expect(
        evidenceCounters(view({ outcome: "contradicted", signal: "fixed", afterMinutes: 3 })),
      ).toEqual({ wouldDefer: 1 });
    });
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

describe("R, residency", () => {
  test("is in the fleet unit: one cache write at 1.25, then about 125 later calls at 0.1", () => {
    expect(JEV_RESIDENCY).toBe(1.25 + 0.1 * 125);
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
    expect(price("agentTools", "live", { did: "answered" }, facts, held).tokens).toBe(61_275);
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
    expect(result.tokens).toBe(-7_475);
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
    ).toBe(137_500);
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
    ).toEqual({ bigWouldSkip: 1, bigWouldSkipProjected: 123_750 });
  });

  // D12: these reads can never be denied, so they get their own counters and must never move the
  // rule that decides whether to switch the feature live.
  test("a shadow-only read counts in its own bucket and not toward the live rule", () => {
    const countersFor = (shadowOnly: string) => {
      const facts = { contextTokens: 9_000, model: "claude-opus-5-5", shadowOnly };
      const decision = { did: "read", wouldBe: "would-skip", changed: false };
      return evidenceCounters({
        feature: "readCheck",
        mode: "shadow",
        decision,
        facts,
        validation: held,
        price: priceSavings({
          feature: "readCheck",
          mode: "shadow",
          decision,
          facts,
          validation: held,
        }),
      });
    };
    expect(countersFor("skill-docs")).toEqual({
      shadowOnlyJudged: 1,
      "shadowOnlyJudged.skill-docs": 1,
      shadowOnlyWouldSkip: 1,
    });
    expect(countersFor("ce-scratch")).toEqual({
      shadowOnlyJudged: 1,
      "shadowOnlyJudged.ce-scratch": 1,
      shadowOnlyWouldSkip: 1,
    });
  });

  test("a declared-label audit record counts in its own bucket and not toward spawnHint's go-live rule", () => {
    const facts = {
      baseModel: "claude-sonnet-5",
      wouldModel: "claude-haiku-4-5",
      runningModel: "claude-sonnet-5",
      agentTotalTokens: 100_000,
      declaredAudit: true,
    };
    const decision = {
      did: "hard on claude-sonnet-5",
      wouldBe: "mechanical on claude-haiku-4-5",
      changed: false,
    };
    const priced = priceSavings({
      feature: "spawnHint",
      mode: "shadow",
      decision,
      facts,
      validation: null,
    });

    expect(
      evidenceCounters({
        feature: "spawnHint",
        mode: "shadow",
        decision,
        facts,
        validation: null,
        price: priced,
      }),
    ).toEqual({ declaredAuditSettled: 1, declaredAuditSettledTokens: priced.tokens });
  });

  test("spawnHint's audit figure is reported beside the go-live rule, never inside it", () => {
    const base = { settledShadow: 49, settledShadowTokens: -5 };
    const plain = evaluateEvidence("spawnHint", base, 0);
    expect(plain.met).toBeNull(); // under the 50 floor
    expect(plain.observed).not.toContain("audit");

    const withAudit = evaluateEvidence(
      "spawnHint",
      { ...base, declaredAuditSettled: 30, declaredAuditSettledTokens: 25_000 },
      0,
    );
    expect(withAudit.observed).toContain("declared-label audit: 30 settled, would-have sum 25000");
    // The audit never advances or changes the go-live verdict.
    expect(withAudit.met).toBe(plain.met);
  });

  test("the shadow-only counts are reported beside the live rule, never inside it", () => {
    const base = { bigWouldSkip: 200, bigWouldSkipFalse: 60, bigWouldSkipProjected: 1_000 };
    const plain = evaluateEvidence("readCheck", base, 0);
    expect(plain.observed).not.toContain("shadow-only");
    const withShadowOnly = evaluateEvidence(
      "readCheck",
      { ...base, shadowOnlyJudged: 40, shadowOnlyWouldSkip: 10, shadowOnlyFalseSkip: 2 },
      0,
    );
    expect(withShadowOnly.observed).toContain("shadow-only 40 judged, 10 would-skip, 20% false");
    // The rule's verdict is unchanged by them.
    expect(withShadowOnly.met).toBe(plain.met);
  });
});
