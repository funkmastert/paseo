import { describe, expect, it } from "vitest";
import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import { buildJevDecisionsView, formatJevCost } from "./jev-decisions-model";

function record(overrides: Partial<JevDecisionRecord> = {}): JevDecisionRecord {
  return {
    agentId: "agent-1",
    callId: "call-1",
    feature: "remediationTriage",
    question: "Should a remediation agent handle this?",
    verdict: "person (0.91)",
    confidence: 0.91,
    action: "would have: no remediation agent; sent to a person (not applied; agent started)",
    applied: false,
    at: "2026-09-29T17:00:00.000Z",
    costUsd: 0.00021,
    ...overrides,
  };
}

function status(shadow: Record<string, boolean>, provider = "openrouter"): JevStatus {
  return {
    available: true,
    reason: null,
    keyPresent: true,
    provider,
    model: "jev-1",
    features: Object.fromEntries(
      Object.entries(shadow).map(([feature, isShadow]) => [
        feature,
        { enabled: true, shadow: isShadow },
      ]),
    ),
    lanes: {},
    spawnHint: { applyHard: false, applyRole: false },
    agentTools: { assignShare: 0.5 },
    todayByFeature: {},
    last7Days: [],
  };
}

describe("buildJevDecisionsView", () => {
  it("names the feature and marks a shadow decision as shadow", () => {
    const view = buildJevDecisionsView([record()], status({ remediationTriage: true }));
    expect(view).toEqual({
      lines: [
        {
          key: "call-1:0",
          feature: "Remediation triage",
          question: "Should a remediation agent handle this?",
          verdict: "person (0.91)",
          action: "would have: no remediation agent; sent to a person (not applied; agent started)",
          tag: "shadow",
          cost: "$0.0002",
          at: new Date("2026-09-29T17:00:00.000Z"),
        },
      ],
      hidden: 0,
    });
  });

  it("says dry run for the away reply, nothing for a live feature that kept today's behaviour, nothing when applied", () => {
    const view = buildJevDecisionsView(
      [
        record({ feature: "awayReply", callId: "a" }),
        record({ feature: "stallJudgment", callId: "b" }),
        record({ feature: "askJev", callId: "c", applied: true }),
      ],
      status({ awayReply: true, stallJudgment: false, askJev: false }),
    );
    expect(view.lines.map((line) => [line.feature, line.tag])).toEqual([
      ["Away reply", "dryRun"],
      ["Stall judgment", null],
      ["Ask JEV", null],
    ]);
  });

  it("reads the tag off the note's own mode, even when it disagrees with the host's current status", () => {
    // The host's status now says live, but this note was recorded while the feature was shadow.
    const view = buildJevDecisionsView(
      [record({ mode: "shadow", applied: true })],
      status({ remediationTriage: false }),
    );
    expect(view.lines[0].tag).toBe("shadow");
  });

  it("tags nothing for a live mode, even when applied is false", () => {
    const view = buildJevDecisionsView(
      [record({ mode: "live", applied: false })],
      status({ remediationTriage: true }),
    );
    expect(view.lines[0].tag).toBeNull();
  });

  it("says dry run for the away reply's own shadow mode", () => {
    const view = buildJevDecisionsView(
      [record({ feature: "awayReply", mode: "shadow" })],
      status({ awayReply: false }),
    );
    expect(view.lines[0].tag).toBe("dryRun");
  });

  it("falls back to the old heuristic for a note recorded before the savings hook-in (no mode)", () => {
    const view = buildJevDecisionsView(
      [record({ applied: false })],
      status({ remediationTriage: true }),
    );
    expect(view.lines[0].tag).toBe("shadow");
  });

  it("tags nothing when the host's status could not be read", () => {
    expect(buildJevDecisionsView([record()], null).lines[0].tag).toBeNull();
  });

  it("lists the newest and counts the rest", () => {
    const decisions = Array.from({ length: 11 }, (_, index) => record({ callId: `c${index}` }));
    const view = buildJevDecisionsView(decisions, null, 8);
    expect(view.lines).toHaveLength(8);
    expect(view.lines[0].key).toBe("c0:0");
    expect(view.hidden).toBe(3);
  });

  it("is empty for an agent with no decisions", () => {
    expect(buildJevDecisionsView([], null)).toEqual({ lines: [], hidden: 0 });
  });

  it("keeps an unknown feature's id rather than dropping the decision", () => {
    expect(buildJevDecisionsView([record({ feature: "newFeature" })], null).lines[0].feature).toBe(
      "newFeature",
    );
  });
});

describe("formatJevCost", () => {
  it("keeps the digits a fraction of a cent needs", () => {
    expect(formatJevCost(0.00021, "openrouter")).toBe("$0.0002");
    expect(formatJevCost(0.0123, "openrouter")).toBe("$0.012");
    expect(formatJevCost(0, "typesafe")).toBe("$0");
    expect(formatJevCost(null, "openrouter")).toBeNull();
  });

  it("says a fake call cost nothing because it was fake", () => {
    expect(formatJevCost(0, "fake")).toBe("$0 (fake)");
  });
});
