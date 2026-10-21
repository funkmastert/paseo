import { describe, it, expect } from "vitest";
import {
  joinOutcome,
  summarize,
  type AgentOutcomeSnapshot,
  type ClassifierDecisionWithOutcome,
} from "./classifier-decisions-aggregate";
import type { ClassifierDecisionRow } from "./classifier-decisions-schema";

function row(overrides: Partial<ClassifierDecisionRow> = {}): ClassifierDecisionRow {
  return {
    id: "d1",
    at: "2026-10-20T00:00:00.000Z",
    agentId: "a1",
    agentTitle: "fan-out",
    role: "worker",
    taskClass: "standard",
    workKind: "coding",
    modelRan: "claude-sonnet-5",
    arena: {
      outcome: "ranked",
      applied: false,
      ref: "claude-sonnet-5-5",
      tier: "mid",
      board: "agent/overall",
      publishDate: "2026-10-20",
      pick: { ref: "claude-sonnet-5-5", rating: 0.1, ratingLower: 0.09, ratingUpper: 0.11, votes: 100, effort: "max", proxy: false },
    },
    backfilled: false,
    ...overrides,
  };
}

describe("joinOutcome", () => {
  it("returns unknown for an agent the sweep could no longer find", () => {
    expect(joinOutcome(undefined).state).toBe("unknown");
  });

  it("reads archived first, even over an error status", () => {
    const agent: AgentOutcomeSnapshot = { lastStatus: "error", archivedAt: "2026-10-20T01:00:00.000Z" };
    expect(joinOutcome(agent).state).toBe("archived");
  });

  it("maps error/running/initializing/idle to errored/running/running/finished", () => {
    expect(joinOutcome({ lastStatus: "error" }).state).toBe("errored");
    expect(joinOutcome({ lastStatus: "running" }).state).toBe("running");
    expect(joinOutcome({ lastStatus: "initializing" }).state).toBe("running");
    expect(joinOutcome({ lastStatus: "idle" }).state).toBe("finished");
    expect(joinOutcome({ lastStatus: "closed" }).state).toBe("finished");
  });

  it("reads completion state and the failover-moved flag off labels", () => {
    const agent: AgentOutcomeSnapshot = {
      lastStatus: "idle",
      labels: { "paseo.completion": "done", "paseo.account-failover.migrated-to": "agent-2" },
    };
    const outcome = joinOutcome(agent);
    expect(outcome.completion).toBe("done");
    expect(outcome.moved).toBe(true);
  });

  it("reads tokens straight off the snapshot's totalTokens", () => {
    expect(joinOutcome({ lastStatus: "idle", totalTokens: 1128564.55 }).tokens).toBe(1128564.55);
    expect(joinOutcome({ lastStatus: "idle" }).tokens).toBeNull();
  });

  it("computes durationMs from createdAt to the LATEST of updatedAt/archivedAt/completion-at", () => {
    const agent: AgentOutcomeSnapshot = {
      lastStatus: "idle",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:05:00.000Z",
      archivedAt: "2026-10-20T00:10:00.000Z",
      labels: { "paseo.completion-at": "2026-10-20T00:07:00.000Z" },
    };
    expect(joinOutcome(agent).durationMs).toBe(10 * 60_000);
  });

  it("is null when there is no createdAt or no later timestamp at all", () => {
    expect(joinOutcome({ lastStatus: "idle" }).durationMs).toBeNull();
    expect(joinOutcome({ lastStatus: "idle", createdAt: "2026-10-20T00:00:00.000Z" }).durationMs).toBeNull();
  });
});

describe("summarize", () => {
  const outcomeFor = (state: "finished" | "errored" | "running" | "archived" | "unknown", tokens: number | null = null): ReturnType<typeof joinOutcome> => ({
    state,
    completion: null,
    moved: false,
    tokens,
    durationMs: null,
  });

  it("computes an overall agreement rate from ranked rows where the pick matches the model that ran", () => {
    const entries: ClassifierDecisionWithOutcome[] = [
      { row: row({ modelRan: "claude-sonnet-5-5" }), outcome: outcomeFor("finished") }, // agrees
      { row: row({ modelRan: "claude-sonnet-5" }), outcome: outcomeFor("finished") }, // disagrees
    ];
    const summary = summarize(entries);
    expect(summary.rankedCount).toBe(2);
    expect(summary.agreementRate).toBe(0.5);
  });

  it("agreement rate is null, not NaN or 0, when every row is a fallback", () => {
    const entries: ClassifierDecisionWithOutcome[] = [
      { row: row({ arena: { outcome: "fallback", reason: "no-ranked-board" } }), outcome: outcomeFor("finished") },
    ];
    const summary = summarize(entries);
    expect(summary.rankedCount).toBe(0);
    expect(summary.agreementRate).toBeNull();
    expect(summary.fallbackReasonCounts).toEqual({ "no-ranked-board": 1 });
  });

  it("splits agreement rate, fallback reasons, and pick distribution by work kind, and totals sum back", () => {
    const entries: ClassifierDecisionWithOutcome[] = [
      { row: row({ workKind: "coding", modelRan: "claude-sonnet-5-5" }), outcome: outcomeFor("finished") },
      { row: row({ workKind: "frontend", arena: { outcome: "fallback", reason: "unknown-kind" } }), outcome: outcomeFor("finished") },
    ];
    const summary = summarize(entries);
    expect(summary.byWorkKind.coding.agreementRate).toBe(1);
    expect(summary.byWorkKind.frontend.fallbackReasonCounts).toEqual({ "unknown-kind": 1 });
    const totalAcrossKinds = Object.values(summary.byWorkKind).reduce((n, wk) => n + wk.rankedCount + wk.fallbackCount, 0);
    expect(totalAcrossKinds).toBe(summary.rankedCount + summary.fallbackCount);
  });

  it("a row with no current agent is excluded from outcome rates but still counted in pick distribution", () => {
    const entries: ClassifierDecisionWithOutcome[] = [{ row: row(), outcome: outcomeFor("unknown") }];
    const summary = summarize(entries);
    expect(summary.pickDistributionByModel["claude-sonnet-5-5"]).toBe(1);
    expect(summary.outcomesByModelAndWorkKind[0].unknown).toBe(1);
    expect(summary.outcomesByModelAndWorkKind[0].finished).toBe(0);
  });

  it("a backfilled row with no fallback reason participates in agreement rate exactly like a live row", () => {
    const entries: ClassifierDecisionWithOutcome[] = [
      { row: row({ backfilled: true, modelRan: "claude-sonnet-5-5" }), outcome: outcomeFor("finished") },
    ];
    expect(summarize(entries).agreementRate).toBe(1);
  });

  it("computes median tokens per model per work kind", () => {
    const entries: ClassifierDecisionWithOutcome[] = [
      { row: row({ modelRan: "claude-sonnet-5" }), outcome: outcomeFor("finished", 100) },
      { row: row({ modelRan: "claude-sonnet-5" }), outcome: outcomeFor("finished", 300) },
      { row: row({ modelRan: "claude-sonnet-5" }), outcome: outcomeFor("finished", 200) },
    ];
    const summary = summarize(entries);
    expect(summary.outcomesByModelAndWorkKind[0].medianTokens).toBe(200);
  });

  it("topTierRate reflects the share of ranked rows whose pick was top tier", () => {
    const entries: ClassifierDecisionWithOutcome[] = [
      { row: row({ arena: { ...row().arena, tier: "top" } as ClassifierDecisionRow["arena"] }), outcome: outcomeFor("finished") },
      { row: row(), outcome: outcomeFor("finished") }, // mid
    ];
    expect(summarize(entries).topTierRate).toBe(0.5);
  });
});
