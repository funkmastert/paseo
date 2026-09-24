import { describe, expect, test } from "vitest";
import {
  applyLeaderCompactionTurnOutcome,
  planLeaderCompactionStep,
  resolveLeaderCompactionConfig,
  type LeaderCompactionAgentInput,
  type LeaderCompactionEpisode,
  type LeaderCompactionState,
} from "./leader-compaction-planner.js";

const config = resolveLeaderCompactionConfig({
  enabled: true,
  prepareAtTokens: 400_000,
  retryAfterMinutes: 30,
  maxAttempts: 2,
});

function leader(overrides: Partial<LeaderCompactionAgentInput> = {}): LeaderCompactionAgentInput {
  return {
    sessionFamily: "claude",
    internal: false,
    isDelegated: false,
    lifecycle: "idle",
    busy: false,
    pendingPermissionCount: 0,
    contextWindowUsedTokens: 500_000,
    ...overrides,
  };
}

const episode: LeaderCompactionEpisode = {
  triggeredAtTokens: 500_000,
  attempts: 0,
  note: null,
  compactedFromTokens: null,
  compactedToTokens: null,
};

function plan(state: LeaderCompactionState | undefined, agent: LeaderCompactionAgentInput) {
  return planLeaderCompactionStep({ state, agent, config, nowMs: 0 });
}

describe("planLeaderCompactionStep", () => {
  test("an idle leader over the threshold starts the prepare step", () => {
    const result = plan(undefined, leader());
    expect(result.action).toMatchObject({ kind: "startTurn", step: "prepare" });
    expect(result.state).toMatchObject({ phase: "inFlight", step: "prepare" });
  });

  test("a running leader over the threshold waits instead of being interrupted", () => {
    const result = plan(undefined, leader({ lifecycle: "running", busy: true }));
    expect(result.action).toEqual({ kind: "none" });
    expect(result.state).toMatchObject({ phase: "waiting", step: "prepare" });
  });

  test("an idle-looking leader that is busy or waiting on a permission still waits", () => {
    expect(plan(undefined, leader({ busy: true })).action).toEqual({ kind: "none" });
    expect(plan(undefined, leader({ pendingPermissionCount: 1 })).action).toEqual({
      kind: "none",
    });
  });

  test("workers, internal agents and non-Claude agents are left alone under the leaders scope", () => {
    expect(plan(undefined, leader({ isDelegated: true })).action).toEqual({ kind: "none" });
    expect(plan(undefined, leader({ internal: true })).action).toEqual({ kind: "none" });
    expect(plan(undefined, leader({ sessionFamily: "codex" })).action).toEqual({ kind: "none" });
  });

  test("scope all includes workers", () => {
    const all = resolveLeaderCompactionConfig({ enabled: true, scope: "all" });
    const result = planLeaderCompactionStep({
      state: undefined,
      agent: leader({ isDelegated: true }),
      config: all,
      nowMs: 0,
    });
    expect(result.action).toMatchObject({ kind: "startTurn", step: "prepare" });
  });

  test("dry run reports the crossing once and does not report again until usage drops", () => {
    const dry = resolveLeaderCompactionConfig({ enabled: true, dryRun: true });
    const first = planLeaderCompactionStep({
      state: undefined,
      agent: leader({ lifecycle: "running", busy: true }),
      config: dry,
      nowMs: 0,
    });
    expect(first.action).toEqual({ kind: "reportDryRun", usedTokens: 500_000, startsNow: false });
    const second = planLeaderCompactionStep({
      state: first.state,
      agent: leader(),
      config: dry,
      nowMs: 60_000,
    });
    expect(second.action).toEqual({ kind: "none" });
    const dropped = planLeaderCompactionStep({
      state: second.state,
      agent: leader({ contextWindowUsedTokens: 100_000 }),
      config: dry,
      nowMs: 120_000,
    });
    expect(dropped.state).toEqual({ phase: "armed" });
  });

  test("a turn in flight is never touched by a sweep, even if the agent stops qualifying", () => {
    const inFlight: LeaderCompactionState = { phase: "inFlight", step: "compact", episode };
    const result = plan(inFlight, leader({ isDelegated: true }));
    expect(result).toEqual({ state: inFlight, action: { kind: "none" } });
  });

  test("a leader that shrank on its own before prepare is simply re-armed", () => {
    const waiting: LeaderCompactionState = { phase: "waiting", step: "prepare", episode };
    const result = plan(waiting, leader({ contextWindowUsedTokens: 50_000 }));
    expect(result).toEqual({ state: { phase: "armed" }, action: { kind: "none" } });
  });

  test("a leader that got compacted by someone else after its note still gets the note back", () => {
    const waiting: LeaderCompactionState = {
      phase: "waiting",
      step: "compact",
      episode: { ...episode, note: "the note" },
    };
    const result = plan(waiting, leader({ contextWindowUsedTokens: 30_000 }));
    expect(result.action).toMatchObject({
      kind: "startTurn",
      step: "restore",
      episode: { note: "the note", compactedToTokens: 30_000 },
    });
  });

  test("backoff holds until its time, then waits for idle again", () => {
    const backoff: LeaderCompactionState = {
      phase: "backoff",
      step: "compact",
      episode,
      untilMs: 1_000,
    };
    expect(
      planLeaderCompactionStep({ state: backoff, agent: leader(), config, nowMs: 999 }).action,
    ).toEqual({ kind: "none" });
    expect(
      planLeaderCompactionStep({ state: backoff, agent: leader(), config, nowMs: 1_000 }).action,
    ).toMatchObject({ kind: "startTurn", step: "compact" });
  });

  test("hysteresis: a settled leader does not fire again until usage is seen under the line", () => {
    const settled: LeaderCompactionState = { phase: "settled", reason: "gaveUp" };
    expect(plan(settled, leader()).action).toEqual({ kind: "none" });
    expect(plan(settled, leader({ contextWindowUsedTokens: undefined })).state).toEqual(settled);
    const rearmed = plan(settled, leader({ contextWindowUsedTokens: 399_999 }));
    expect(rearmed.state).toEqual({ phase: "armed" });
    expect(plan(rearmed.state, leader()).action).toMatchObject({ kind: "startTurn" });
  });
});

describe("applyLeaderCompactionTurnOutcome", () => {
  function apply(
    step: "prepare" | "compact" | "restore",
    result: Parameters<typeof applyLeaderCompactionTurnOutcome>[0]["result"],
    from: LeaderCompactionEpisode = episode,
  ) {
    return applyLeaderCompactionTurnOutcome({ step, episode: from, result, config, nowMs: 0 });
  }

  test("prepare keeps the agent's reply as the note and moves to compact", () => {
    const applied = apply("prepare", {
      status: "completed",
      finalText: "  goal: ship it  ",
      usedTokensAfter: 505_000,
    });
    expect(applied.state).toMatchObject({
      phase: "waiting",
      step: "compact",
      episode: { note: "goal: ship it" },
    });
  });

  test("compact only counts when the context actually shrank below the line", () => {
    const shrank = apply("compact", {
      status: "completed",
      finalText: "",
      usedTokensAfter: 32_000,
    });
    expect(shrank.state).toMatchObject({
      phase: "waiting",
      step: "restore",
      episode: { compactedFromTokens: 500_000, compactedToTokens: 32_000 },
    });
    const didNot = apply("compact", {
      status: "completed",
      finalText: "",
      usedTokensAfter: 480_000,
    });
    expect(didNot.failure).toEqual({ kind: "notCompacted", usedTokens: 480_000 });
    expect(didNot.state).toMatchObject({ phase: "backoff", step: "compact", untilMs: 1_800_000 });
  });

  test("losing the race to other work is not an attempt", () => {
    const applied = apply("compact", { status: "busy" });
    expect(applied.state).toEqual({ phase: "waiting", step: "compact", episode });
    expect(applied.gaveUp).toBe(false);
  });

  test("a cancelled compaction retries, and the last attempt gives up into hysteresis", () => {
    const first = apply("compact", { status: "canceled" });
    expect(first.state).toMatchObject({ phase: "backoff", episode: { attempts: 1 } });
    const last = apply("compact", { status: "canceled" }, { ...episode, attempts: 1 });
    expect(last.gaveUp).toBe(true);
    expect(last.state).toEqual({ phase: "settled", reason: "gaveUp" });
  });

  test("restore ends the episode", () => {
    const applied = apply("restore", {
      status: "completed",
      finalText: "ok",
      usedTokensAfter: 35_000,
    });
    expect(applied.state).toEqual({ phase: "settled", reason: "done" });
  });
});
