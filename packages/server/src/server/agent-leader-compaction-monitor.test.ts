import { describe, expect, test } from "vitest";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import type {
  AgentOperatorSignal,
  IdleTurnOutcome,
  LeaderCompactionAgentSummary,
} from "./agent/agent-manager.js";
import {
  AgentLeaderCompactionMonitor,
  type LeaderCompactionEpisodeObserver,
} from "./agent-leader-compaction-monitor.js";
import type { LeaderCompactionSettings } from "./agent/leader-compaction-planner.js";
import type {
  LeaderCompactionTimingPort,
  LeaderCompactionTimingVerdict,
} from "./agent/leader-compaction-timing.js";

interface SentTurn {
  agentId: string;
  prompt: string;
}

/**
 * Stands in for AgentManager's three methods the monitor uses. Each started turn runs a scripted
 * outcome; `onTurn` lets a test change the agent (shrink its context, as a real /compact does).
 */
class FakeAgents {
  agents: LeaderCompactionAgentSummary[] = [];
  sent: SentTurn[] = [];
  outcomes: IdleTurnOutcome[] = [];
  onTurn: (turn: SentTurn) => void = () => undefined;
  private readonly operatorSignalListeners = new Set<(signal: AgentOperatorSignal) => void>();

  listAgentsForLeaderCompaction(): LeaderCompactionAgentSummary[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  startTurnIfIdle(agentId: string, prompt: AgentPromptInput): Promise<IdleTurnOutcome> | null {
    const agent = this.agents.find((entry) => entry.id === agentId);
    if (!agent || agent.lifecycle !== "idle" || agent.busy) return null;
    const turn = { agentId, prompt: String(prompt) };
    this.sent.push(turn);
    this.onTurn(turn);
    return Promise.resolve(this.outcomes.shift() ?? { status: "completed", finalText: "" });
  }

  subscribeOperatorSignals(listener: (signal: AgentOperatorSignal) => void): () => void {
    this.operatorSignalListeners.add(listener);
    return () => this.operatorSignalListeners.delete(listener);
  }

  /** As `session.ts` does for a message from the app/web/mobile client — never the CLI or MCP. */
  humanPrompt(agentId: string, text: string, atMs: number): void {
    const signal: AgentOperatorSignal = {
      kind: "human-prompt",
      agentId,
      at: new Date(atMs),
      clientMessageId: null,
      text,
    };
    for (const listener of this.operatorSignalListeners) listener(signal);
  }

  /** A signal kind the monitor must not treat as a human prompt. */
  permissionResponse(agentId: string, atMs: number): void {
    const signal: AgentOperatorSignal = {
      kind: "human-permission-response",
      agentId,
      at: new Date(atMs),
      requestId: "req-1",
      response: { behavior: "allow" },
    };
    for (const listener of this.operatorSignalListeners) listener(signal);
  }
}

function leader(overrides: Partial<LeaderCompactionAgentSummary> = {}) {
  return {
    id: "leader-1",
    provider: "claude",
    sessionFamily: "claude",
    internal: false,
    isDelegated: false,
    lifecycle: "idle",
    busy: false,
    pendingPermissionCount: 0,
    contextWindowUsedTokens: 612_000,
    title: "Ship the thing",
    totalTokens: 1_000_000,
    ...overrides,
  } satisfies LeaderCompactionAgentSummary;
}

/** Stands in for the compaction-timing advisor: a scripted verdict, and what the monitor told it. */
class FakeTiming implements LeaderCompactionTimingPort {
  verdict: LeaderCompactionTimingVerdict | null = null;
  cutPoint: string | null = null;
  earlyStarts: Array<{ agentId: string; dryRun: boolean }> = [];
  defers: Array<{ agentId: string; dryRun: boolean }> = [];
  cutPointRequests: string[] = [];

  verdictFor(): LeaderCompactionTimingVerdict | null {
    return this.verdict;
  }

  /** Like the advisor, an early start uses the verdict up. */
  noteEarlyStart(agentId: string, options: { dryRun: boolean }): void {
    this.earlyStarts.push({ agentId, ...options });
    this.verdict = null;
  }

  noteDefer(agentId: string, options: { dryRun: boolean }): void {
    this.defers.push({ agentId, ...options });
  }

  requestCutPoint(agentId: string): void {
    this.cutPointRequests.push(agentId);
  }

  cutPointFor(): string | null {
    return this.cutPoint;
  }
}

const EARLY_REASON = "your last turn finished a unit of work";

function startEarly(live: boolean): LeaderCompactionTimingVerdict {
  return { live, timing: { kind: "startEarly", lineTokens: 200_000, reason: EARLY_REASON } };
}

function defer(live: boolean): LeaderCompactionTimingVerdict {
  return {
    live,
    timing: { kind: "defer", ceilingTokens: 500_000, reason: "you are mid-way through an edit" },
  };
}

function createMonitor(
  fake: FakeAgents,
  settings: LeaderCompactionSettings,
  timing?: FakeTiming,
  now: () => number = () => 0,
  episodeObserver?: LeaderCompactionEpisodeObserver,
) {
  const pushes: Array<{ title: string; body: string; level?: string }> = [];
  const logs: Array<{ msg: string; obj: object }> = [];
  const logger = {
    info: (obj: object, msg?: string) => logs.push({ obj, msg: msg ?? "" }),
    warn: (obj: object, msg?: string) => logs.push({ obj, msg: msg ?? "" }),
    error: (obj: object, msg?: string) => logs.push({ obj, msg: msg ?? "" }),
  };
  const monitor = new AgentLeaderCompactionMonitor({
    agentManager: fake,
    pushNotificationSender: {
      send: async (payload, meta) => {
        pushes.push({ ...payload, level: meta?.level });
      },
    },
    serverId: "server-1",
    readDaemonConfig: () => ({ leaderCompaction: settings }),
    logger,
    now,
    timing,
    episodeObserver,
  });
  return { monitor, pushes, logs };
}

/** Records every observer call verbatim, for assertions. */
class RecordingEpisodeObserver implements LeaderCompactionEpisodeObserver {
  started: Array<Parameters<LeaderCompactionEpisodeObserver["onStepStarted"]>[0]> = [];
  finished: Array<Parameters<LeaderCompactionEpisodeObserver["onStepFinished"]>[0]> = [];

  onStepStarted(input: Parameters<LeaderCompactionEpisodeObserver["onStepStarted"]>[0]): void {
    this.started.push(input);
  }

  onStepFinished(input: Parameters<LeaderCompactionEpisodeObserver["onStepFinished"]>[0]): void {
    this.finished.push(input);
  }
}

async function sweep(monitor: AgentLeaderCompactionMonitor): Promise<void> {
  await monitor.tick();
  await monitor.settle();
}

describe("AgentLeaderCompactionMonitor", () => {
  test("runs prepare, /compact and restore on the same agent and hands the note back", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [
      { status: "completed", finalText: "GOAL: ship it. NEXT: review PR 12." },
      { status: "completed", finalText: "" },
      { status: "completed", finalText: "Picking up from the note." },
    ];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 31_000 })];
      }
    };
    const { monitor } = createMonitor(fake, { enabled: true, prepareAtTokens: 400_000 });

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    expect(fake.sent.map((turn) => turn.agentId)).toEqual(["leader-1", "leader-1", "leader-1"]);
    const [prepare, compact, restore] = fake.sent.map((turn) => turn.prompt);
    expect(prepare).toContain("step 1 of 3");
    expect(prepare).toContain("612K tokens");
    expect(compact.startsWith("/compact ")).toBe(true);
    expect(restore).toContain("step 3 of 3");
    expect(restore).toContain("from 612K tokens; the history is now a 31K-token summary");
    expect(restore).toContain("GOAL: ship it. NEXT: review PR 12.");
    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "done" });

    // Hysteresis: the compacted leader is re-armed, and does nothing until it grows again.
    await sweep(monitor);
    expect(fake.sent).toHaveLength(3);
    expect(monitor.getState("leader-1")).toBeUndefined();
  });

  test("never sends anything to a leader that is mid-turn", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ lifecycle: "running", busy: true })];
    const { monitor } = createMonitor(fake, { enabled: true });

    await sweep(monitor);
    await sweep(monitor);

    expect(fake.sent).toEqual([]);
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "waiting", step: "prepare" });

    fake.agents = [leader()];
    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);
  });

  test("dry run sends nothing and reports the crossing once", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    const { monitor, logs } = createMonitor(fake, { enabled: true, dryRun: true });

    await sweep(monitor);
    await sweep(monitor);

    expect(fake.sent).toEqual([]);
    const reports = logs.filter((log) => log.msg.startsWith("Leader compaction would start"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.obj).toMatchObject({ dryRun: true, agentId: "leader-1", startsNow: true });
  });

  test("off by default: no config means no sends", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    const { monitor } = createMonitor(fake, {});

    await sweep(monitor);

    expect(fake.sent).toEqual([]);
  });

  test("a compaction that never shrinks the context gives up with one push", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    const { monitor, pushes } = createMonitor(fake, {
      enabled: true,
      maxAttempts: 2,
      retryAfterMinutes: 0,
    });

    for (let i = 0; i < 6; i += 1) {
      await sweep(monitor);
    }

    // prepare, then two /compact attempts, then nothing more.
    expect(fake.sent.map((turn) => turn.prompt.slice(0, 8))).toEqual([
      "<paseo-s",
      "/compact",
      "/compact",
    ]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.title).toBe("Could not compact a leader's context");
    // Automation has run out of tries and only a person can compact it now.
    expect(pushes[0]?.level).toBe("alert");
    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "gaveUp" });
  });
});

describe("AgentLeaderCompactionMonitor with the quiet gate and carried prompts", () => {
  test("holds the start while the leader's last human prompt is recent, then starts without carrying the stale prompt", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    let nowMs = 0;
    const { monitor, logs } = createMonitor(
      fake,
      { enabled: true, quietMinutes: 10 },
      undefined,
      () => nowMs,
    );

    fake.humanPrompt("leader-1", "also fix the login bug", 0);
    nowMs = 5 * 60_000;
    await sweep(monitor);
    expect(fake.sent).toEqual([]);
    expect(
      logs.some((log) =>
        /Leader compaction (would hold|held): the leader messaged recently/.test(log.msg),
      ),
    ).toBe(true);

    nowMs = 10 * 60_000 + 1;
    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.prompt).not.toContain("also fix the login bug");
  });

  test("starts at the ceiling despite a recent prompt, and carries it into prepare and restore", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 600_000 })];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 29_000 })];
      }
    };
    const { monitor } = createMonitor(
      fake,
      { enabled: true, quietMinutes: 10 },
      undefined,
      () => 1_000,
    );
    fake.humanPrompt("leader-1", "also fix the login bug", 0);

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    const [prepare, , restore] = fake.sent.map((turn) => turn.prompt);
    expect(prepare).toContain("also fix the login bug");
    expect(restore).toContain("also fix the login bug");
    expect(restore).toContain("Check that each one is answered or already in progress");
  });

  test("a non-human operator signal never gates a start or appears in the restore message", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 29_000 })];
      }
    };
    const { monitor } = createMonitor(fake, { enabled: true, quietMinutes: 10 });
    fake.permissionResponse("leader-1", 0);

    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);
    await sweep(monitor);
    await sweep(monitor);

    const restore = fake.sent.at(-1)?.prompt ?? "";
    expect(restore).not.toContain("messages around the compaction");
  });

  test("a prompt sent while a step is in flight is carried into the restore message", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 612_000 })];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.humanPrompt("leader-1", "please also check the CI run", 500);
        fake.agents = [leader({ contextWindowUsedTokens: 31_000 })];
      }
    };
    const { monitor } = createMonitor(fake, { enabled: true });

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    const restore = fake.sent.at(-1)?.prompt ?? "";
    expect(restore).toContain("please also check the CI run");
    expect(restore).toContain("Check that each one is answered or already in progress");
  });

  test("none quoted when there were none", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 29_000 })];
      }
    };
    const { monitor } = createMonitor(fake, { enabled: true });

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    const restore = fake.sent.at(-1)?.prompt ?? "";
    expect(restore).not.toContain("messages around the compaction");
  });

  test("prepare's next-step bullet carries the newest queued prompt, not the first", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000, busy: true })];
    const { monitor } = createMonitor(fake, { enabled: true, quietMinutes: 10 });

    // The trigger fires while the leader is busy, so `prepare` stays in `waiting` across sweeps
    // and queues both prompts before it ever starts.
    await sweep(monitor);
    fake.humanPrompt("leader-1", "first question", 1_000);
    fake.humanPrompt("leader-1", "second question", 2_000);
    fake.agents = [leader({ contextWindowUsedTokens: 450_000, busy: false })];
    await sweep(monitor);

    const prepare = fake.sent.at(0)?.prompt ?? "";
    expect(prepare).toContain('"second question"');
    expect(prepare).not.toContain('"first question"');
  });
});

describe("AgentLeaderCompactionMonitor episode observer", () => {
  test("no observer configured: the monitor behaves exactly as without one", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [
      { status: "completed", finalText: "note" },
      { status: "completed", finalText: "" },
      { status: "completed", finalText: "restored" },
    ];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 31_000 })];
      }
    };
    const { monitor } = createMonitor(fake, { enabled: true });

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "done" });
  });

  test("fires onStepStarted with the trigger and totalTokensAtStart for a line-triggered prepare", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ totalTokens: 1_000_000 })];
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);

    expect(observer.started).toHaveLength(1);
    expect(observer.started[0]).toMatchObject({
      agentId: "leader-1",
      step: "prepare",
      attempt: 1,
      trigger: { kind: "line" },
      usedTokens: 612_000,
      totalTokensAtStart: 1_000_000,
    });
  });

  test("fires onStepFinished with outcome completed and episodeEnded null when prepare succeeds", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ totalTokens: 1_000_000 })];
    fake.outcomes = [{ status: "completed", finalText: "GOAL: ship it." }];
    fake.onTurn = () => {
      fake.agents = [leader({ totalTokens: 1_000_450 })];
    };
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);

    expect(observer.finished).toHaveLength(1);
    expect(observer.finished[0]).toMatchObject({
      agentId: "leader-1",
      step: "prepare",
      outcome: "completed",
      gaveUp: false,
      episodeEnded: null,
      noteLength: "GOAL: ship it.".length,
      totalTokensAtStart: 1_000_000,
      totalTokensAtEnd: 1_000_450,
    });
  });

  test("fires onStepFinished with episodeEnded done and both context tokens after restore", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ totalTokens: 1_000_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "GOAL: ship it." },
      { status: "completed", finalText: "" },
      { status: "completed", finalText: "restored" },
    ];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 31_000, totalTokens: 1_002_000 })];
      }
    };
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    const restoreFinish = observer.finished.find((entry) => entry.step === "restore");
    expect(restoreFinish).toMatchObject({
      outcome: "completed",
      episodeEnded: "done",
      compactedFromTokens: 612_000,
      compactedToTokens: 31_000,
    });
  });

  test("fires onStepFinished with outcome notCompacted, gaveUp true, episodeEnded gaveUp", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(
      fake,
      { enabled: true, maxAttempts: 2, retryAfterMinutes: 0 },
      undefined,
      undefined,
      observer,
    );

    for (let i = 0; i < 6; i += 1) {
      await sweep(monitor);
    }

    const gaveUpFinish = observer.finished.find((entry) => entry.episodeEnded === "gaveUp");
    expect(gaveUpFinish).toMatchObject({
      step: "compact",
      outcome: "notCompacted",
      gaveUp: true,
      episodeEnded: "gaveUp",
    });
  });

  test("totalTokensAtEnd reflects spend that advanced during the turn", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ totalTokens: 500_000 })];
    fake.outcomes = [{ status: "completed", finalText: "note" }];
    fake.onTurn = () => {
      // The turn itself spends tokens before it resolves.
      fake.agents = [leader({ totalTokens: 530_000 })];
    };
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);

    expect(observer.finished[0]).toMatchObject({
      totalTokensAtStart: 500_000,
      totalTokensAtEnd: 530_000,
    });
  });

  test("an agent that is not idle gets no observer calls this sweep", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ lifecycle: "running", busy: true })];
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);

    expect(observer.started).toEqual([]);
    expect(observer.finished).toEqual([]);
  });
});

describe("AgentLeaderCompactionMonitor with compaction timing", () => {
  test("dry run: a shadow startEarly makes the would-start fire under the line, once", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 260_000 })];
    const timing = new FakeTiming();
    timing.verdict = startEarly(false);
    const { monitor, logs } = createMonitor(fake, { enabled: true, dryRun: true }, timing);

    // The report settles the agent, the next sweep re-arms it under the line, and the one after
    // must not report again.
    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    expect(fake.sent).toEqual([]);
    const reports = logs.filter((log) => log.msg.startsWith("Leader compaction would start"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.obj).toMatchObject({
      agentId: "leader-1",
      usedTokens: 260_000,
      trigger: "early",
      reason: EARLY_REASON,
      prepareMessage: expect.stringContaining(`under the 400K line, but ${EARLY_REASON}`),
    });
    expect(timing.earlyStarts).toEqual([{ agentId: "leader-1", dryRun: true }]);
  });

  test("dry run: a defer holds the would-start and says so once, then the line starts it", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    const timing = new FakeTiming();
    timing.verdict = defer(false);
    const { monitor, logs } = createMonitor(fake, { enabled: true, dryRun: true }, timing);

    await sweep(monitor);
    await sweep(monitor);
    const holds = logs.filter((log) => log.msg.startsWith("Leader compaction would hold"));
    expect(holds).toHaveLength(1);
    expect(holds[0]?.obj).toMatchObject({ agentId: "leader-1", usedTokens: 450_000 });
    expect(timing.defers).toEqual([{ agentId: "leader-1", dryRun: true }]);
    expect(logs.some((log) => log.msg.startsWith("Leader compaction would start"))).toBe(false);

    timing.verdict = null;
    await sweep(monitor);
    const reports = logs.filter((log) => log.msg.startsWith("Leader compaction would start"));
    expect(reports).toHaveLength(1);
    expect(reports[0]?.obj).toMatchObject({ trigger: "line" });
  });

  test("a live leg ignores shadow verdicts", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 260_000 })];
    const timing = new FakeTiming();
    timing.verdict = startEarly(false);
    const { monitor } = createMonitor(fake, { enabled: true }, timing);

    await sweep(monitor);
    expect(fake.sent).toEqual([]);

    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    timing.verdict = defer(false);
    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);
  });

  test("a live startEarly runs the episode against the early line, with the cut point", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 260_000 })];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 29_000 })];
      }
    };
    const timing = new FakeTiming();
    timing.verdict = startEarly(true);
    const { monitor } = createMonitor(fake, { enabled: true }, timing);

    await sweep(monitor);
    expect(monitor.isEpisodeOpen("leader-1")).toBe(true);
    expect(timing.earlyStarts).toEqual([{ agentId: "leader-1", dryRun: false }]);
    expect(timing.cutPointRequests).toEqual(["leader-1"]);
    timing.cutPoint = 'The live work starts at "Fix the login bug".';
    await sweep(monitor);
    await sweep(monitor);

    const [prepare, compact, restore] = fake.sent.map((turn) => turn.prompt);
    expect(prepare).toContain(`260K tokens. That is under the 400K line, but ${EARLY_REASON}`);
    expect(compact).toMatch(/^\/compact .* The live work starts at "Fix the login bug"\.$/);
    expect(restore).toContain("step 3 of 3");
    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "done" });
    expect(monitor.isEpisodeOpen("leader-1")).toBe(false);
  });

  test("a live defer holds an idle leader at the line", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    const timing = new FakeTiming();
    timing.verdict = defer(true);
    const { monitor, logs } = createMonitor(fake, { enabled: true }, timing);

    await sweep(monitor);

    expect(fake.sent).toEqual([]);
    expect(logs.some((log) => log.msg.startsWith("Leader compaction held"))).toBe(true);
    expect(timing.defers).toEqual([{ agentId: "leader-1", dryRun: false }]);
  });

  test("an early episode that gives up logs it and pushes nothing: the line starts the next", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 260_000 })];
    const timing = new FakeTiming();
    timing.verdict = startEarly(true);
    const { monitor, pushes, logs } = createMonitor(
      fake,
      { enabled: true, maxAttempts: 2, retryAfterMinutes: 0 },
      timing,
    );

    for (let i = 0; i < 4; i += 1) {
      await sweep(monitor);
    }

    expect(fake.sent.map((turn) => turn.prompt.slice(0, 8))).toEqual([
      "<paseo-s",
      "/compact",
      "/compact",
    ]);
    expect(pushes).toEqual([]);
    const gaveUp = logs.find((log) => log.msg === "Leader compaction gave up");
    expect(gaveUp?.obj).toMatchObject({ agentId: "leader-1", trigger: "early" });
  });
});
