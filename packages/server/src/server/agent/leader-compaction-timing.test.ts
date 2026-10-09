import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";

import { formatPrepareMessage, formatRestoreMessage } from "../agent-leader-compaction-monitor.js";
import { createTestJevService, type JevScriptedAnswer } from "../jev/fake.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { formatSystemNotificationPrompt } from "./agent-prompt.js";
import {
  resolveLeaderCompactionConfig,
  type LeaderCompactionAgentInput,
  type LeaderCompactionSettings,
} from "./leader-compaction-planner.js";
import {
  LeaderCompactionTimingAdvisor,
  readCompactionTimingView,
  type CompactionTimingSettings,
} from "./leader-compaction-timing.js";

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
let seq = 0;
let callSeq = 0;

function row(item: AgentTimelineItem): AgentTimelineRow {
  seq += 1;
  return { seq, timestamp: new Date(T0 + seq * 1000).toISOString(), item };
}

function user(text: string): AgentTimelineRow {
  return row({ type: "user_message", text });
}

function assistant(text: string): AgentTimelineRow {
  return row({ type: "assistant_message", text });
}

function compaction(): AgentTimelineRow {
  return row({ type: "compaction", status: "completed", trigger: "manual", preTokens: 612_000 });
}

function tool(
  name: string,
  status: "running" | "completed" = "completed",
  input: unknown = {},
): AgentTimelineRow {
  callSeq += 1;
  const base = {
    type: "tool_call" as const,
    callId: `call-${callSeq}`,
    name,
    detail: { type: "unknown" as const, input, output: null },
  };
  return status === "running"
    ? row({ ...base, status, error: null })
    : row({ ...base, status, error: null });
}

const RESTORE = formatRestoreMessage({
  triggeredAtTokens: 612_000,
  lineTokens: 400_000,
  trigger: { kind: "line" },
  attempts: 0,
  note: "GOAL: ship the export screen. NEXT: CSV download.",
  compactedFromTokens: 612_000,
  compactedToTokens: 31_000,
});

/** A leader compacted once, then three requests: CSV work, a child's finish, a new bug. */
function leaderTimeline(turn: AgentTimelineRow[] = []): AgentTimelineRow[] {
  return [
    user("Build the export screen"),
    assistant("Started on the export screen."),
    compaction(),
    user(RESTORE),
    assistant("Picking up from the note."),
    user("Add CSV download to the export screen"),
    tool("Bash"),
    assistant("CSV done, tests pass, committed abc123."),
    user(formatSystemNotificationPrompt("Agent child-1 finished: the export docs are written.")),
    assistant("Noted the docs."),
    user("Now look at the login bug"),
    ...(turn.length > 0
      ? turn
      : [tool("Read"), tool("Edit"), assistant("Fixed the login bug; tests pass; committed.")]),
  ];
}

const SWITCHED: Record<string, JevScriptedAnswer> = {
  switched_gears: { type: "noul", noul: 0.9 },
  at_boundary: { type: "noul", noul: 0.2 },
  needs_history: { type: "score", score: 1.6 },
  mid_operation: { type: "noul", noul: 0.1 },
};
const BOUNDARY: Record<string, JevScriptedAnswer> = {
  switched_gears: { type: "noul", noul: 0.2 },
  at_boundary: { type: "noul", noul: 0.9 },
  needs_history: { type: "score", score: 0.4 },
  mid_operation: { type: "noul", noul: 0.1 },
};
const MID: Record<string, JevScriptedAnswer> = {
  switched_gears: { type: "noul", noul: 0.9 },
  at_boundary: { type: "noul", noul: 0.2 },
  needs_history: { type: "score", score: 1.8 },
  mid_operation: { type: "noul", noul: 0.85 },
};

const TIMING: CompactionTimingSettings = {
  considerAtTokens: 200_000,
  ceilingTokens: 500_000,
  maxDeferrals: 3,
  cutPoint: true,
};

interface Harness {
  advisor: LeaderCompactionTimingAdvisor;
  jev: ReturnType<typeof createTestJevService>;
  agent: LeaderCompactionAgentInput;
  rows: AgentTimelineRow[];
  settings: LeaderCompactionSettings;
  episodeOpen: boolean;
  timing: CompactionTimingSettings;
  timelineReads: number;
  timelineThrows: boolean;
  warnings: string[];
  /** One finished turn at `usedTokens`, awaited to its verdict. */
  turn: (usedTokens: number) => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.jev.stop();
});

async function createHarness(
  options: {
    answers?: Record<string, JevScriptedAnswer>;
    jevConfig?: Record<string, unknown>;
  } = {},
): Promise<Harness> {
  const jev = createTestJevService({
    answers: options.answers ?? SWITCHED,
    config: options.jevConfig,
    service: { resolveAgentCwds: async () => [tmpdir()] },
  });
  await jev.start();
  const h: Harness = {
    jev,
    agent: {
      sessionFamily: "claude",
      internal: false,
      isDelegated: false,
      lifecycle: "idle",
      busy: false,
      pendingPermissionCount: 0,
      contextWindowUsedTokens: 30_000,
    },
    rows: leaderTimeline(),
    settings: { enabled: true, dryRun: true },
    episodeOpen: false,
    timing: { ...TIMING },
    timelineReads: 0,
    timelineThrows: false,
    warnings: [],
    advisor: undefined as unknown as LeaderCompactionTimingAdvisor,
    turn: async (usedTokens) => {
      h.agent = { ...h.agent, contextWindowUsedTokens: usedTokens };
      h.advisor.onTurnFinished({ agentId: "leader-1" });
      await h.advisor.settle();
    },
  };
  h.advisor = new LeaderCompactionTimingAdvisor({
    jev,
    readAgent: (agentId) => (agentId === "leader-1" ? h.agent : null),
    readTimeline: () => {
      h.timelineReads += 1;
      if (h.timelineThrows) throw new Error("agent closed");
      return h.rows;
    },
    readLeaderCompaction: () => h.settings,
    readTimingConfig: () => h.timing,
    isEpisodeOpen: () => h.episodeOpen,
    logger: { warn: (_obj, msg) => h.warnings.push(msg ?? "") },
  });
  harnesses.push(h);
  return h;
}

/** A leader first seen at 30K that grew past the consider line: the growth guard holds. */
async function grownHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = await createHarness(options);
  await h.turn(30_000);
  return h;
}

function timingCalls(h: Harness) {
  return h.jev.transport.calls.filter((call) => "switched_gears" in call.questions);
}

function timingEvents(h: Harness) {
  return h.jev.savings
    .events({ range: "all" })
    .events.filter((event) => event.feature === "compactionTiming");
}

function notAsked(h: Harness) {
  return h.jev.savings.summary("today").features.find((f) => f.feature === "compactionTiming")
    ?.notAsked;
}

const LIVE_JEV = { compactionTiming: { shadow: false } };

describe("when the advisor asks", () => {
  test("no call while leader compaction is off, under the line, for a non-candidate, or while an episode is open", async () => {
    const h = await grownHarness();

    h.settings = { enabled: false };
    await h.turn(260_000);
    h.settings = { enabled: true, dryRun: true };
    await h.turn(150_000);
    h.agent = { ...h.agent, isDelegated: true };
    await h.turn(260_000);
    h.agent = { ...h.agent, isDelegated: false, sessionFamily: "codex" };
    await h.turn(260_000);
    h.agent = { ...h.agent, sessionFamily: "claude" };
    h.episodeOpen = true;
    await h.turn(260_000);

    expect(h.jev.transport.calls).toEqual([]);
  });

  test("in leader-compaction dry run it still asks, once per turn over the line", async () => {
    const h = await grownHarness();
    await h.turn(260_000);
    await h.turn(270_000);
    expect(timingCalls(h)).toHaveLength(2);
  });
});

describe("fail open", () => {
  for (const behavior of [
    { kind: "http", status: 500 },
    { kind: "contract-violation" },
    { kind: "network" },
  ] as const) {
    test(`a ${behavior.kind} failure leaves no verdict, throws nothing and is recorded`, async () => {
      const h = await grownHarness();
      h.jev.transport.setBehavior(behavior);
      await h.turn(260_000);

      expect(h.advisor.verdictFor("leader-1")).toBeNull();
      expect(timingCalls(h)).toHaveLength(1);
      expect(h.warnings).toEqual([]);
      expect(timingEvents(h)).toMatchObject([
        { outcome: "failed", decision: { did: "at-line", wouldBe: "at-line", changed: false } },
      ]);
    });
  }

  test("the feature off, or JEV off, makes no call and counts the turn as not asked", async () => {
    const featureOff = await grownHarness({ jevConfig: { compactionTiming: { enabled: false } } });
    await featureOff.turn(260_000);
    expect(featureOff.jev.transport.calls).toEqual([]);
    expect(featureOff.timelineReads).toBe(0);
    expect(notAsked(featureOff)).toEqual({ inactive: 1 });

    const jevOff = await grownHarness({ jevConfig: { enabled: false } });
    await jevOff.turn(260_000);
    expect(jevOff.jev.transport.calls).toEqual([]);
    expect(jevOff.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("a D7-excluded leader is counted, never read and never sent", async () => {
    const h = await grownHarness({ jevConfig: { excludeCwds: [tmpdir()] } });
    await h.turn(260_000);

    expect(h.jev.transport.calls).toEqual([]);
    expect(h.timelineReads).toBe(0);
    expect(timingEvents(h)).toEqual([]);
    expect(notAsked(h)).toEqual({ excluded: 1 });
  });

  test("a timeline that cannot be read logs a warning and leaves no verdict", async () => {
    const h = await grownHarness();
    h.timelineThrows = true;
    await h.turn(260_000);

    expect(h.advisor.verdictFor("leader-1")).toBeNull();
    expect(h.jev.transport.calls).toEqual([]);
    expect(h.warnings).toEqual(["Compaction timing: call failed"]);
  });
});

describe("the state", () => {
  test("is built from the timeline since the last compaction, with envelopes marked", () => {
    const view = readCompactionTimingView(leaderTimeline());
    expect(view.state).toEqual({
      current_request: "Now look at the login bug",
      previous_work: [
        "restore note: GOAL: ship the export screen. NEXT: CSV download.",
        "user: Add CSV download to the export screen",
        "system: Agent child-1 finished: the export docs are written.",
      ].join("\n"),
      recent_turn: "Fixed the login bug; tests pass; committed.",
      tools_this_turn: ["Read", "Edit"],
    });
    expect(view.unfinishedTool).toBe(false);
    expect(view.startedChild).toBe(false);
    expect(view.prepareSent).toBe(false);
    expect(view.turns).toEqual([
      "Add CSV download to the export screen",
      "system: Agent child-1 finished: the export docs are written.",
      "Now look at the login bug",
    ]);
  });

  test("clips each field and says when a turn made only tool calls", () => {
    const view = readCompactionTimingView([
      user(`Rewrite the parser. ${"p".repeat(1000)}`),
      tool("Read"),
      tool("Grep"),
      tool("Read"),
    ]);
    expect(view.state.current_request).toHaveLength(600);
    expect(view.state.previous_work).toBe("(none)");
    expect(view.state.recent_turn).toBe("(tool calls only: Read, Grep)");
    expect(view.state.tools_this_turn).toEqual(["Read", "Grep"]);
  });

  test("sees an unfinished tool call, a started child and a prepare already sent", () => {
    expect(readCompactionTimingView(leaderTimeline([tool("Bash", "running")])).unfinishedTool).toBe(
      true,
    );
    expect(
      readCompactionTimingView(leaderTimeline([tool("mcp__paseo__create_agent")])).startedChild,
    ).toBe(true);
    const rows = [
      ...leaderTimeline(),
      user(formatPrepareMessage(260_000, resolveLeaderCompactionConfig({ enabled: true }))),
      assistant("GOAL: login bug."),
    ];
    const view = readCompactionTimingView(rows);
    expect(view.prepareSent).toBe(true);
    // The monitor's own messages are not turns of the work.
    expect(view.turns.at(-1)).toBe("Now look at the login bug");
  });
});

describe("the verdict", () => {
  test("a switched task under the line starts early, against the consider line", async () => {
    const h = await grownHarness();
    await h.turn(260_000);
    expect(h.advisor.verdictFor("leader-1")).toEqual({
      live: false,
      timing: {
        kind: "startEarly",
        lineTokens: 200_000,
        reason: "your work has moved on to a different task",
      },
    });
  });

  test("a finished unit of work that needs little history starts early", async () => {
    const h = await grownHarness({ answers: BOUNDARY });
    await h.turn(260_000);
    expect(h.advisor.verdictFor("leader-1")?.timing).toMatchObject({ kind: "startEarly" });
  });

  test("a boundary whose next step needs the history, or a leader mid-operation, gives none", async () => {
    const needs = await grownHarness({
      answers: { ...BOUNDARY, needs_history: { type: "score", score: 1.2 } },
    });
    await needs.turn(260_000);
    expect(needs.advisor.verdictFor("leader-1")).toBeNull();

    const mid = await grownHarness({ answers: MID });
    await mid.turn(260_000);
    expect(mid.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("a leader mid-operation at the line is deferred, and not at the ceiling", async () => {
    const h = await grownHarness({ answers: MID });
    await h.turn(450_000);
    expect(h.advisor.verdictFor("leader-1")?.timing).toEqual({
      kind: "defer",
      ceilingTokens: 500_000,
      reason: "you are mid-way through a multi-step edit",
    });
    await h.turn(500_000);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("asks from the lower line when prepareAtTokens is under considerAtTokens", async () => {
    const h = await grownHarness({ answers: MID });
    h.settings = { enabled: true, dryRun: true, prepareAtTokens: 150_000 };
    await h.turn(170_000);
    expect(h.advisor.verdictFor("leader-1")?.timing).toMatchObject({ kind: "defer" });
  });

  test("a clean leader at the line gets no verdict: the line starts it", async () => {
    const h = await grownHarness();
    await h.turn(450_000);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("defers at most maxDeferrals consecutive turns, and a compaction resets the count", async () => {
    const h = await grownHarness({ answers: MID });
    const verdicts: Array<string | null> = [];
    for (const used of [420_000, 430_000, 440_000, 450_000, 460_000]) {
      await h.turn(used);
      verdicts.push(h.advisor.verdictFor("leader-1")?.timing.kind ?? null);
    }
    // The capping turn keeps the count at the cap: no fresh run of three.
    expect(verdicts).toEqual(["defer", "defer", "defer", null, null]);

    await h.turn(30_000);
    await h.turn(420_000);
    expect(h.advisor.verdictFor("leader-1")?.timing.kind).toBe("defer");
  });

  test("answers as live only when the feature is live", async () => {
    const h = await grownHarness({ jevConfig: { compactionTiming: { shadow: false } } });
    await h.turn(260_000);
    expect(h.advisor.verdictFor("leader-1")?.live).toBe(true);
  });

  test("a verdict is replaced by the next turn's, and a late answer for an old turn is dropped", async () => {
    const h = await grownHarness();
    h.jev.transport.setBehavior({ kind: "hold" });
    h.agent = { ...h.agent, contextWindowUsedTokens: 260_000 };
    h.advisor.onTurnFinished({ agentId: "leader-1" });
    await expect.poll(() => h.jev.transport.held).toBe(1);

    h.agent = { ...h.agent, contextWindowUsedTokens: 190_000 };
    h.advisor.onTurnFinished({ agentId: "leader-1" });
    h.jev.transport.release();
    await h.advisor.settle();

    expect(h.advisor.verdictFor("leader-1")).toBeNull();
  });
});

describe("a standing verdict", () => {
  test("is dropped once the feature is off", async () => {
    const h = await grownHarness({ jevConfig: LIVE_JEV });
    await h.turn(260_000);
    expect(h.advisor.verdictFor("leader-1")).not.toBeNull();

    const isActive = vi.spyOn(h.jev, "isActive").mockReturnValue(false);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
    isActive.mockRestore();
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("from a live answer is dropped once the feature is back in shadow", async () => {
    const h = await grownHarness({ jevConfig: LIVE_JEV });
    await h.turn(260_000);
    const status = h.jev.status();
    vi.spyOn(h.jev, "status").mockReturnValue({
      ...status,
      features: { ...status.features, compactionTiming: { enabled: true, shadow: true } },
    });
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("is dropped once its line or ceiling is no longer the configured one", async () => {
    const early = await grownHarness();
    await early.turn(260_000);
    early.timing = { ...early.timing, considerAtTokens: 250_000 };
    expect(early.advisor.verdictFor("leader-1")).toBeNull();

    const held = await grownHarness({ answers: MID });
    await held.turn(450_000);
    held.timing = { ...held.timing, ceilingTokens: 480_000 };
    expect(held.advisor.verdictFor("leader-1")).toBeNull();
  });
});

describe("the startEarly guards", () => {
  test("an unfinished tool call or a child started this turn blocks it", async () => {
    const running = await grownHarness();
    running.rows = leaderTimeline([tool("Bash", "running")]);
    await running.turn(260_000);
    expect(running.advisor.verdictFor("leader-1")).toBeNull();

    const child = await grownHarness();
    child.rows = leaderTimeline([tool("mcp__paseo__create_agent"), assistant("Started a child.")]);
    await child.turn(260_000);
    expect(child.advisor.verdictFor("leader-1")).toBeNull();
  });

  test("less than 50K of growth since the last compaction blocks it", async () => {
    const h = await createHarness();
    // First seen at 230K: growth is counted from there.
    await h.turn(230_000);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
    await h.turn(279_000);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
    await h.turn(281_000);
    expect(h.advisor.verdictFor("leader-1")?.timing.kind).toBe("startEarly");
  });

  test("one early start per compaction cycle", async () => {
    const h = await grownHarness();
    await h.turn(260_000);
    expect(h.advisor.verdictFor("leader-1")?.timing.kind).toBe("startEarly");
    h.advisor.noteEarlyStart("leader-1", { dryRun: true });
    // The start used the verdict up.
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
    await h.turn(320_000);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();

    // Compacted: a new cycle, which has to grow 50K again.
    await h.turn(30_000);
    await h.turn(260_000);
    expect(h.advisor.verdictFor("leader-1")?.timing.kind).toBe("startEarly");
  });

  test("a prepare already sent since the last compaction blocks it, across a restart", async () => {
    const h = await grownHarness();
    h.rows = [
      ...leaderTimeline(),
      user(formatPrepareMessage(260_000, resolveLeaderCompactionConfig({ enabled: true }))),
      assistant("GOAL: login bug."),
      user("Carry on"),
      assistant("Done; committed."),
    ];
    await h.turn(300_000);
    expect(h.advisor.verdictFor("leader-1")).toBeNull();
  });
});

describe("the savings ledger", () => {
  test("each answered verdict writes a compactionTiming shadow involvement", async () => {
    const h = await grownHarness();
    await h.turn(260_000);
    await h.turn(270_000);

    const events = h.jev.savings
      .events({ range: "all" })
      .events.filter((event) => event.feature === "compactionTiming");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      feature: "compactionTiming",
      involvement: "Is this a clean point to compact the leader?",
      agentId: "leader-1",
      mode: "shadow",
      decision: { did: "at-line", wouldBe: "start-early", changed: false },
      benefit: "none",
      tokensSavedEstimate: null,
    });
  });
});

describe("the savings record says what acted", () => {
  test("a live answer in a dry run never claims it acted", async () => {
    const h = await grownHarness({ jevConfig: LIVE_JEV });
    await h.turn(260_000);
    h.advisor.noteEarlyStart("leader-1", { dryRun: true });

    expect(timingEvents(h)).toMatchObject([
      { mode: "live", decision: { did: "at-line", wouldBe: "start-early", changed: false } },
    ]);
  });

  test("a live verdict a live leg acted on records what it did, once", async () => {
    const early = await grownHarness({ jevConfig: LIVE_JEV });
    early.settings = { enabled: true };
    await early.turn(260_000);
    expect(timingEvents(early)).toEqual([]);
    early.advisor.noteEarlyStart("leader-1", { dryRun: false });
    expect(timingEvents(early)).toMatchObject([
      { mode: "live", decision: { did: "start-early", wouldBe: "start-early", changed: true } },
    ]);

    const held = await grownHarness({ answers: MID, jevConfig: LIVE_JEV });
    held.settings = { enabled: true };
    await held.turn(450_000);
    held.advisor.noteDefer("leader-1", { dryRun: false });
    held.advisor.noteDefer("leader-1", { dryRun: false });
    expect(timingEvents(held)).toMatchObject([
      { decision: { did: "defer", wouldBe: "defer", changed: true } },
    ]);
  });

  test("a live verdict nothing acted on records nothing changed when the next turn replaces it", async () => {
    const h = await grownHarness({ jevConfig: LIVE_JEV });
    h.settings = { enabled: true };
    await h.turn(260_000);
    await h.turn(270_000);

    const events = timingEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      decision: { did: "at-line", wouldBe: "start-early", changed: false },
    });
  });
});

describe("the cut point", () => {
  const LIVE = { compactionTiming: { shadow: false } };

  async function cutPoint(
    answer: JevScriptedAnswer,
    jevConfig: Record<string, unknown> = LIVE,
    timing: Partial<CompactionTimingSettings> = {},
  ) {
    const h = await createHarness({ answers: { ...SWITCHED, live_from: answer }, jevConfig });
    h.timing = { ...h.timing, ...timing };
    h.advisor.requestCutPoint("leader-1");
    await h.advisor.settle();
    return h;
  }

  test("a confident pick names the turn the live work starts at", async () => {
    const h = await cutPoint({ type: "choice", choice: "2", confidence: 0.8 });
    expect(h.advisor.cutPointFor("leader-1")).toBe(
      'The live work starts at "Now look at the login bug". Summarize everything before it in a few lines; keep the decisions, file paths and open questions from there on in full.',
    );
    const [call] = h.jev.transport.calls;
    expect(call?.questions["live_from"]).toMatchObject({
      type: "choice",
      criteria: {
        "0": "Add CSV download to the export screen",
        "2": "Now look at the login bug",
        none: "Every turn is still live; keep the most recent context only",
      },
    });
  });

  test("under the floor, `none`, or a shadow answer leaves /compact as it is", async () => {
    const low = await cutPoint({ type: "choice", choice: "2", confidence: 0.55 });
    expect(low.advisor.cutPointFor("leader-1")).toBeNull();
    const none = await cutPoint({ type: "choice", choice: "none", confidence: 0.9 });
    expect(none.advisor.cutPointFor("leader-1")).toBeNull();
    const shadow = await cutPoint({ type: "choice", choice: "2", confidence: 0.9 }, {});
    expect(shadow.advisor.cutPointFor("leader-1")).toBeNull();
    const [recorded] = shadow.jev.savings.events({ range: "all" }).events;
    expect(recorded).toMatchObject({
      feature: "compactionTiming",
      involvement: "Which turn starts the leader's live work?",
      mode: "shadow",
      decision: { did: "default-summary", wouldBe: "cut-at:2", changed: false },
    });
  });

  test("is not asked when switched off", async () => {
    const h = await cutPoint({ type: "choice", choice: "2", confidence: 0.9 }, LIVE, {
      cutPoint: false,
    });
    expect(h.jev.transport.calls).toEqual([]);
  });
});
