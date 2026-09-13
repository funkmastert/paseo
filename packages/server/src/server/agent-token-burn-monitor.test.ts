import { describe, expect, test, vi } from "vitest";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { TokenBurnMonitorState } from "./agent/token-burn-detector.js";
import { AgentTokenBurnMonitor, type TokenBurnMonitorConfig } from "./agent-token-burn-monitor.js";
import type { PushPayload } from "./push/push-service.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createFakeAgentManager(agents: TokenBurnMonitorAgentSummary[]) {
  const states = new Map<string, TokenBurnMonitorState>();
  const alerts = new Map<string, unknown>();
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
    __alerts: alerts,
  } as unknown as AgentManager & { __alerts: Map<string, unknown> };
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
    tokenRate: undefined,
    totalTokens: undefined,
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
