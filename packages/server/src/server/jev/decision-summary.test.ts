import { describe, expect, test } from "vitest";
import type { JevDecisionRecord } from "./contract.js";
import { summarizeJevDecision } from "./decision-summary.js";

function record(overrides: Partial<JevDecisionRecord>): JevDecisionRecord {
  return {
    agentId: "agent-1",
    callId: "call-1",
    feature: "spawnHint",
    question: "q",
    verdict: "v",
    confidence: null,
    action: "a",
    applied: true,
    at: new Date(0).toISOString(),
    costUsd: null,
    ...overrides,
  };
}

// The verdict and action shapes below are copied from the live daemon's decision store and from
// each writer's describe* helper, so a summary is tested against what the writers really send.
describe("summarizeJevDecision", () => {
  test("spawnHint: picked, checked or suggested, with readable model names", () => {
    const setup = { feature: "spawnHint", wouldBe: "mechanical on claude-haiku-4-5-20251001" };
    expect(summarizeJevDecision(record({ ...setup, applied: true, mode: "live" }))).toBe(
      "JEV picked the setup: mechanical on Haiku 4.5",
    );
    expect(
      summarizeJevDecision(
        record({
          feature: "spawnHint",
          wouldBe: "standard on claude-sonnet-5",
          applied: false,
          mode: "live",
        }),
      ),
    ).toBe("JEV checked the setup: standard on Sonnet 5");
    expect(
      summarizeJevDecision(
        record({
          feature: "spawnHint",
          wouldBe: "hard on claude-opus-5-5",
          applied: false,
          mode: "shadow",
        }),
      ),
    ).toBe("JEV suggested hard on Opus 5.5 (watching only)");
    expect(summarizeJevDecision(record({ feature: "spawnHint" }))).toBe(
      "JEV sized up this agent's work",
    );
  });

  test("stallJudgment says what JEV saw, and whether it acted", () => {
    expect(
      summarizeJevDecision(
        record({
          feature: "stallJudgment",
          verdict: "progressing (0.99)",
          action: "would have: leave it for 30 minutes unless the repeat changes",
          applied: false,
        }),
      ),
    ).toBe("JEV thinks it's still making progress (watching only)");
    expect(
      summarizeJevDecision(
        record({
          feature: "stallJudgment",
          verdict: "blocked_missing_info (0.82)",
          action: "nudged with the missing question; a person first",
          applied: true,
          mode: "live",
        }),
      ),
    ).toBe("JEV: stuck, missing information; nudged with the missing question; a person first");
  });

  test("remediationTriage and notificationTriage carry the writer's action", () => {
    expect(
      summarizeJevDecision(
        record({ feature: "remediationTriage", action: "no remediation agent; sent to a person" }),
      ),
    ).toBe("JEV on the problem: no remediation agent; sent to a person");
    expect(
      summarizeJevDecision(
        record({
          feature: "notificationTriage",
          action: "sent as a digest notice instead of an alert",
        }),
      ),
    ).toBe("JEV on your phone alert: sent as a digest notice instead of an alert");
  });

  test("compactionTiming: live vs watching", () => {
    expect(
      summarizeJevDecision(
        record({ feature: "compactionTiming", action: "deferred the compaction", mode: "live" }),
      ),
    ).toBe("JEV on compaction timing: deferred the compaction");
    expect(
      summarizeJevDecision(
        record({
          feature: "compactionTiming",
          action: "would have: deferred the compaction",
          mode: "shadow",
        }),
      ),
    ).toBe("JEV on compaction timing: deferred the compaction (watching only)");
  });

  test("awayReply: answered, dry run, or held off with the reason", () => {
    const away = (action: string) => summarizeJevDecision(record({ feature: "awayReply", action }));
    expect(away("replied on Tyler's behalf (a plain go-ahead)")).toBe(
      "JEV answered this agent for you",
    );
    expect(away("would reply (a plain go-ahead); dry run, nothing sent")).toBe(
      "JEV would have answered for you (dry run)",
    );
    expect(away("no reply sent: the question needs a person")).toBe(
      "JEV didn't answer for you: the question needs a person",
    );
  });

  test("agentTools and askJev name the verdict", () => {
    expect(
      summarizeJevDecision(
        record({ feature: "agentTools", verdict: "risk 0.8", action: "full review added" }),
      ),
    ).toBe("JEV helped the agent: risk 0.8; full review added");
    expect(summarizeJevDecision(record({ feature: "askJev", verdict: "yes 0.9" }))).toBe(
      "JEV answered your question: yes 0.9",
    );
  });

  test("readCheck names the file and the tokens a live skip saved", () => {
    const read = {
      feature: "readCheck",
      question: "Does this agent need docs/jev.md?",
      verdict: "not_needed (0.91)",
      action: "denied the read once (about 41,200 tokens)",
    };
    expect(summarizeJevDecision(record({ ...read, applied: true, mode: "live" }))).toBe(
      "JEV skipped re-reading docs/jev.md (about 41,200 tokens)",
    );
    expect(
      summarizeJevDecision(
        record({ ...read, action: "would have: deny", applied: false, mode: "shadow" }),
      ),
    ).toBe("JEV would have skipped re-reading docs/jev.md");
  });

  test("titleRefresh: kept or refreshed, from the action", () => {
    expect(
      summarizeJevDecision(
        record({
          feature: "titleRefresh",
          action: "kept the workspace title, skipping the regeneration",
        }),
      ),
    ).toBe("JEV kept the session title: it still fits");
    expect(
      summarizeJevDecision(record({ feature: "titleRefresh", action: "regenerated the title" })),
    ).toBe("JEV asked for a fresh session title");
  });

  test("finishReview: done, or what looks missing", () => {
    const finish = (verdict: string) =>
      summarizeJevDecision(record({ feature: "finishReview", verdict }));
    expect(finish("done (0.88)")).toBe("JEV: the report looks done");
    expect(finish("in_progress (0.80)")).toBe(
      "JEV: this turn isn't finished yet, not a gap in the report",
    );
    expect(finish("missing_tests (0.90)")).toBe("JEV: the report doesn't mention tests");
    expect(finish("missing_scope (0.81)")).toBe("JEV: the report may cover only part of the task");
    expect(finish("unsure (0.51)")).toBe("JEV wasn't sure whether this report is done");
    expect(finish("no answer")).toBe("JEV read the finish report");
  });

  test("an unknown feature falls back to a generic line naming the feature and verdict", () => {
    expect(summarizeJevDecision(record({ feature: "someFutureFeature", verdict: "maybe" }))).toBe(
      "JEV ran someFutureFeature: maybe",
    );
  });
});
