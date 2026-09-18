import { describe, expect, test, vi } from "vitest";
import type { ResourceAlert } from "@getpaseo/protocol/agent-types";
import type { AgentManager, ResourceMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentResourceMonitorState } from "./agent/resource-monitor-detector.js";
import type { ProcessSignalOutcome, ProcessSignaller } from "./agent/build-daemon-reaper.js";
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

const OWNER_UID = 501;

/**
 * Records signals instead of sending them, and models liveness so the SIGTERM/grace/SIGKILL
 * sequence can be driven end to end without a real pid ever being touched. `survivesSigterm`
 * pids ignore the polite signal, the way a wedged daemon would.
 */
function createFakeSignaller(
  options: { survivesSigterm?: readonly number[]; notPermitted?: readonly number[] } = {},
) {
  const sent: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
  const dead = new Set<number>();
  const signaller: ProcessSignaller = {
    signal(pid, signal): ProcessSignalOutcome {
      if (options.notPermitted?.includes(pid)) return "not-permitted";
      sent.push({ pid, signal });
      if (signal === "SIGKILL" || !options.survivesSigterm?.includes(pid)) dead.add(pid);
      return "sent";
    },
    isRunning(pid) {
      return !dead.has(pid);
    },
  };
  return { signaller, sent };
}

function gradleDaemonRow(overrides: Partial<ProcessSampleRow> = {}): ProcessSampleRow {
  return row({
    pid: 28056,
    ppid: 1,
    uid: OWNER_UID,
    rssKb: 3_369_792,
    cpuPercent: 0,
    command:
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java -Xmx6g " +
      "-cp /Users/t/.gradle/lib/gradle-daemon-main-9.7.1.jar " +
      "org.gradle.launcher.daemon.bootstrap.GradleDaemon 9.7.1",
    ...overrides,
  });
}

function summary(overrides: Partial<ResourceMonitorAgentSummary>): ResourceMonitorAgentSummary {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    internal: false,
    isRunning: true,
    ...overrides,
  };
}

function row(
  overrides: Partial<ProcessSampleRow> & Pick<ProcessSampleRow, "pid">,
): ProcessSampleRow {
  return {
    ppid: 1,
    uid: 501,
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
  now?: () => number;
  sampler?: ReturnType<typeof createFakeSampler>;
  signaller?: ProcessSignaller;
  ownerUid?: number | undefined;
}) {
  const agentManager = createFakeAgentManager(params.agents ?? [summary({})]);
  const push = createFakePushSender();
  const steer = createFakeSteer();
  const sampler =
    params.sampler ??
    createFakeSampler({
      processRows: params.processRows,
      systemMemory: params.systemMemory,
    });
  const logger = createLogger();
  const monitor = new AgentResourceMonitor({
    agentManager,
    agentStorage: createFakeAgentStorage(params.titles),
    pushNotificationSender: push.sender,
    serverId: "server-1",
    processSampler: sampler,
    sendSystemMessageToAgent: steer.fn,
    readDaemonConfig: () => ({ resourceMonitor: { ...SUSTAINED_ONE, ...params.config } }),
    logger,
    ownerUid: "ownerUid" in params ? params.ownerUid : OWNER_UID,
    sleep: async () => {},
    ...(params.signaller ? { processSignaller: params.signaller } : {}),
    ...(params.now ? { now: params.now } : {}),
  });
  return { monitor, agentManager, push, steer, sampler, logger };
}

/** Drives `count` consecutive 60s sweeps, the way the real unref'd timer would. */
async function sweep(monitor: AgentResourceMonitor, count: number, clock: { ms: number }) {
  for (let index = 0; index < count; index += 1) {
    await monitor.tick();
    clock.ms += 60_000;
  }
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

  test("an idle agent gets the push and the alert but is never steered — that would start a turn", async () => {
    const { monitor, push, steer, agentManager } = createMonitor({
      agents: [summary({ isRunning: false })],
      processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
    });

    await monitor.tick();

    expect(push.sent).toHaveLength(1);
    expect(agentManager.setResourceAlert).toHaveBeenCalledTimes(1);
    expect(steer.calls).toHaveLength(0);
  });

  test("a sweep still in flight is not overlapped by the next tick", async () => {
    let release: (() => void) | undefined;
    const sampler = createFakeSampler();
    sampler.sampleProcesses.mockImplementation(
      () =>
        new Promise<ProcessSampleRow[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const { monitor } = createMonitor({ sampler });

    const first = monitor.tick();
    await monitor.tick(); // returns immediately: the first sweep still owns the sampler
    expect(sampler.sampleProcesses).toHaveBeenCalledTimes(1);

    release?.();
    await first;
    // Once the first sweep has finished, the next tick samples again.
    sampler.sampleProcesses.mockImplementation(async () => []);
    await monitor.tick();
    expect(sampler.sampleProcesses).toHaveBeenCalledTimes(2);
  });

  test("the CPU leg measures the rate between sweeps, not ps's lifetime average", async () => {
    let nowMs = 0;
    // ps says 1% (a long-lived process that was quiet for hours) while cputime jumps by 300s
    // per 60s sweep — five cores right now.
    const samples = [
      [
        row({
          pid: 200,
          cpuPercent: 1,
          cpuSeconds: 1000,
          etime: "5:00:00",
          command: "claude callerAgentId=agent-1",
        }),
      ],
      [
        row({
          pid: 200,
          cpuPercent: 1,
          cpuSeconds: 1300,
          etime: "5:01:00",
          command: "claude callerAgentId=agent-1",
        }),
      ],
    ];
    const sampler = createFakeSampler();
    sampler.sampleProcesses.mockImplementation(async () => samples.shift() ?? []);
    const { monitor, push } = createMonitor({
      sampler,
      config: { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 400 },
      now: () => nowMs,
    });

    await monitor.tick();
    expect(push.sent).toHaveLength(0);

    nowMs += 60_000;
    await monitor.tick();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.data?.reason).toBe("resource_cpu");
    expect(push.sent[0]?.body).toContain("500%");
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

describe("AgentResourceMonitor reaper", () => {
  const REAP_ON = { reaper: { enabled: true } } as const;

  function reapPushes(sent: readonly PushPayload[]) {
    return sent.filter((payload) => payload.data?.reason === "resource_daemons_reaped");
  }

  test("is off by default: a long-abandoned daemon is reported, never signalled", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor, push } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow()],
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 30, clock);

    expect(sent).toEqual([]);
    expect(reapPushes(push.sent)).toHaveLength(0);
    // The alert Tyler already gets still fires — reaping replaces nothing until it's enabled.
    expect(push.sent.some((payload) => payload.data?.reason === "resource_orphan_daemons")).toBe(
      true,
    );
  });

  test("dry run reports exactly what it would kill and signals nothing", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor, push } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow()],
      config: { reaper: { enabled: true, dryRun: true } },
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 20, clock);

    expect(sent).toEqual([]);
    const [first] = reapPushes(push.sent);
    // Reported once, not once per sweep for as long as the daemon sits there.
    expect(reapPushes(push.sent)).toHaveLength(1);
    expect(first?.title).toBe("Orphaned build daemons would be reaped");
    expect(first?.body).toBe(
      "Would reap 1 orphaned build daemon holding 3.2 GB: Gradle daemon pid 28056 (3.2 GB, " +
        "idle 15m). Dry run — nothing was killed.",
    );
    expect(first?.data?.dryRun).toBe(true);
  });

  test("SIGTERMs an abandoned daemon and reports the pid, size and idle time it reclaimed", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor, push, logger } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow()],
      config: REAP_ON,
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 20, clock);

    expect(sent).toEqual([{ pid: 28056, signal: "SIGTERM" }]);
    const [first] = reapPushes(push.sent);
    expect(reapPushes(push.sent)).toHaveLength(1);
    expect(first?.title).toBe("Reclaimed memory from orphaned build daemons");
    expect(first?.body).toContain("Reaped 1 orphaned build daemon holding 3.2 GB");
    expect(first?.body).toContain("Gradle daemon pid 28056 (3.2 GB, idle 15m)");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 28056, kind: "gradle", escalated: false }),
      "Reaped orphaned build daemon",
    );
  });

  test("escalates to SIGKILL only for a daemon that ignored SIGTERM", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller({ survivesSigterm: [28056] });
    const { monitor } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow()],
      config: REAP_ON,
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 20, clock);

    expect(sent).toEqual([
      { pid: 28056, signal: "SIGTERM" },
      { pid: 28056, signal: "SIGKILL" },
    ]);
  });

  test("a daemon in the middle of a build is never signalled, however long the sweep runs", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor, push } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow({ cpuPercent: 140 })],
      config: REAP_ON,
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 60, clock);

    expect(sent).toEqual([]);
    expect(reapPushes(push.sent)).toHaveLength(0);
  });

  test("a daemon inside a live agent's process tree is never signalled", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor, push } = createMonitor({
      agents: [summary({})],
      // The daemon is a child of the agent's own process, so attribution owns it.
      processRows: [
        agentProcessRow("agent-1", 1000, 0),
        gradleDaemonRow({ ppid: 200, rssKb: 3_000_000 }),
      ],
      config: { ...REAP_ON, memoryBytesPerAgent: 100 * 1024 ** 3, cpuPercentPerAgent: 10_000 },
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 30, clock);

    expect(sent).toEqual([]);
    expect(reapPushes(push.sent)).toHaveLength(0);
  });

  test("a daemon owned by another user is never signalled", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow({ uid: 502 })],
      config: REAP_ON,
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 30, clock);

    expect(sent).toEqual([]);
  });

  test("a daemon that refuses the signal is warned about once and then left alone", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller({ notPermitted: [28056] });
    const { monitor, push, logger } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow()],
      config: REAP_ON,
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 40, clock);

    expect(sent).toEqual([]);
    expect(reapPushes(push.sent)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("turning the reaper off discards the idle evidence it had gathered", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    let reaper: { enabled: boolean } = { enabled: true };
    const monitor = new AgentResourceMonitor({
      agentManager: createFakeAgentManager([]),
      agentStorage: createFakeAgentStorage(),
      pushNotificationSender: createFakePushSender().sender,
      serverId: "server-1",
      processSampler: createFakeSampler({ processRows: [gradleDaemonRow()] }),
      sendSystemMessageToAgent: createFakeSteer().fn,
      readDaemonConfig: () => ({ resourceMonitor: { ...SUSTAINED_ONE, reaper } }),
      logger: createLogger(),
      processSignaller: signaller,
      ownerUid: OWNER_UID,
      sleep: async () => {},
      now: () => clock.ms,
    });

    await sweep(monitor, 14, clock);
    expect(sent).toEqual([]);

    reaper = { enabled: false };
    await sweep(monitor, 2, clock);

    // Back on, the fifteen minutes start over rather than resuming where they left off.
    reaper = { enabled: true };
    await sweep(monitor, 4, clock);
    expect(sent).toEqual([]);

    await sweep(monitor, 14, clock);
    expect(sent).toEqual([{ pid: 28056, signal: "SIGTERM" }]);
  });

  test("never signals more than maxPerSweep daemons in one sweep", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor } = createMonitor({
      agents: [],
      processRows: [
        gradleDaemonRow({ pid: 101, rssKb: 400_000 }),
        gradleDaemonRow({ pid: 102, rssKb: 2_600_000 }),
        gradleDaemonRow({ pid: 103, rssKb: 1_100_000 }),
      ],
      config: REAP_ON,
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 17, clock);

    // Largest first, and the third is still there — the cap is what held it back, not absence.
    expect(sent).toEqual([
      { pid: 102, signal: "SIGTERM" },
      { pid: 103, signal: "SIGTERM" },
    ]);

    await sweep(monitor, 1, clock);
    expect(sent).toEqual([
      { pid: 102, signal: "SIGTERM" },
      { pid: 103, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
    ]);
  });
});
