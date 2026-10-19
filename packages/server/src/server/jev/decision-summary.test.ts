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

describe("summarizeJevDecision", () => {
  test("spawnHint applied names the set task class", () => {
    expect(
      summarizeJevDecision(
        record({ feature: "spawnHint", applied: true, wouldBe: "mechanical on claude-haiku-4-5" }),
      ),
    ).toBe("JEV set this create's task class: mechanical on claude-haiku-4-5");
  });

  test("spawnHint not applied says what it would have set", () => {
    expect(
      summarizeJevDecision(
        record({ feature: "spawnHint", applied: false, wouldBe: "standard on claude-opus-5-5" }),
      ),
    ).toBe("JEV would have set this create's task class: standard on claude-opus-5-5");
  });

  test("spawnHint with no wouldBe falls back to the verdict", () => {
    expect(
      summarizeJevDecision(record({ feature: "spawnHint", wouldBe: undefined, verdict: "v1" })),
    ).toBe("JEV classified this create: v1");
  });

  test("stallJudgment reads the same whatever the verdict", () => {
    expect(summarizeJevDecision(record({ feature: "stallJudgment", verdict: "anything" }))).toBe(
      "JEV judged the stall needs you",
    );
  });

  test("remediationTriage: live vs shadow", () => {
    expect(
      summarizeJevDecision(record({ feature: "remediationTriage", verdict: "clears on its own" })),
    ).toBe("JEV triaged the remediation: clears on its own");
    expect(
      summarizeJevDecision(
        record({ feature: "remediationTriage", mode: "shadow", verdict: "clears on its own" }),
      ),
    ).toBe("JEV would have triaged the remediation: clears on its own");
  });

  test("notificationTriage: live vs shadow", () => {
    expect(
      summarizeJevDecision(record({ feature: "notificationTriage", verdict: "routine" })),
    ).toBe("JEV reviewed the finish: routine");
    expect(
      summarizeJevDecision(
        record({ feature: "notificationTriage", mode: "shadow", verdict: "routine" }),
      ),
    ).toBe("JEV would have reviewed the finish: routine");
  });

  test("compactionTiming: live vs shadow", () => {
    expect(summarizeJevDecision(record({ feature: "compactionTiming", verdict: "now" }))).toBe(
      "JEV timed the compaction: now",
    );
    expect(
      summarizeJevDecision(record({ feature: "compactionTiming", mode: "shadow", verdict: "now" })),
    ).toBe("JEV would have timed the compaction: now");
  });

  test("awayReply: live vs shadow (dry run)", () => {
    expect(summarizeJevDecision(record({ feature: "awayReply" }))).toBe("JEV sent an away reply");
    expect(summarizeJevDecision(record({ feature: "awayReply", mode: "shadow" }))).toBe(
      "JEV drafted an away reply (dry run)",
    );
  });

  test("agentTools names the verdict", () => {
    expect(summarizeJevDecision(record({ feature: "agentTools", verdict: "safe to read" }))).toBe(
      "JEV answered a tool question: safe to read",
    );
  });

  test("askJev names the verdict", () => {
    expect(summarizeJevDecision(record({ feature: "askJev", verdict: "yes (0.7)" }))).toBe(
      "JEV answered: yes (0.7)",
    );
  });

  test("readCheck: live vs shadow, names the question", () => {
    expect(
      summarizeJevDecision(record({ feature: "readCheck", question: "a 40K-token file" })),
    ).toBe("JEV skipped re-reading: a 40K-token file");
    expect(
      summarizeJevDecision(
        record({ feature: "readCheck", mode: "shadow", question: "a 40K-token file" }),
      ),
    ).toBe("JEV would have skipped re-reading: a 40K-token file");
  });

  test("titleRefresh reads the same whatever the verdict", () => {
    expect(summarizeJevDecision(record({ feature: "titleRefresh", verdict: "anything" }))).toBe(
      "JEV refreshed the session title",
    );
  });

  test("an unknown feature falls back to a generic line naming the feature and verdict", () => {
    expect(
      summarizeJevDecision(
        record({
          feature: "finishReview" as unknown as JevDecisionRecord["feature"],
          verdict: "missing tests",
        }),
      ),
    ).toBe("JEV ran finishReview: missing tests");
  });
});
