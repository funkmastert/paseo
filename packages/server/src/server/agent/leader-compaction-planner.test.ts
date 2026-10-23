import { describe, expect, test } from "vitest";
import {
  applyLeaderCompactionTurnOutcome,
  hasLeaderCompactionPrepareTimedOut,
  leaderCompactionDeferMinutesLeft,
  looksLikeAttemptedDeferral,
  NO_LEADER_COMPACTION_DEFERRAL,
  parseLeaderCompactionDeferral,
  planLeaderCompactionStep,
  resolveLeaderCompactionConfig,
  type LeaderCompactionAgentInput,
  type LeaderCompactionEpisode,
  type LeaderCompactionState,
  type LeaderCompactionTiming,
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
  lineTokens: 400_000,
  trigger: { kind: "line" },
  attempts: 0,
  note: null,
  compactedFromTokens: null,
  compactedToTokens: null,
  carriedPrompts: [],
  deferral: NO_LEADER_COMPACTION_DEFERRAL,
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
    expect(first.action).toEqual({
      kind: "reportDryRun",
      usedTokens: 500_000,
      startsNow: false,
      trigger: { kind: "line" },
      recentPrompt: null,
    });
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

describe("planLeaderCompactionStep with a compaction-timing verdict", () => {
  const startEarly: LeaderCompactionTiming = {
    kind: "startEarly",
    lineTokens: 200_000,
    reason: "your last turn finished a unit of work",
  };
  const defer: LeaderCompactionTiming = {
    kind: "defer",
    ceilingTokens: 500_000,
    reason: "you are mid-way through a multi-step edit",
  };

  function planWith(
    timing: LeaderCompactionTiming | null | undefined,
    agent: LeaderCompactionAgentInput,
    planConfig = config,
  ) {
    return planLeaderCompactionStep({
      state: undefined,
      agent,
      config: planConfig,
      nowMs: 0,
      timing,
    });
  }

  test("startEarly never starts under its own line", () => {
    expect(planWith(startEarly, leader({ contextWindowUsedTokens: 150_000 })).action).toEqual({
      kind: "none",
    });
  });

  test("startEarly starts an episode under the line, against the early line", () => {
    const result = planWith(startEarly, leader({ contextWindowUsedTokens: 260_000 }));
    expect(result.action).toMatchObject({
      kind: "startTurn",
      step: "prepare",
      episode: {
        triggeredAtTokens: 260_000,
        lineTokens: 200_000,
        trigger: { kind: "early", reason: "your last turn finished a unit of work" },
      },
    });
  });

  test("defer holds an idle leader at the line, and not at the ceiling", () => {
    const held = planWith(defer, leader({ contextWindowUsedTokens: 450_000 }));
    expect(held).toEqual({
      state: { phase: "armed" },
      action: {
        kind: "defer",
        usedTokens: 450_000,
        reason: "you are mid-way through a multi-step edit",
      },
    });
    const atCeiling = planWith(defer, leader({ contextWindowUsedTokens: 500_000 }));
    expect(atCeiling.action).toMatchObject({ kind: "startTurn", step: "prepare" });
  });

  test("no timing gives today's plan", () => {
    for (const used of [260_000, 450_000]) {
      const agent = leader({ contextWindowUsedTokens: used });
      expect(planWith(undefined, agent)).toEqual(planWith(null, agent));
      expect(planWith(null, agent)).toEqual(plan(undefined, agent));
    }
    expect(planWith(null, leader({ contextWindowUsedTokens: 260_000 })).action).toEqual({
      kind: "none",
    });
    const lineEpisode: LeaderCompactionEpisode = {
      triggeredAtTokens: 450_000,
      lineTokens: 400_000,
      trigger: { kind: "line" },
      attempts: 0,
      note: null,
      compactedFromTokens: null,
      compactedToTokens: null,
      carriedPrompts: [],
      deferral: NO_LEADER_COMPACTION_DEFERRAL,
    };
    expect(planWith(null, leader({ contextWindowUsedTokens: 450_000 }))).toEqual({
      state: { phase: "inFlight", step: "prepare", episode: lineEpisode },
      action: { kind: "startTurn", step: "prepare", episode: lineEpisode },
    });
    const dry = resolveLeaderCompactionConfig({ enabled: true, dryRun: true });
    expect(planWith(null, leader({ contextWindowUsedTokens: 450_000 }), dry)).toEqual({
      state: { phase: "settled", reason: "dryRun" },
      action: {
        kind: "reportDryRun",
        usedTokens: 450_000,
        startsNow: true,
        trigger: { kind: "line" },
        recentPrompt: null,
      },
    });
  });

  test("a verdict is ignored once the agent has started another turn", () => {
    const running = { lifecycle: "running" as const, busy: true };
    expect(
      planWith(startEarly, leader({ ...running, contextWindowUsedTokens: 260_000 })).action,
    ).toEqual({ kind: "none" });
    expect(
      planWith(defer, leader({ ...running, contextWindowUsedTokens: 450_000 })).state,
    ).toMatchObject({ phase: "waiting", step: "prepare" });
  });

  test("the dry-run would-start reflects startEarly and defer", () => {
    const dry = resolveLeaderCompactionConfig({ enabled: true, dryRun: true });
    const early = planWith(startEarly, leader({ contextWindowUsedTokens: 260_000 }), dry);
    expect(early).toEqual({
      state: { phase: "settled", reason: "dryRun" },
      action: {
        kind: "reportDryRun",
        usedTokens: 260_000,
        startsNow: true,
        trigger: { kind: "early", reason: "your last turn finished a unit of work" },
        recentPrompt: null,
      },
    });
    const held = planWith(defer, leader({ contextWindowUsedTokens: 450_000 }), dry);
    expect(held.state).toEqual({ phase: "armed" });
    expect(held.action).toMatchObject({ kind: "defer", usedTokens: 450_000 });
  });

  test("an early episode waits under the line without being dropped as shrunk", () => {
    const early: LeaderCompactionEpisode = {
      ...episode,
      triggeredAtTokens: 260_000,
      lineTokens: 200_000,
      trigger: { kind: "early", reason: "a clean break" },
    };
    const waiting: LeaderCompactionState = { phase: "waiting", step: "prepare", episode: early };
    expect(plan(waiting, leader({ contextWindowUsedTokens: 270_000 })).action).toMatchObject({
      kind: "startTurn",
      step: "prepare",
    });
    expect(plan(waiting, leader({ contextWindowUsedTokens: 40_000 })).state).toEqual({
      phase: "armed",
    });
  });
});

describe("planLeaderCompactionStep with the quiet gate", () => {
  const quietConfig = resolveLeaderCompactionConfig({
    enabled: true,
    prepareAtTokens: 400_000,
    quietMinutes: 10,
    ceilingTokens: 550_000,
  });

  function planAt(nowMs: number, lastHumanPrompt: { atMs: number; text: string } | null) {
    return planLeaderCompactionStep({
      state: undefined,
      agent: leader(),
      config: quietConfig,
      nowMs,
      lastHumanPrompt,
    });
  }

  test("holds a would-be start while the leader's last human prompt is recent", () => {
    const result = planAt(5 * 60_000, { atMs: 0, text: "also fix the login bug" });
    expect(result).toEqual({
      state: { phase: "armed" },
      action: { kind: "quietHold", usedTokens: 500_000, quietUntilMs: 10 * 60_000 },
    });
  });

  test("starts once the leader has been quiet for quietMinutes, without carrying the stale prompt", () => {
    const result = planAt(10 * 60_000, { atMs: 0, text: "also fix the login bug" });
    expect(result.action).toMatchObject({ kind: "startTurn", step: "prepare" });
    expect(result.state).toMatchObject({
      phase: "inFlight",
      step: "prepare",
      episode: { carriedPrompts: [] },
    });
  });

  test("starts at the ceiling despite a recent prompt, and carries it", () => {
    const result = planLeaderCompactionStep({
      state: undefined,
      agent: leader({ contextWindowUsedTokens: 600_000 }),
      config: quietConfig,
      nowMs: 1_000,
      lastHumanPrompt: { atMs: 0, text: "also fix the login bug" },
    });
    expect(result.action).toMatchObject({ kind: "startTurn", step: "prepare" });
    expect(result.state).toMatchObject({
      phase: "inFlight",
      step: "prepare",
      episode: { carriedPrompts: [{ atMs: 0, text: "also fix the login bug" }] },
    });
  });

  test("no human prompt ever seen: no gate, same as today", () => {
    const result = planAt(0, null);
    expect(result.action).toMatchObject({ kind: "startTurn", step: "prepare" });
  });

  test("a dry run's recentPrompt matches what a live run would carry", () => {
    const dry = resolveLeaderCompactionConfig({
      enabled: true,
      dryRun: true,
      prepareAtTokens: 400_000,
      ceilingTokens: 550_000,
    });
    const result = planLeaderCompactionStep({
      state: undefined,
      agent: leader({ contextWindowUsedTokens: 600_000 }),
      config: dry,
      nowMs: 1_000,
      lastHumanPrompt: { atMs: 0, text: "also fix the login bug" },
    });
    expect(result.action).toMatchObject({
      kind: "reportDryRun",
      recentPrompt: { atMs: 0, text: "also fix the login bug" },
    });
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

  test("an early episode's compaction counts against its own line", () => {
    const early: LeaderCompactionEpisode = {
      ...episode,
      triggeredAtTokens: 260_000,
      lineTokens: 200_000,
      trigger: { kind: "early", reason: "a clean break" },
    };
    const didNot = apply(
      "compact",
      { status: "completed", finalText: "", usedTokensAfter: 250_000 },
      early,
    );
    expect(didNot.failure).toEqual({ kind: "notCompacted", usedTokens: 250_000 });
    const shrank = apply(
      "compact",
      { status: "completed", finalText: "", usedTokensAfter: 28_000 },
      early,
    );
    expect(shrank.state).toMatchObject({ phase: "waiting", step: "restore" });
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

describe("resolveLeaderCompactionConfig: finish-up, prepare bound and deferral", () => {
  test("defaults: a 10 minute finish-up window, a 30 minute wait for prepare, 20 minutes of deferral", () => {
    const resolved = resolveLeaderCompactionConfig({ enabled: true });
    expect(resolved.finishUpMs).toBe(10 * 60_000);
    expect(resolved.prepareTimeoutMs).toBe(30 * 60_000);
    expect(resolved.maxDeferMs).toBe(20 * 60_000);
  });

  test("the wait for prepare is never shorter than the finish-up window the agent was promised", () => {
    const resolved = resolveLeaderCompactionConfig({
      finishUpMinutes: 15,
      prepareTimeoutMinutes: 5,
    });
    expect(resolved.prepareTimeoutMs).toBe(15 * 60_000);
  });

  test("0 turns each one off", () => {
    const resolved = resolveLeaderCompactionConfig({
      finishUpMinutes: 0,
      prepareTimeoutMinutes: 0,
      maxDeferMinutes: 0,
    });
    expect(resolved).toMatchObject({ finishUpMs: 0, prepareTimeoutMs: 0, maxDeferMs: 0 });
  });

  test("ceilingTokens is capped at 900K, however high it is configured", () => {
    expect(resolveLeaderCompactionConfig({ ceilingTokens: 550_000 }).ceilingTokens).toBe(550_000);
    expect(resolveLeaderCompactionConfig({ ceilingTokens: 900_000 }).ceilingTokens).toBe(900_000);
    expect(resolveLeaderCompactionConfig({ ceilingTokens: 950_000 }).ceilingTokens).toBe(900_000);
  });

  test("warns once at resolve when ceilingTokens is above 800K, not when it is under", () => {
    const warnings: number[] = [];
    const onCeilingTokensTooHigh = (raw: number) => warnings.push(raw);
    resolveLeaderCompactionConfig({ ceilingTokens: 800_000 }, { onCeilingTokensTooHigh });
    expect(warnings).toEqual([]);
    resolveLeaderCompactionConfig({ ceilingTokens: 850_000 }, { onCeilingTokensTooHigh });
    expect(warnings).toEqual([850_000]);
  });
});

describe("parseLeaderCompactionDeferral", () => {
  test("reads exactly `DEFER <minutes>: <reason>`", () => {
    expect(parseLeaderCompactionDeferral("DEFER 15: waiting on the iOS build")).toEqual({
      minutes: 15,
      reason: "waiting on the iOS build",
    });
  });

  test("tolerates surrounding whitespace, backticks and a trailing period", () => {
    expect(parseLeaderCompactionDeferral("  `DEFER 5: pushing the branch.`\n")).toEqual({
      minutes: 5,
      reason: "pushing the branch.",
    });
  });

  test("reads any case, as long as it is one line", () => {
    expect(parseLeaderCompactionDeferral("Defer 10: building the APK")).toEqual({
      minutes: 10,
      reason: "building the APK",
    });
    expect(parseLeaderCompactionDeferral("defer 10: building the APK")).toEqual({
      minutes: 10,
      reason: "building the APK",
    });
  });

  test("strips surrounding markdown emphasis before the strict parse", () => {
    expect(parseLeaderCompactionDeferral("**DEFER 10: building the APK**")).toEqual({
      minutes: 10,
      reason: "building the APK",
    });
    expect(parseLeaderCompactionDeferral("_DEFER 10: building the APK_")).toEqual({
      minutes: 10,
      reason: "building the APK",
    });
  });

  test("a restore note is never read as a deferral, even one that mentions DEFER", () => {
    expect(parseLeaderCompactionDeferral("GOAL: ship it.\nDEFER 5: later")).toBeNull();
    expect(parseLeaderCompactionDeferral("I will defer 5: no")).toBeNull();
    expect(parseLeaderCompactionDeferral("DEFER 5 minutes please")).toBeNull();
    expect(parseLeaderCompactionDeferral("")).toBeNull();
  });

  test("stays strict about everything but case and markdown: minutes-with-unit and multi-line still miss", () => {
    expect(parseLeaderCompactionDeferral("DEFER 10 minutes: building the APK")).toBeNull();
    expect(parseLeaderCompactionDeferral("DEFER 10: building the APK\nmore text")).toBeNull();
    expect(parseLeaderCompactionDeferral("more text\nDEFER 10: building the APK")).toBeNull();
  });

  test("needs a positive whole number of minutes and a reason", () => {
    expect(parseLeaderCompactionDeferral("DEFER 0: now")).toBeNull();
    expect(parseLeaderCompactionDeferral("DEFER -3: x")).toBeNull();
    expect(parseLeaderCompactionDeferral("DEFER 2.5: x")).toBeNull();
    expect(parseLeaderCompactionDeferral("DEFER 5:")).toBeNull();
    expect(parseLeaderCompactionDeferral("DEFER 5:   ")).toBeNull();
  });
});

describe("looksLikeAttemptedDeferral", () => {
  test("matches a defer-looking first or last line, case-insensitively", () => {
    expect(looksLikeAttemptedDeferral("DEFER 10 minutes: building the APK")).toBe(true);
    expect(looksLikeAttemptedDeferral("defer: no reason given")).toBe(true);
    expect(looksLikeAttemptedDeferral("GOAL: ship it.\nDEFER 5: later")).toBe(true);
    expect(looksLikeAttemptedDeferral("DEFER 5: later\nGOAL: ship it.")).toBe(true);
  });

  test("does not match an ordinary note, even one that discusses deferring in prose", () => {
    expect(looksLikeAttemptedDeferral("GOAL: ship it. NEXT: review PR 12.")).toBe(false);
    expect(looksLikeAttemptedDeferral("I decided not to defer this compaction.")).toBe(false);
    expect(looksLikeAttemptedDeferral("")).toBe(false);
  });
});

describe("a prepare reply that asks to defer", () => {
  const deferConfig = resolveLeaderCompactionConfig({
    enabled: true,
    prepareAtTokens: 400_000,
    ceilingTokens: 550_000,
    maxDeferMinutes: 20,
    maxAttempts: 2,
  });

  function applyPrepare(
    finalText: string,
    options: {
      from?: LeaderCompactionEpisode;
      usedTokensAfter?: number | undefined;
      nowMs?: number;
    } = {},
  ) {
    return applyLeaderCompactionTurnOutcome({
      step: "prepare",
      episode: options.from ?? episode,
      result: {
        status: "completed",
        finalText,
        usedTokensAfter: "usedTokensAfter" in options ? options.usedTokensAfter : 480_000,
      },
      config: deferConfig,
      nowMs: options.nowMs ?? 1_000,
    });
  }

  test("is held for the minutes it asked for, with no note and no attempt used", () => {
    const applied = applyPrepare("DEFER 12: waiting on the Android build", { nowMs: 1_000 });
    expect(applied.failure).toBeNull();
    expect(applied.state).toEqual({
      phase: "deferred",
      step: "prepare",
      untilMs: 1_000 + 12 * 60_000,
      episode: {
        ...episode,
        note: null,
        attempts: 0,
        deferral: {
          count: 1,
          grantedMs: 12 * 60_000,
          refused: false,
          refusalEscalated: false,
          lastReason: "waiting on the Android build",
        },
      },
    });
  });

  test("is cut to what is left of the episode's budget", () => {
    const first = applyPrepare("DEFER 15: build", { nowMs: 0 });
    if (first.state.phase !== "deferred") throw new Error("expected a deferral");
    const second = applyPrepare("DEFER 15: still building", {
      from: first.state.episode,
      nowMs: first.state.untilMs,
    });
    expect(second.state).toMatchObject({
      phase: "deferred",
      untilMs: first.state.untilMs + 5 * 60_000,
      episode: { deferral: { count: 2, grantedMs: 20 * 60_000, refused: false } },
    });
  });

  test("is refused once the budget is spent: the same step is asked again, and a plain note is used as one", () => {
    const spent: LeaderCompactionEpisode = {
      ...episode,
      deferral: {
        count: 2,
        grantedMs: 20 * 60_000,
        refused: false,
        refusalEscalated: false,
        lastReason: "x",
      },
    };
    const refused = applyPrepare("DEFER 5: one more minute", { from: spent });
    expect(refused.failure).toBeNull();
    expect(refused.state).toMatchObject({
      phase: "waiting",
      step: "prepare",
      episode: { note: null, deferral: { grantedMs: 20 * 60_000, refused: true } },
    });
    if (refused.state.phase !== "waiting") throw new Error("expected waiting");
    const again = applyPrepare("GOAL: ship it. NEXT: review PR 12.", {
      from: refused.state.episode,
    });
    expect(again.state).toMatchObject({
      phase: "waiting",
      step: "compact",
      episode: { note: "GOAL: ship it. NEXT: review PR 12." },
    });
  });

  test("refused, then DEFER again: not taken as the note, asked once more with explicit wording", () => {
    const refused: LeaderCompactionEpisode = {
      ...episode,
      deferral: {
        count: 2,
        grantedMs: 20 * 60_000,
        refused: true,
        refusalEscalated: false,
        lastReason: "x",
      },
    };
    const applied = applyPrepare("DEFER 5: please", { from: refused });
    expect(applied.failure).toBeNull();
    expect(applied.gaveUp).toBe(false);
    expect(applied.state).toMatchObject({
      phase: "waiting",
      step: "prepare",
      episode: {
        note: null,
        attempts: 0,
        deferral: { refused: true, refusalEscalated: true },
      },
    });
  });

  test("refused, then DEFER twice: a failed try, never compacted with that reply as the note", () => {
    const escalated: LeaderCompactionEpisode = {
      ...episode,
      deferral: {
        count: 2,
        grantedMs: 20 * 60_000,
        refused: true,
        refusalEscalated: true,
        lastReason: "x",
      },
    };
    const applied = applyPrepare("DEFER 5: still not done", { from: escalated });
    expect(applied.failure).toEqual({ kind: "deferredAfterRefusal" });
    expect(applied.gaveUp).toBe(false);
    expect(applied.state).toMatchObject({
      phase: "backoff",
      step: "prepare",
      episode: { note: null, attempts: 1 },
    });
  });

  test("is refused at or over the ceiling: waiting that long costs more than the interruption", () => {
    const applied = applyPrepare("DEFER 5: pushing", { usedTokensAfter: 550_000 });
    expect(applied.state).toMatchObject({
      phase: "waiting",
      step: "prepare",
      episode: { deferral: { refused: true, count: 0 } },
    });
  });

  test("is refused when the context size could not be read", () => {
    const applied = applyPrepare("DEFER 5: pushing", { usedTokensAfter: undefined });
    expect(applied.state).toMatchObject({ phase: "waiting", step: "prepare" });
  });

  test("is refused when deferral is off", () => {
    const off = resolveLeaderCompactionConfig({ enabled: true, maxDeferMinutes: 0 });
    const applied = applyLeaderCompactionTurnOutcome({
      step: "prepare",
      episode,
      result: { status: "completed", finalText: "DEFER 5: pushing", usedTokensAfter: 450_000 },
      config: off,
      nowMs: 0,
    });
    expect(applied.state).toMatchObject({ phase: "waiting", step: "prepare" });
  });

  test("a note that is not a deferral still moves on to compact", () => {
    const applied = applyPrepare("GOAL: ship it. NEXT: review PR 12.");
    expect(applied.state).toMatchObject({
      phase: "waiting",
      step: "compact",
      episode: { note: "GOAL: ship it. NEXT: review PR 12." },
    });
  });

  test("a case-variant or markdown-wrapped DEFER is granted, not taken as the note", () => {
    const caseVariant = applyPrepare("Defer 10: building the APK");
    expect(caseVariant.state).toMatchObject({ phase: "deferred", step: "prepare" });
    const markdownWrapped = applyPrepare("**DEFER 10: building the APK**");
    expect(markdownWrapped.state).toMatchObject({ phase: "deferred", step: "prepare" });
  });

  test("a near-miss DEFER that becomes the note is flagged for the log", () => {
    const minutesWithUnit = applyPrepare("DEFER 10 minutes: building the APK");
    expect(minutesWithUnit.state).toMatchObject({
      phase: "waiting",
      step: "compact",
      episode: { note: "DEFER 10 minutes: building the APK" },
    });
    expect(minutesWithUnit.noteLooksLikeAttemptedDeferral).toBe(true);

    const ordinary = applyPrepare("GOAL: ship it. NEXT: review PR 12.");
    expect(ordinary.noteLooksLikeAttemptedDeferral).toBeUndefined();
  });
});

describe("planLeaderCompactionStep while the agent has deferred", () => {
  const deferConfig = resolveLeaderCompactionConfig({
    enabled: true,
    prepareAtTokens: 400_000,
    ceilingTokens: 550_000,
  });
  const deferred: LeaderCompactionState = {
    phase: "deferred",
    step: "prepare",
    untilMs: 600_000,
    episode: {
      ...episode,
      deferral: {
        count: 1,
        grantedMs: 600_000,
        refused: false,
        refusalEscalated: false,
        lastReason: "build",
      },
    },
  };

  function planDeferred(nowMs: number, agent: LeaderCompactionAgentInput) {
    return planLeaderCompactionStep({ state: deferred, agent, config: deferConfig, nowMs });
  }

  test("holds, and starts nothing, until the wait is over", () => {
    expect(planDeferred(599_999, leader()).action).toEqual({ kind: "none" });
    expect(planDeferred(599_999, leader()).state).toEqual(deferred);
  });

  test("asks for the note again at the end of the wait, once the agent is idle", () => {
    expect(planDeferred(600_000, leader()).action).toMatchObject({
      kind: "startTurn",
      step: "prepare",
    });
    expect(planDeferred(600_000, leader({ lifecycle: "running", busy: true })).state).toMatchObject(
      { phase: "waiting", step: "prepare" },
    );
  });

  test("the ceiling ends the wait early", () => {
    const result = planDeferred(1_000, leader({ contextWindowUsedTokens: 560_000 }));
    expect(result.action).toMatchObject({ kind: "startTurn", step: "prepare" });
  });

  test("is dropped like any waiting episode when the context shrank on its own", () => {
    expect(planDeferred(600_000, leader({ contextWindowUsedTokens: 50_000 })).state).toEqual({
      phase: "armed",
    });
  });

  test("is dropped when the agent stops being a candidate", () => {
    expect(planDeferred(1_000, leader({ isDelegated: true })).state).toEqual({ phase: "armed" });
  });
});

describe("leaderCompactionDeferMinutesLeft", () => {
  const offerConfig = resolveLeaderCompactionConfig({
    enabled: true,
    ceilingTokens: 550_000,
    maxDeferMinutes: 20,
  });

  test("is the whole minutes of the budget not yet granted", () => {
    expect(leaderCompactionDeferMinutesLeft(episode.deferral, offerConfig, 450_000)).toBe(20);
    const used: LeaderCompactionEpisode = {
      ...episode,
      deferral: {
        count: 1,
        grantedMs: 12.5 * 60_000,
        refused: false,
        refusalEscalated: false,
        lastReason: null,
      },
    };
    expect(leaderCompactionDeferMinutesLeft(used.deferral, offerConfig, 450_000)).toBe(7);
  });

  test("is 0 at the ceiling, after a refusal, with the budget under a minute, or with no reading", () => {
    expect(leaderCompactionDeferMinutesLeft(episode.deferral, offerConfig, 550_000)).toBe(0);
    expect(leaderCompactionDeferMinutesLeft(episode.deferral, offerConfig, undefined)).toBe(0);
    expect(
      leaderCompactionDeferMinutesLeft(
        { ...NO_LEADER_COMPACTION_DEFERRAL, refused: true },
        offerConfig,
        450_000,
      ),
    ).toBe(0);
    expect(
      leaderCompactionDeferMinutesLeft(
        { ...NO_LEADER_COMPACTION_DEFERRAL, grantedMs: 19.5 * 60_000 },
        offerConfig,
        450_000,
      ),
    ).toBe(0);
  });
});

describe("a prepare turn that outlives the wait for it", () => {
  const timeoutConfig = resolveLeaderCompactionConfig({
    enabled: true,
    prepareTimeoutMinutes: 30,
    maxAttempts: 2,
    retryAfterMinutes: 30,
  });

  test("hasLeaderCompactionPrepareTimedOut counts from the step's start, and 0 never times out", () => {
    expect(hasLeaderCompactionPrepareTimedOut(0, 30 * 60_000 - 1, timeoutConfig)).toBe(false);
    expect(hasLeaderCompactionPrepareTimedOut(0, 30 * 60_000, timeoutConfig)).toBe(true);
    const unbounded = resolveLeaderCompactionConfig({ prepareTimeoutMinutes: 0 });
    expect(hasLeaderCompactionPrepareTimedOut(0, 10 * 24 * 60 * 60_000, unbounded)).toBe(false);
  });

  test("is a failed try like any other: it backs off, and the last one gives up", () => {
    const first = applyLeaderCompactionTurnOutcome({
      step: "prepare",
      episode,
      result: { status: "timedOut" },
      config: timeoutConfig,
      nowMs: 0,
    });
    expect(first.failure).toEqual({ kind: "timedOut" });
    expect(first.state).toMatchObject({
      phase: "backoff",
      step: "prepare",
      untilMs: 30 * 60_000,
      episode: { attempts: 1 },
    });
    if (first.state.phase !== "backoff") throw new Error("expected backoff");
    const last = applyLeaderCompactionTurnOutcome({
      step: "prepare",
      episode: first.state.episode,
      result: { status: "timedOut" },
      config: timeoutConfig,
      nowMs: 31 * 60_000,
    });
    expect(last).toMatchObject({ gaveUp: true, state: { phase: "settled", reason: "gaveUp" } });
  });
});
