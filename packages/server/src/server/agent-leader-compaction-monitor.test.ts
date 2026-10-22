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
  /** Set to make the next started turn stay open until `release` is called with its outcome. */
  holdNextTurn = false;
  release: (outcome: IdleTurnOutcome) => void = () => undefined;
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
    if (this.holdNextTurn) {
      this.holdNextTurn = false;
      return new Promise<IdleTurnOutcome>((resolve) => {
        this.release = resolve;
      });
    }
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
    steersAccepted: 0,
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

  abandoned: Array<{ agentId: string; atMs: number }> = [];

  onEpisodeAbandoned(input: { agentId: string; atMs: number }): void {
    this.abandoned.push(input);
  }
}

/** An observer that fails every call, as a broken ledger would. */
class ThrowingEpisodeObserver implements LeaderCompactionEpisodeObserver {
  onStepStarted(): void {
    throw new Error("ledger exploded on start");
  }

  onStepFinished(): void {
    throw new Error("ledger exploded on finish");
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

describe("AgentLeaderCompactionMonitor with scope all", () => {
  test("compacts a delegated agent over the line, and a give-up stays in the log instead of the phone", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ id: "worker-1", isDelegated: true })];
    const { monitor, pushes, logs } = createMonitor(fake, {
      enabled: true,
      scope: "all",
      maxAttempts: 1,
      retryAfterMinutes: 0,
    });

    for (let i = 0; i < 4; i += 1) {
      await sweep(monitor);
    }

    // prepare, then one /compact that never shrinks the context.
    expect(fake.sent.map((turn) => turn.prompt.slice(0, 8))).toEqual(["<paseo-s", "/compact"]);
    expect(monitor.getState("worker-1")).toEqual({ phase: "settled", reason: "gaveUp" });
    expect(pushes).toEqual([]);
    expect(logs.some((log) => log.msg === "Leader compaction gave up")).toBe(true);
  });

  test("the same give-up still pushes for a leader, only the delegated agent is suppressed", async () => {
    const settings: LeaderCompactionSettings = {
      enabled: true,
      scope: "all",
      maxAttempts: 1,
      retryAfterMinutes: 0,
    };

    const workerFake = new FakeAgents();
    workerFake.agents = [leader({ id: "worker-1", isDelegated: true })];
    const {
      monitor: workerMonitor,
      pushes: workerPushes,
      logs: workerLogs,
    } = createMonitor(workerFake, settings);

    const leaderFake = new FakeAgents();
    leaderFake.agents = [leader({ id: "leader-1", isDelegated: false })];
    const {
      monitor: leaderMonitor,
      pushes: leaderPushes,
      logs: leaderLogs,
    } = createMonitor(leaderFake, settings);

    for (let i = 0; i < 4; i += 1) {
      await sweep(workerMonitor);
      await sweep(leaderMonitor);
    }

    expect(workerMonitor.getState("worker-1")).toEqual({ phase: "settled", reason: "gaveUp" });
    expect(leaderMonitor.getState("leader-1")).toEqual({ phase: "settled", reason: "gaveUp" });
    expect(workerLogs.some((log) => log.msg === "Leader compaction gave up")).toBe(true);
    expect(leaderLogs.some((log) => log.msg === "Leader compaction gave up")).toBe(true);

    expect(workerPushes).toEqual([]);
    expect(leaderPushes).toHaveLength(1);
    expect(leaderPushes[0]?.title).toBe("Could not compact a leader's context");
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

describe("AgentLeaderCompactionMonitor episode observer: failures, abandonment, shared turns", () => {
  test("an observer that throws never stops the compaction, and is logged", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 31_000 })];
      }
    };
    const { monitor, logs } = createMonitor(
      fake,
      { enabled: true },
      undefined,
      undefined,
      new ThrowingEpisodeObserver(),
    );

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    expect(fake.sent).toHaveLength(3);
    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "done" });
    expect(logs.some((log) => log.msg === "Compaction ledger observer failed")).toBe(true);
  });

  test("an episode the planner drops (the context shrank on its own) is reported abandoned", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [{ status: "canceled" }];
    const observer = new RecordingEpisodeObserver();
    let nowMs = 0;
    const { monitor } = createMonitor(
      fake,
      { enabled: true, retryAfterMinutes: 30 },
      undefined,
      () => nowMs,
      observer,
    );

    await sweep(monitor);
    expect(monitor.getState("leader-1")?.phase).toBe("backoff");

    // Claude's own auto-compact shrank it before the retry.
    fake.agents = [leader({ contextWindowUsedTokens: 40_000 })];
    nowMs = 31 * 60_000;
    await sweep(monitor);

    expect(monitor.isEpisodeOpen("leader-1")).toBe(false);
    expect(observer.abandoned).toEqual([{ agentId: "leader-1", atMs: 31 * 60_000 }]);
  });

  test("turning the leg off mid-episode reports the open episode abandoned", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [{ status: "canceled" }];
    const observer = new RecordingEpisodeObserver();
    const settings: LeaderCompactionSettings = { enabled: true };
    const { monitor } = createMonitor(fake, settings, undefined, undefined, observer);

    await sweep(monitor);
    settings.enabled = false;
    await sweep(monitor);

    expect(observer.abandoned).toEqual([{ agentId: "leader-1", atMs: 0 }]);
  });

  test("a message steered into a step's turn is reported with the step", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [{ status: "completed", finalText: "GOAL: ship it." }];
    fake.onTurn = () => {
      // Tyler's message joined the running prepare turn.
      fake.agents = [leader({ totalTokens: 1_009_000, steersAccepted: 1 })];
    };
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);

    expect(observer.finished[0]).toMatchObject({ step: "prepare", steeredIn: 1 });
  });
});

describe("AgentLeaderCompactionMonitor episode observer: quiet gate and carried prompts", () => {
  test("a quiet-gate hold reaches the episode's first step as when it held and when it lifted", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 29_000 })];
      }
    };
    const observer = new RecordingEpisodeObserver();
    let nowMs = 0;
    const { monitor } = createMonitor(
      fake,
      { enabled: true, quietMinutes: 10 },
      undefined,
      () => nowMs,
      observer,
    );

    fake.humanPrompt("leader-1", "also fix the login bug", 0);
    nowMs = 2 * 60_000;
    await sweep(monitor);
    nowMs = 6 * 60_000;
    await sweep(monitor);
    expect(observer.started).toEqual([]);

    nowMs = 10 * 60_000 + 1;
    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    expect(observer.started.map((entry) => entry.quietGate)).toEqual([
      { heldFromMs: 2 * 60_000, heldUntilMs: 10 * 60_000 + 1 },
      null,
      null,
    ]);
  });

  test("an episode the gate never held carries no quiet gate", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, { enabled: true }, undefined, undefined, observer);

    await sweep(monitor);

    expect(observer.started[0]?.quietGate).toBeNull();
  });

  test("a dry-run hold is not left over for the next live episode", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    const observer = new RecordingEpisodeObserver();
    let nowMs = 0;
    const settings: LeaderCompactionSettings = { enabled: true, dryRun: true, quietMinutes: 10 };
    const { monitor } = createMonitor(fake, settings, undefined, () => nowMs, observer);

    fake.humanPrompt("leader-1", "hi", 0);
    nowMs = 60_000;
    await sweep(monitor); // held
    nowMs = 11 * 60_000;
    await sweep(monitor); // dry run "starts": settled, no step
    settings.dryRun = false;
    fake.agents = [leader({ contextWindowUsedTokens: 40_000 })];
    await sweep(monitor); // back under the line: re-armed
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    nowMs = 30 * 60_000;
    await sweep(monitor);

    expect(observer.started[0]?.quietGate).toBeNull();
  });

  test("carried prompts reach the observer: at each step start, and as carried at the end", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 600_000 })];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.humanPrompt("leader-1", "please also check the CI run", 500);
        fake.agents = [leader({ contextWindowUsedTokens: 29_000 })];
      }
    };
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(
      fake,
      { enabled: true, quietMinutes: 10 },
      undefined,
      () => 1_000,
      observer,
    );
    fake.humanPrompt("leader-1", "also fix the login bug", 0);

    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);

    expect(observer.started[0]?.carriedPrompts).toEqual([
      { atMs: 0, text: "also fix the login bug" },
    ]);
    const restoreFinish = observer.finished.find((entry) => entry.step === "restore");
    expect(restoreFinish?.carriedPrompts).toEqual([
      { atMs: 0, text: "also fix the login bug" },
      { atMs: 500, text: "please also check the CI run" },
    ]);
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

describe("AgentLeaderCompactionMonitor finish-up window", () => {
  const FINISH_UP_SETTINGS: LeaderCompactionSettings = { enabled: true, prepareAtTokens: 400_000 };

  async function firstPrepare(settings: LeaderCompactionSettings, contextTokens = 450_000) {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: contextTokens })];
    const { monitor } = createMonitor(fake, settings);
    await sweep(monitor);
    return fake.sent[0]?.prompt ?? "";
  }

  test("prepare lets an agent partway through a critical step finish just that step first", async () => {
    const prepare = await firstPrepare(FINISH_UP_SETTINGS);
    expect(prepare).toContain("partway through a step");
    expect(prepare).toContain("a merge, push, deploy, migration, multi-file edit");
    expect(prepare).toContain("a build or test you are waiting on");
    expect(prepare).toContain("at most about 10 minutes");
    expect(prepare).toContain("start nothing new");
    expect(prepare).toContain("call no tools");
    expect(prepare).toContain("final message");
  });

  test("the window is whatever finishUpMinutes says", async () => {
    expect(await firstPrepare({ ...FINISH_UP_SETTINGS, finishUpMinutes: 4 })).toContain(
      "at most about 4 minutes",
    );
  });

  test("finishUpMinutes 0 goes back to telling the agent to call no tools", async () => {
    const prepare = await firstPrepare({ ...FINISH_UP_SETTINGS, finishUpMinutes: 0 });
    expect(prepare).toContain("Do not call tools or start anything new");
    expect(prepare).not.toContain("partway through a step");
    expect(prepare).not.toContain("DEFER");
  });

  test("offers a deferral for what is left of the budget, and says what the reply looks like", async () => {
    const prepare = await firstPrepare(FINISH_UP_SETTINGS);
    expect(prepare).toContain("`DEFER <minutes>: <reason>`");
    expect(prepare).toContain("at most 20 minutes");
  });

  test("offers no deferral when it is off, or when the context is already at the ceiling", async () => {
    const off = await firstPrepare({ ...FINISH_UP_SETTINGS, maxDeferMinutes: 0 });
    expect(off).not.toContain("DEFER");
    expect(off).toContain("say in the note exactly where it stands");
    const atCeiling = await firstPrepare(FINISH_UP_SETTINGS, 560_000);
    expect(atCeiling).not.toContain("DEFER");
    expect(atCeiling).toContain("partway through a step");
  });
});

describe("AgentLeaderCompactionMonitor deferral", () => {
  const settings: LeaderCompactionSettings = {
    enabled: true,
    prepareAtTokens: 400_000,
    ceilingTokens: 550_000,
    maxDeferMinutes: 20,
  };

  test("a deferral holds the episode, asks again afterwards, and the second reply is the note", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "DEFER 12: the iOS build is finishing" },
      { status: "completed", finalText: "GOAL: ship it. NEXT: install the build." },
      { status: "completed", finalText: "" },
      { status: "completed", finalText: "Picking up from the note." },
    ];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 30_000 })];
      }
    };
    const { monitor, logs } = createMonitor(fake, settings, undefined, () => nowMs);

    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);
    expect(monitor.getState("leader-1")).toMatchObject({
      phase: "deferred",
      step: "prepare",
      untilMs: 12 * 60_000,
    });
    expect(
      logs.find((log) => log.msg === "Leader compaction deferred at the agent's request")?.obj,
    ).toMatchObject({ agentId: "leader-1", minutes: 12, reason: "the iOS build is finishing" });

    nowMs = 12 * 60_000 - 1;
    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);

    nowMs = 12 * 60_000;
    await sweep(monitor);
    expect(fake.sent).toHaveLength(2);
    const reask = fake.sent[1]?.prompt ?? "";
    expect(reask).toContain("step 1 of 3");
    expect(reask).toContain("You deferred this by 12 minutes");
    expect(reask).toContain("at most 8 minutes");

    await sweep(monitor);
    expect(fake.sent[2]?.prompt.startsWith("/compact")).toBe(true);
    await sweep(monitor);
    expect(fake.sent[3]?.prompt).toContain("GOAL: ship it. NEXT: install the build.");
    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "done" });
  });

  test("a deferral does not use an attempt: three in a row do not give up", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "DEFER 5: step one" },
      { status: "completed", finalText: "DEFER 5: step two" },
      { status: "completed", finalText: "DEFER 5: step three" },
    ];
    const { monitor, pushes } = createMonitor(
      fake,
      { ...settings, maxAttempts: 1 },
      undefined,
      () => nowMs,
    );
    for (let i = 0; i < 3; i += 1) {
      await sweep(monitor);
      nowMs += 5 * 60_000;
    }
    expect(fake.sent).toHaveLength(3);
    expect(pushes).toEqual([]);
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "deferred" });
  });

  test("a deferral past the ceiling is refused, and the reply to the second ask is taken as the note", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 560_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "DEFER 10: still pushing" },
      { status: "completed", finalText: "GOAL: push. NEXT: open the PR." },
    ];
    const { monitor, logs } = createMonitor(fake, settings);

    await sweep(monitor);
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "waiting", step: "prepare" });
    expect(logs.some((log) => log.msg === "Leader compaction deferral refused")).toBe(true);

    await sweep(monitor);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.prompt).toContain("cannot be deferred any further");
    expect(monitor.getState("leader-1")).toMatchObject({
      phase: "waiting",
      step: "compact",
      episode: { note: "GOAL: push. NEXT: open the PR." },
    });
  });

  test("the ceiling ends a deferral early", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "DEFER 20: long migration" },
      { status: "completed", finalText: "GOAL: migrate." },
    ];
    const { monitor } = createMonitor(fake, settings);

    await sweep(monitor);
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "deferred" });
    await sweep(monitor);
    expect(fake.sent).toHaveLength(1);

    fake.agents = [leader({ contextWindowUsedTokens: 551_000 })];
    await sweep(monitor);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.prompt).not.toContain("`DEFER");
  });

  test("a human prompt sent during a deferral is carried into the restore message", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "DEFER 5: pushing" },
      { status: "completed", finalText: "GOAL: push." },
      { status: "completed", finalText: "" },
      { status: "completed", finalText: "" },
    ];
    fake.onTurn = (turn) => {
      if (turn.prompt.startsWith("/compact")) {
        fake.agents = [leader({ contextWindowUsedTokens: 30_000 })];
      }
    };
    const { monitor } = createMonitor(fake, settings, undefined, () => nowMs);

    await sweep(monitor);
    fake.humanPrompt("leader-1", "also rename the flag", 60_000);
    nowMs = 5 * 60_000;
    await sweep(monitor);
    await sweep(monitor);
    await sweep(monitor);
    expect(fake.sent[3]?.prompt).toContain("also rename the flag");
  });

  test("turning the leg off during a deferral reports the episode abandoned", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.outcomes = [{ status: "completed", finalText: "DEFER 5: pushing" }];
    let current: LeaderCompactionSettings = settings;
    const observer = new RecordingEpisodeObserver();
    const monitor = new AgentLeaderCompactionMonitor({
      agentManager: fake,
      pushNotificationSender: { send: async () => undefined },
      serverId: "server-1",
      readDaemonConfig: () => ({ leaderCompaction: current }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => 0,
      episodeObserver: observer,
    });
    await sweep(monitor);
    expect(monitor.isEpisodeOpen("leader-1")).toBe(true);
    current = { ...settings, enabled: false };
    await sweep(monitor);
    expect(monitor.isEpisodeOpen("leader-1")).toBe(false);
    expect(observer.abandoned).toHaveLength(1);
  });

  test("the ledger hears how many deferrals an episode took and how long they added up to", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader({ contextWindowUsedTokens: 450_000 })];
    fake.outcomes = [
      { status: "completed", finalText: "DEFER 7: build" },
      { status: "completed", finalText: "GOAL: ship." },
    ];
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, settings, undefined, () => nowMs, observer);

    await sweep(monitor);
    nowMs = 7 * 60_000;
    await sweep(monitor);

    expect(observer.finished.map((call) => call.deferral)).toEqual([
      { count: 1, totalMs: 7 * 60_000 },
      { count: 1, totalMs: 7 * 60_000 },
    ]);
    // The second prepare re-asks the first: the ledger must not open a second episode for it.
    expect(observer.started.map((call) => call.reask)).toEqual([false, true]);
  });

  test("an episode with no deferral reports none", async () => {
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [{ status: "completed", finalText: "GOAL: ship." }];
    const observer = new RecordingEpisodeObserver();
    const { monitor } = createMonitor(fake, settings, undefined, undefined, observer);
    await sweep(monitor);
    expect(observer.finished[0]?.deferral).toBeNull();
  });
});

describe("AgentLeaderCompactionMonitor bound on the wait for prepare", () => {
  const settings: LeaderCompactionSettings = {
    enabled: true,
    prepareAtTokens: 400_000,
    prepareTimeoutMinutes: 30,
    retryAfterMinutes: 30,
    maxAttempts: 3,
  };

  test("a prepare turn that outlives the bound is left running, and the monitor stops waiting for it", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.holdNextTurn = true;
    const observer = new RecordingEpisodeObserver();
    const { monitor, logs } = createMonitor(fake, settings, undefined, () => nowMs, observer);

    await monitor.tick();
    fake.agents = [leader({ lifecycle: "running", busy: true })];
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "inFlight", step: "prepare" });

    nowMs = 30 * 60_000 - 1;
    await monitor.tick();
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "inFlight", step: "prepare" });

    nowMs = 30 * 60_000;
    await monitor.tick();
    expect(monitor.getState("leader-1")).toMatchObject({
      phase: "backoff",
      step: "prepare",
      untilMs: 60 * 60_000,
    });
    expect(fake.sent).toHaveLength(1);
    expect(observer.finished[0]).toMatchObject({ step: "prepare", outcome: "failed" });
    expect(
      logs.find((log) => log.msg === "Leader compaction step did not take; will retry")?.obj,
    ).toMatchObject({ step: "prepare", reason: expect.stringContaining("still running") });
  });

  test("the turn's own outcome, when it finally comes, changes nothing", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.holdNextTurn = true;
    const { monitor } = createMonitor(fake, settings, undefined, () => nowMs);

    await monitor.tick();
    fake.agents = [leader({ lifecycle: "running", busy: true })];
    nowMs = 31 * 60_000;
    await monitor.tick();
    const before = monitor.getState("leader-1");

    fake.release({ status: "completed", finalText: "GOAL: a note nobody asked for any more" });
    await monitor.settle();

    expect(monitor.getState("leader-1")).toEqual(before);
    expect(fake.sent).toHaveLength(1);
  });

  test("after the backoff, a late-idle agent is asked for its note again", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.holdNextTurn = true;
    const { monitor } = createMonitor(fake, settings, undefined, () => nowMs);

    await monitor.tick();
    fake.agents = [leader({ lifecycle: "running", busy: true })];
    nowMs = 31 * 60_000;
    await monitor.tick();
    fake.release({ status: "completed", finalText: "stale" });
    await monitor.settle();

    fake.agents = [leader()];
    nowMs = 61 * 60_000 + 1;
    await sweep(monitor);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.prompt).toContain("step 1 of 3");
  });

  test("prepareTimeoutMinutes 0 waits as long as the turn takes", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.holdNextTurn = true;
    const { monitor } = createMonitor(
      fake,
      { ...settings, prepareTimeoutMinutes: 0 },
      undefined,
      () => nowMs,
    );

    await monitor.tick();
    nowMs = 5 * 24 * 60 * 60_000;
    await monitor.tick();
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "inFlight", step: "prepare" });
  });

  test("only prepare is bounded: a compact turn is left to finish", async () => {
    let nowMs = 0;
    const fake = new FakeAgents();
    fake.agents = [leader()];
    fake.outcomes = [{ status: "completed", finalText: "GOAL: x" }];
    const { monitor } = createMonitor(fake, settings, undefined, () => nowMs);
    await sweep(monitor);
    fake.holdNextTurn = true;
    await monitor.tick();
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "inFlight", step: "compact" });
    nowMs = 10 * 60 * 60_000;
    await monitor.tick();
    expect(monitor.getState("leader-1")).toMatchObject({ phase: "inFlight", step: "compact" });
  });
});
