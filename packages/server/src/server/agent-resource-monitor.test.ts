import { describe, expect, test, vi } from "vitest";
import type { ResourceAlert } from "@getpaseo/protocol/agent-types";
import type { AgentManager, ResourceMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentResourceMonitorState } from "./agent/resource-monitor-detector.js";
import type { ProcessSampleRow, SystemMemorySample } from "./agent/process-sampler.js";
import { AgentResourceMonitor, type ResourceMonitorConfig } from "./agent-resource-monitor.js";
import type { PushPayload } from "./push/push-service.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createFakeAgentManager(agents: ResourceMonitorAgentSummary[]) {
  const states = new Map<string, AgentResourceMonitorState>();
  const alerts = new Map<string, ResourceAlert>();
  return {
    listAgentsForResourceMonitor: vi.fn(() => agents),
    getResourceMonitorState: vi.fn((id: string) => states.get(id)),
    setResourceMonitorState: vi.fn((id: string, state: AgentResourceMonitorState) => {
      states.set(id, state);
    }),
    setResourceAlert: vi.fn((id: string, alert: ResourceAlert) => {
      alerts.set(id, alert);
    }),
    clearResourceAlert: vi.fn((id: string) => {
      alerts.delete(id);
    }),
    __alerts: alerts,
  } as unknown as AgentManager & { __alerts: Map<string, ResourceAlert> };
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

function createFakeSampler(
  overrides: {
    processRows?: ProcessSampleRow[];
    systemMemory?: SystemMemorySample;
  } = {},
) {
  return {
    sampleProcesses: vi.fn(async () => overrides.processRows ?? []),
    sampleSystemMemory: vi.fn(async () => overrides.systemMemory),
  };
}

function createFakeSteer() {
  const calls: Array<{ agentId: string; body: string }> = [];
  return {
    fn: vi.fn(async (agentId: string, body: string) => void calls.push({ agentId, body })),
    calls,
  };
}

function summary(overrides: Partial<ResourceMonitorAgentSummary>): ResourceMonitorAgentSummary {
  return { id: "agent-1", workspaceId: "workspace-1", internal: false, ...overrides };
}

function row(
  overrides: Partial<ProcessSampleRow> & Pick<ProcessSampleRow, "pid">,
): ProcessSampleRow {
  return {
    ppid: 1,
    rssKb: 1000,
    cpuPercent: 0,
    etime: "00:01",
    command: "some-process",
    ...overrides,
  };
}

function agentProcessRow(agentId: string, rssKb: number, cpuPercent: number): ProcessSampleRow {
  return row({ pid: 200, rssKb, cpuPercent, command: `claude ...callerAgentId=${agentId}` });
}

const SUSTAINED_ONE: ResourceMonitorConfig = { sustainedMinutes: 1 };

function createMonitor(params: {
  agents?: ResourceMonitorAgentSummary[];
  processRows?: ProcessSampleRow[];
  systemMemory?: SystemMemorySample;
  config?: ResourceMonitorConfig;
  titles?: Record<string, string>;
}) {
  const agentManager = createFakeAgentManager(params.agents ?? [summary({})]);
  const push = createFakePushSender();
  const steer = createFakeSteer();
  const sampler = createFakeSampler({
    processRows: params.processRows,
    systemMemory: params.systemMemory,
  });
  const monitor = new AgentResourceMonitor({
    agentManager,
    agentStorage: createFakeAgentStorage(params.titles),
    pushNotificationSender: push.sender,
    serverId: "server-1",
    processSampler: sampler,
    sendSystemMessageToAgent: steer.fn,
    readDaemonConfig: () => ({ resourceMonitor: { ...SUSTAINED_ONE, ...params.config } }),
    logger: createLogger(),
  });
  return { monitor, agentManager, push, steer, sampler };
}

describe("AgentResourceMonitor", () => {
  test("disabled config is a no-op and never samples", async () => {
    const { monitor, sampler, push } = createMonitor({
      config: { enabled: false },
      processRows: [agentProcessRow("agent-1", 100_000_000, 0)],
    });

    await monitor.tick();

    expect(sampler.sampleProcesses).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("no agents is a no-op when nothing else breaches", async () => {
    const { monitor, agentManager, push } = createMonitor({
      agents: [],
      systemMemory: {
        totalPhysicalBytes: 1e12,
        swapTotalBytes: 10_000_000,
        swapUsedBytes: 100_000,
      },
    });

    await monitor.tick();
    await monitor.tick();

    expect(agentManager.setResourceAlert).not.toHaveBeenCalled();
    expect(push.sent).toHaveLength(0);
  });

  test("a sustained memory breach sets the alert and sends one push", async () => {
    const { monitor, agentManager, push } = createMonitor({
      processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
      titles: { "agent-1": "Walk & Talk orchestrator" },
    });

    await monitor.tick();

    expect(agentManager.setResourceAlert).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ trigger: "memory" }),
    );
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("resource_memory");
    expect(push.sent[0]?.body).toContain("Walk & Talk orchestrator");
  });

  test("a sustained CPU breach fires the cpu leg", async () => {
    const { monitor, push } = createMonitor({
      processRows: [agentProcessRow("agent-1", 1000, 500)],
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 400 },
    });

    await monitor.tick();

    expect(push.sent[0]?.data?.reason).toBe("resource_cpu");
  });

  test("tells the agent once per episode via the steer path, not on every sweep it stays breached", async () => {
    const { monitor, steer } = createMonitor({
      processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
    });

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(steer.calls).toHaveLength(1);
    expect(steer.calls[0]?.agentId).toBe("agent-1");
    expect(steer.calls[0]?.body).toContain("gradlew --stop");
  });

  test("notifyAgent: false sends the push but skips the steer message", async () => {
    const { monitor, push, steer } = createMonitor({
      processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
      config: {
        memoryBytesPerAgent: 6 * 1024 ** 3,
        cpuPercentPerAgent: 10_000,
        notifyAgent: false,
      },
    });

    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(steer.fn).not.toHaveBeenCalled();
  });

  test("more breaches than the batch threshold send one combined push, but still message every agent", async () => {
    const agents = ["agent-1", "agent-2", "agent-3", "agent-4"].map((id) => summary({ id }));
    const rows = agents.map((agent, index) =>
      row({
        pid: 200 + index,
        rssKb: 7 * 1024 * 1024,
        cpuPercent: 0,
        command: `claude ...callerAgentId=${agent.id}`,
      }),
    );
    const { monitor, agentManager, push, steer } = createMonitor({
      agents,
      processRows: rows,
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
    });

    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("resource_multi");
    expect(push.sent[0]?.data?.agentIds).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
    expect(agentManager.setResourceAlert).toHaveBeenCalledTimes(4);
    expect(steer.calls).toHaveLength(4);
  });

  test("re-arming clears a previously set resource alert", async () => {
    const { monitor, agentManager, sampler } = createMonitor({
      processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
    });

    await monitor.tick();
    expect(agentManager.setResourceAlert).toHaveBeenCalledTimes(1);

    // The agent's process tree is gone this sweep — treated the same as a below-threshold
    // reading (sustained-breach-detector.ts), so a single sweep re-arms since sustainedMinutes
    // is 1 in this fixture.
    sampler.sampleProcesses.mockResolvedValue([]);
    await monitor.tick();

    expect(agentManager.clearResourceAlert).toHaveBeenCalledWith("agent-1");
  });

  test("internal agents are never in scope", async () => {
    const { monitor, agentManager } = createMonitor({
      agents: [summary({ internal: true })],
      processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
    });

    await monitor.tick();

    expect(agentManager.setResourceAlert).not.toHaveBeenCalled();
  });

  test("a sustained system-memory (swap) breach pushes without setting any agent alert", async () => {
    const { monitor, push, agentManager } = createMonitor({
      agents: [],
      systemMemory: {
        totalPhysicalBytes: 1e12,
        swapTotalBytes: 10_000_000,
        swapUsedBytes: 9_500_000,
      },
      config: { systemSwapUsedRatio: 0.9 },
    });

    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("resource_system_memory");
    expect(agentManager.setResourceAlert).not.toHaveBeenCalled();
  });

  test("orphan build daemons push once, naming the gradlew fix, with no agent message", async () => {
    const { monitor, push, steer } = createMonitor({
      agents: [],
      processRows: [
        row({ pid: 500, ppid: 1, rssKb: 2 * 1024 * 1024, command: "java ...GradleDaemon" }),
      ],
      config: { orphanBuildDaemonBytes: 1024 ** 3 },
    });

    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("resource_orphan_daemons");
    expect(push.sent[0]?.body).toContain("./gradlew --stop");
    expect(steer.fn).not.toHaveBeenCalled();
  });
});
