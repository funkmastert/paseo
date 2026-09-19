import { describe, expect, test, vi } from "vitest";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { TokenBurnMonitorState } from "./agent/token-burn-detector.js";
import { SPEND_BUDGET_LABEL, type SpendGovernorState } from "./agent/spend-governor.js";
import { AgentTokenBurnMonitor, type TokenBurnMonitorConfig } from "./agent-token-burn-monitor.js";
import type { PushPayload } from "./push/push-service.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createFakeAgentManager(agents: TokenBurnMonitorAgentSummary[]) {
  const states = new Map<string, TokenBurnMonitorState>();
  const alerts = new Map<string, unknown>();
  const governorStates = new Map<string, SpendGovernorState>();
  return {
    listAgentsForTokenBurnMonitor: vi.fn(() => agents),
    getTokenBurnMonitorState: vi.fn((id: string) => states.get(id)),
    setTokenBurnMonitorState: vi.fn((id: string, state: TokenBurnMonitorState) => {
      states.set(id, state);
    }),
    setTokenBurnAlert: vi.fn((id: string, alert: unknown) => {
      alerts.set(id, alert);
    }),
    clearTokenBurnAlert: vi.fn((id: string) => {
      alerts.delete(id);
    }),
    getSpendGovernorState: vi.fn((id: string) => governorStates.get(id)),
    setSpendGovernorState: vi.fn((id: string, state: SpendGovernorState | undefined) => {
      if (state === undefined) governorStates.delete(id);
      else governorStates.set(id, state);
    }),
    setAgentModel: vi.fn(async () => {}),
    cancelAgentRun: vi.fn(async () => ({ status: "settled" as const })),
    __alerts: alerts,
    __governorStates: governorStates,
  } as unknown as AgentManager & {
    __alerts: Map<string, unknown>;
    __governorStates: Map<string, SpendGovernorState>;
  };
}

function createFakeSteer() {
  const calls: Array<{ agentId: string; body: string }> = [];
  return {
    fn: vi.fn(async (agentId: string, body: string) => void calls.push({ agentId, body })),
    calls,
  };
}

function createFakeAgentStorage(titles: Record<string, string> = {}) {
  return {
    get: vi.fn(async (id: string) =>
      titles[id] ? ({ title: titles[id] } as StoredAgentRecord) : null,
    ),
  } as Pick<AgentStorage, "get">;
}

function createFakePushSender() {
  const sent: PushPayload[] = [];
  return {
    sender: { send: vi.fn(async (payload: PushPayload) => void sent.push(payload)) },
    sent,
  };
}

function summary(overrides: Partial<TokenBurnMonitorAgentSummary>): TokenBurnMonitorAgentSummary {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    internal: false,
    isDelegated: false,
    isRunning: true,
    tokenRate: undefined,
    totalTokens: undefined,
    labels: {},
    model: "claude-opus-5",
    ...overrides,
  };
}

const HIGH_RATE_CONFIG: TokenBurnMonitorConfig = {
  ratePerMinute: 50_000,
  sustainedMinutes: 1,
};

describe("AgentTokenBurnMonitor", () => {
  test("disabled config is a no-op", async () => {
    const agentManager = createFakeAgentManager([summary({ tokenRate: 999_999 })]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: { enabled: false, ...HIGH_RATE_CONFIG } }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.listAgentsForTokenBurnMonitor).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("no agents is a no-op", async () => {
    const agentManager = createFakeAgentManager([]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: HIGH_RATE_CONFIG }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("a single breach sets the badge and sends one push", async () => {
    const agentManager = createFakeAgentManager([summary({ id: "agent-1", tokenRate: 60_000 })]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage({ "agent-1": "Refactor the parser" }),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: HIGH_RATE_CONFIG }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ trigger: "rate" }),
    );
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("token_burn_rate");
    expect(push.sent[0]?.data?.agentId).toBe("agent-1");
  });

  test("an idle agent's lingering trailing-window rate never breaches the rate leg", async () => {
    // A heavy turn holds the 5-minute average high long after the agent went idle; that is not
    // burning. Only running agents are evaluated on the rate leg.
    const agentManager = createFakeAgentManager([
      summary({ id: "agent-1", tokenRate: 999_999, isRunning: false }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: HIGH_RATE_CONFIG }),
      logger: createLogger(),
    });

    await monitor.tick();
    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("a running agent over a configured total breaches, and says what it spent", async () => {
    const agentManager = createFakeAgentManager([
      summary({ id: "agent-1", totalTokens: 6_000, isRunning: true }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: { totalTokens: 5_000 } }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ trigger: "total" }),
    );
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("token_burn_total");
    expect(push.sent[0]?.title).toBe("Agent has used a lot of tokens");
  });

  test("an idle agent never breaches the total leg: its spend is already spent", async () => {
    const agentManager = createFakeAgentManager([
      summary({ id: "agent-1", totalTokens: 6_000, isRunning: false }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: { totalTokens: 5_000 } }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("the total leg is off unless a threshold is configured", async () => {
    // Four of Tyler's agents held a `total` alert at once on the old flat 5M default, all of
    // them idle and all doing legitimate work. A global total cannot tell those from a runaway.
    const agentManager = createFakeAgentManager([
      summary({ id: "agent-1", totalTokens: 9_100_000, isRunning: true }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: {} }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("internal agents are never in scope", async () => {
    const agentManager = createFakeAgentManager([
      summary({ id: "agent-1", tokenRate: 60_000, internal: true }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: HIGH_RATE_CONFIG }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).not.toHaveBeenCalled();
  });

  test("scope: topLevelOnly excludes delegated children", async () => {
    const agentManager = createFakeAgentManager([
      summary({ id: "child-1", tokenRate: 60_000, isDelegated: true }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({
        tokenBurnMonitor: { ...HIGH_RATE_CONFIG, scope: "topLevelOnly" },
      }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).not.toHaveBeenCalled();
  });

  test("scope defaults to all, including delegated children", async () => {
    const agentManager = createFakeAgentManager([
      summary({ id: "child-1", tokenRate: 60_000, isDelegated: true }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: HIGH_RATE_CONFIG }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.setTokenBurnAlert).toHaveBeenCalledWith("child-1", expect.anything());
  });

  test("more breaches than breachBatchThreshold send one combined push instead of one per agent", async () => {
    const agents = ["agent-1", "agent-2", "agent-3", "agent-4"].map((id) =>
      summary({ id, tokenRate: 60_000 }),
    );
    const agentManager = createFakeAgentManager(agents);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({
        tokenBurnMonitor: { ...HIGH_RATE_CONFIG, breachBatchThreshold: 3 },
      }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("token_burn_multi");
    expect(push.sent[0]?.data?.agentIds).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
    // Badges are still set per-agent even though the push is batched.
    expect(agentManager.setTokenBurnAlert).toHaveBeenCalledTimes(4);
  });

  test("re-arming the rate leg clears a previously set rate alert", async () => {
    const agentManager = createFakeAgentManager([summary({ id: "agent-1", tokenRate: 60_000 })]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({ tokenBurnMonitor: HIGH_RATE_CONFIG }),
      logger: createLogger(),
    });

    await monitor.tick();
    expect(agentManager.setTokenBurnAlert).toHaveBeenCalledTimes(1);

    // Below threshold for sustainedMinutes=1 sweep re-arms immediately.
    agentManager.listAgentsForTokenBurnMonitor = vi.fn(() => [
      summary({ id: "agent-1", tokenRate: 1_000 }),
    ]);
    await monitor.tick();

    expect(agentManager.clearTokenBurnAlert).toHaveBeenCalledWith("agent-1");
  });
});

const GOVERNED: TokenBurnMonitorConfig = {
  // High enough that the rate/total legs stay silent: these tests are about the governor.
  ratePerMinute: 10_000_000,
  totalTokens: 10_000_000_000,
  governor: {
    enabled: true,
    downgradeToModel: "claude-sonnet-5",
    downgrade: { enabled: true },
    stopFanOut: { enabled: true },
    pause: { enabled: true },
  },
};

function createGovernedMonitor(input: {
  agents: TokenBurnMonitorAgentSummary[];
  config?: TokenBurnMonitorConfig;
  titles?: Record<string, string>;
}) {
  const agentManager = createFakeAgentManager(input.agents);
  const push = createFakePushSender();
  const steer = createFakeSteer();
  const monitor = new AgentTokenBurnMonitor({
    agentManager,
    agentStorage: createFakeAgentStorage(input.titles ?? {}),
    pushNotificationSender: push.sender,
    serverId: "server-1",
    sendSystemMessageToAgent: steer.fn,
    readDaemonConfig: () => ({ tokenBurnMonitor: input.config ?? GOVERNED }),
    logger: createLogger(),
  });
  return { agentManager, push, steer, monitor };
}

function budgeted(overrides: Partial<TokenBurnMonitorAgentSummary>) {
  return summary({ labels: { "paseo.budget": "1M" }, ...overrides });
}

describe("AgentTokenBurnMonitor spend governor", () => {
  test("a healthy busy agent inside its budget is never throttled", async () => {
    // The agent this feature must never touch: spending fast (twice the measured healthy peak
    // rate) and 70% of the way through a budget its caller sized for the task. No model
    // change, no cancellation, no fan-out block, and nothing steered into its conversation.
    const { agentManager, push, steer } = await (async () => {
      const harness = createGovernedMonitor({
        agents: [budgeted({ id: "agent-1", tokenRate: 400_000, totalTokens: 700_000 })],
      });
      await harness.monitor.tick();
      await harness.monitor.tick();
      return harness;
    })();

    expect(agentManager.setAgentModel).not.toHaveBeenCalled();
    expect(agentManager.cancelAgentRun).not.toHaveBeenCalled();
    expect(steer.calls).toEqual([]);
    expect(push.sent).toHaveLength(0);
    expect(agentManager.__governorStates.get("agent-1")?.fanOutBlocked).toBe(false);
  });

  test("the governor is inert until it is turned on", async () => {
    const { agentManager, push } = await (async () => {
      const harness = createGovernedMonitor({
        agents: [budgeted({ id: "agent-1", totalTokens: 9_000_000 })],
        config: { ...GOVERNED, governor: undefined },
      });
      await harness.monitor.tick();
      return harness;
    })();

    expect(agentManager.setAgentModel).not.toHaveBeenCalled();
    expect(agentManager.cancelAgentRun).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("crossing the notify threshold warns the human and tells the agent, once", async () => {
    const { push, steer, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 800_000 })],
      titles: { "agent-1": "Refactor the parser" },
    });

    await monitor.tick();
    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("token_burn_governor");
    expect(push.sent[0]?.data?.stage).toBe("notify");
    expect(push.sent[0]?.body).toContain("Refactor the parser");
    expect(steer.calls).toHaveLength(1);
    expect(steer.calls[0]?.agentId).toBe("agent-1");
    // The agent is told the number, the budget and what to do — not just that something is up.
    expect(steer.calls[0]?.body).toContain("800K of this task's 1.00M weighted-token budget");
    expect(steer.calls[0]?.body).toContain("wrapping up");
  });

  test("downgrade moves the model and says so, in that order", async () => {
    const { agentManager, steer, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 1_100_000 })],
    });

    await monitor.tick();

    expect(agentManager.setAgentModel).toHaveBeenCalledWith("agent-1", "claude-sonnet-5");
    const downgradeNotice = steer.calls.find((call) =>
      call.body.includes("model has been changed"),
    );
    expect(downgradeNotice?.body).toContain("claude-sonnet-5");
    // Named as a budget decision, not a fault, so the agent doesn't go looking for a bug.
    expect(downgradeNotice?.body).toContain("you did nothing wrong");
  });

  test("stopFanOut records the block the create_agent gate reads, and warns the agent first", async () => {
    const { agentManager, steer, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 1_100_000 })],
    });

    await monitor.tick();

    expect(agentManager.__governorStates.get("agent-1")?.fanOutBlocked).toBe(true);
    const cutOff = steer.calls.find((call) => call.body.includes("create_agent is now refused"));
    expect(cutOff?.body).toContain("budget cap, not a broken tool");
  });

  test("pause tells the agent why before ending its turn", async () => {
    const { agentManager, push, steer, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 2_000_000 })],
    });

    await monitor.tick();

    expect(agentManager.cancelAgentRun).toHaveBeenCalledWith("agent-1", "spend-governor");
    // Steering into an already-cancelled agent would start a fresh turn, so the notice has to
    // go in while the turn is still alive. Last steer before the cancel is the pause notice.
    const steerOrder = steer.calls.map((call) => call.body);
    expect(steerOrder.at(-1)).toContain("This turn is being ended");
    expect(steer.fn.mock.invocationCallOrder.at(-1)).toBeLessThan(
      agentManager.cancelAgentRun.mock.invocationCallOrder[0]!,
    );
    expect(push.sent.map((p) => p.data?.stage)).toContain("pause");
  });

  test("an idle agent is never steered, because steering one starts a fresh turn", async () => {
    // The trap the resource monitor already documents: `notify` and `stopFanOut` can fire on
    // an idle agent, and the steer path falls back to starting a turn for one — spending
    // tokens to tell an agent it is out of tokens. It still gets the push and the block.
    const { agentManager, push, steer, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 2_000_000, isRunning: false })],
    });

    await monitor.tick();

    expect(steer.calls).toEqual([]);
    expect(agentManager.__governorStates.get("agent-1")?.fanOutBlocked).toBe(true);
    expect(push.sent.map((p) => p.data?.stage)).toEqual(["notify", "stopFanOut"]);
    // Downgrade and pause wait for it to resume rather than being written off as handled.
    expect(agentManager.setAgentModel).not.toHaveBeenCalled();
    expect(agentManager.cancelAgentRun).not.toHaveBeenCalled();
  });

  test("a dry run reports the whole ladder and performs none of it", async () => {
    const { agentManager, push, steer, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 2_000_000 })],
      config: { ...GOVERNED, governor: { ...GOVERNED.governor, dryRun: true } },
    });

    await monitor.tick();

    expect(agentManager.setAgentModel).not.toHaveBeenCalled();
    expect(agentManager.cancelAgentRun).not.toHaveBeenCalled();
    // Not even the agent is disturbed: a hypothetical action must not spend its tokens.
    expect(steer.calls).toEqual([]);
    expect(agentManager.__governorStates.get("agent-1")?.fanOutBlocked).toBe(false);
    expect(push.sent.map((p) => p.data?.stage)).toEqual([
      "notify",
      "downgrade",
      "stopFanOut",
      "pause",
    ]);
    expect(push.sent.every((p) => p.data?.dryRun === true)).toBe(true);
    expect(push.sent[3]?.title).toBe("Dry run: agent paused: over budget");
  });

  test("an agent with no declared budget is left alone", async () => {
    const { agentManager, push, monitor } = createGovernedMonitor({
      agents: [summary({ id: "agent-1", labels: {}, totalTokens: 50_000_000 })],
    });

    await monitor.tick();

    expect(agentManager.cancelAgentRun).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("a failed action is logged and the rest of the ladder still runs", async () => {
    const { agentManager, push, monitor } = createGovernedMonitor({
      agents: [budgeted({ id: "agent-1", totalTokens: 2_000_000 })],
    });
    agentManager.setAgentModel = vi.fn(async () => {
      throw new Error("provider is wedged");
    });

    await monitor.tick();

    expect(agentManager.cancelAgentRun).toHaveBeenCalledWith("agent-1", "spend-governor");
    // The failed stage is not reported as something that happened.
    expect(push.sent.map((p) => p.data?.stage)).toEqual(["notify", "stopFanOut", "pause"]);
  });
});

describe("AgentTokenBurnMonitor account pressure", () => {
  function usage(usedPct: number, resetsAt: string | null = "2026-09-24T00:00:00.000Z") {
    return [
      {
        providerId: "claude",
        displayName: "Claude (leader)",
        status: "available" as const,
        planLabel: "Max",
        windows: [{ id: "weekly", label: "weekly limit", usedPct, resetsAt }],
      },
    ];
  }

  function createUsageMonitor(input: {
    usage: ReturnType<typeof usage> | null;
    enabled?: boolean;
  }) {
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager: createFakeAgentManager([]),
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readProviderUsage: async () => input.usage,
      readDaemonConfig: () => ({
        tokenBurnMonitor: { accountPressure: { enabled: input.enabled ?? true } },
      }),
      logger: createLogger(),
    });
    return { push, monitor };
  }

  test("warns once per cycle when a usage window is nearly exhausted", async () => {
    const { push, monitor } = createUsageMonitor({ usage: usage(94) });

    await monitor.tick();
    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("token_burn_account_pressure");
    expect(push.sent[0]?.body).toBe(
      "Claude (leader) is at 94% of weekly limit. Resets 2026-09-24T00:00:00.000Z.",
    );
  });

  test("a healthy window says nothing", async () => {
    const { push, monitor } = createUsageMonitor({ usage: usage(60) });
    await monitor.tick();
    expect(push.sent).toHaveLength(0);
  });

  test("the leg is off until it is turned on", async () => {
    const { push, monitor } = createUsageMonitor({ usage: usage(99), enabled: false });
    await monitor.tick();
    expect(push.sent).toHaveLength(0);
  });

  test("unreadable usage is not an error and not a warning", async () => {
    const { push, monitor } = createUsageMonitor({ usage: null });
    await monitor.tick();
    expect(push.sent).toHaveLength(0);
  });

  test("account pressure is reported with zero live agents", async () => {
    // The per-agent legs return early on an empty agent list; this one must not.
    const { push, monitor } = createUsageMonitor({ usage: usage(96) });
    await monitor.tick();
    expect(push.sent).toHaveLength(1);
  });
  // A paused agent that carries no alert is indistinguishable in the app from one that finished
  // its turn: `cancelReason` is log-only and the governor has no attentionReason of its own.
  // The push is then the only notice, and a missed push is a lost agent.
  test("a paused agent is flagged so a human can find it", async () => {
    const agentManager = createFakeAgentManager([
      summary({ labels: { [SPEND_BUDGET_LABEL]: "300k" }, totalTokens: 600_000 }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({
        tokenBurnMonitor: { governor: { enabled: true, pause: { enabled: true } } },
      }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.cancelAgentRun).toHaveBeenCalledWith("agent-1", "spend-governor");
    expect(agentManager.__alerts.get("agent-1")).toMatchObject({
      trigger: "total",
      budgetTokens: 300_000,
      spentTokens: 600_000,
      governorStage: "pause",
    });
  });

  test("a dry run flags nothing, because it paused nothing", async () => {
    const agentManager = createFakeAgentManager([
      summary({ labels: { [SPEND_BUDGET_LABEL]: "300k" }, totalTokens: 600_000 }),
    ]);
    const push = createFakePushSender();
    const monitor = new AgentTokenBurnMonitor({
      agentManager,
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: push.sender,
      serverId: "server-1",
      sendSystemMessageToAgent: async () => {},
      readDaemonConfig: () => ({
        tokenBurnMonitor: {
          governor: { enabled: true, dryRun: true, pause: { enabled: true } },
        },
      }),
      logger: createLogger(),
    });

    await monitor.tick();

    expect(agentManager.cancelAgentRun).not.toHaveBeenCalled();
    expect(agentManager.__alerts.get("agent-1")).toBeUndefined();
  });
});
