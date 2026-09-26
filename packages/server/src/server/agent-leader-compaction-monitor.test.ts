import { describe, expect, test } from "vitest";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import type { IdleTurnOutcome, LeaderCompactionAgentSummary } from "./agent/agent-manager.js";
import { AgentLeaderCompactionMonitor } from "./agent-leader-compaction-monitor.js";
import type { LeaderCompactionSettings } from "./agent/leader-compaction-planner.js";

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

function createMonitor(fake: FakeAgents, settings: LeaderCompactionSettings) {
  const pushes: Array<{ title: string; body: string }> = [];
  const logs: Array<{ msg: string; obj: object }> = [];
  const logger = {
    info: (obj: object, msg?: string) => logs.push({ obj, msg: msg ?? "" }),
    warn: (obj: object, msg?: string) => logs.push({ obj, msg: msg ?? "" }),
    error: (obj: object, msg?: string) => logs.push({ obj, msg: msg ?? "" }),
  };
  const monitor = new AgentLeaderCompactionMonitor({
    agentManager: fake,
    pushNotificationSender: {
      send: async (payload) => {
        pushes.push(payload);
      },
    },
    serverId: "server-1",
    readDaemonConfig: () => ({ leaderCompaction: settings }),
    logger,
    now: () => 0,
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
    expect(monitor.getState("leader-1")).toEqual({ phase: "settled", reason: "gaveUp" });
  });
});
