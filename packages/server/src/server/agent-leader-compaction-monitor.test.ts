import { describe, expect, test } from "vitest";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import type { IdleTurnOutcome, LeaderCompactionAgentSummary } from "./agent/agent-manager.js";
import { AgentLeaderCompactionMonitor } from "./agent-leader-compaction-monitor.js";
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
 * Stands in for AgentManager's two methods the monitor uses. Each started turn runs a scripted
 * outcome; `onTurn` lets a test change the agent (shrink its context, as a real /compact does).
 */
class FakeAgents {
  agents: LeaderCompactionAgentSummary[] = [];
  sent: SentTurn[] = [];
  outcomes: IdleTurnOutcome[] = [];
  onTurn: (turn: SentTurn) => void = () => undefined;

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
    ...overrides,
  } satisfies LeaderCompactionAgentSummary;
}

/** Stands in for the compaction-timing advisor: a scripted verdict, and what the monitor told it. */
class FakeTiming implements LeaderCompactionTimingPort {
  verdict: LeaderCompactionTimingVerdict | null = null;
  cutPoint: string | null = null;
  earlyStarts: string[] = [];
  cutPointRequests: string[] = [];

  verdictFor(): LeaderCompactionTimingVerdict | null {
    return this.verdict;
  }

  /** Like the advisor, an early start uses the verdict up. */
  noteEarlyStart(agentId: string): void {
    this.earlyStarts.push(agentId);
    this.verdict = null;
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

function createMonitor(fake: FakeAgents, settings: LeaderCompactionSettings, timing?: FakeTiming) {
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
    now: () => 0,
    timing,
  });
  return { monitor, pushes, logs };
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
    expect(timing.earlyStarts).toEqual(["leader-1"]);
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
    expect(timing.earlyStarts).toEqual(["leader-1"]);
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
  });
});
