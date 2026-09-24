import { describe, expect, test, vi } from "vitest";
import type { ResourceAlert } from "@getpaseo/protocol/agent-types";
import type { AgentManager, ResourceMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentResourceMonitorState } from "./agent/resource-monitor-detector.js";
import type { ProcessSignalOutcome, ProcessSignaller } from "./agent/build-daemon-reaper.js";
import type {
  ProcessSampleRow,
  ProcessTableSample,
  SystemMemorySample,
} from "./agent/process-sampler.js";
import type { SaturationLedgerRecord } from "./agent/saturation-ledger.js";
import type { SystemLoadReading, SystemLoadSample } from "./agent/system-load.js";
import {
  AgentResourceMonitor,
  type AgentResourceMonitorOptions,
  type ResourceMonitorConfig,
} from "./agent-resource-monitor.js";
import type { PushPayload } from "./push/push-service.js";
import type { PushSendMeta } from "./push/index.js";
import type { RemediationObservation, RemediationSink } from "./remediation/contract.js";

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
  const levels: Array<PushSendMeta["level"]> = [];
  return {
    sender: {
      send: vi.fn(async (payload: PushPayload, meta?: PushSendMeta) => {
        sent.push(payload);
        levels.push(meta?.level);
      }),
    },
    sent,
    levels,
  };
}

/** Records every observation, the way the ladder's own tests will see them. */
function createRecordingSink() {
  const observations: RemediationObservation[] = [];
  const sink: RemediationSink = {
    observe: async (observation) => {
      observations.push(observation);
    },
  };
  return {
    sink,
    observations,
    /** The observations for one key, oldest first. */
    forKey: (key: string) => observations.filter((observation) => observation.key === key),
    last: (key: string) => {
      const forKey = observations.filter((observation) => observation.key === key);
      return forKey[forKey.length - 1];
    },
  };
}

function createFakeSampler(
  overrides: {
    processRows?: ProcessSampleRow[];
    systemMemory?: SystemMemorySample;
    load?: SystemLoadReading;
  } = {},
) {
  const sampleProcesses = vi.fn(
    async (): Promise<ProcessSampleRow[]> => overrides.processRows ?? [],
  );
  return {
    sampleProcesses,
    sampleSystemMemory: vi.fn(async () => overrides.systemMemory),
    // Delegates, so a test that scripts sampleProcesses scripts the table the monitor reads too.
    sampleProcessTable: vi.fn(
      async (): Promise<ProcessTableSample> => ({ status: "ok", rows: await sampleProcesses() }),
    ),
    sampleSystemLoad: vi.fn(
      (): SystemLoadSample => ({
        load: overrides.load ?? { kind: "loadavg", cores: 16, load1: 4, load5: 4, load15: 4 },
        freeMemoryBytes: 8 * 1024 ** 3,
        totalMemoryBytes: 64 * 1024 ** 3,
      }),
    ),
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
  sweepTestArtifacts?: AgentResourceMonitorOptions["sweepTestArtifacts"];
  reportDeviceSample?: AgentResourceMonitorOptions["reportDeviceSample"];
  saturationLedger?: AgentResourceMonitorOptions["saturationLedger"];
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
  const remediation = createRecordingSink();
  const monitor = new AgentResourceMonitor({
    agentManager,
    agentStorage: createFakeAgentStorage(params.titles),
    pushNotificationSender: push.sender,
    remediationSink: remediation.sink,
    ...(params.sweepTestArtifacts ? { sweepTestArtifacts: params.sweepTestArtifacts } : {}),
    ...(params.reportDeviceSample ? { reportDeviceSample: params.reportDeviceSample } : {}),
    ...(params.saturationLedger ? { saturationLedger: params.saturationLedger } : {}),
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
  return { monitor, agentManager, push, steer, sampler, logger, remediation };
}

/** Drives `count` consecutive 60s sweeps, the way the real unref'd timer would. */
async function sweep(monitor: AgentResourceMonitor, count: number, clock: { ms: number }) {
  for (let index = 0; index < count; index += 1) {
    await monitor.tick();
    clock.ms += 60_000;
  }
}

function isSkippedAttempt(attempt: { outcome: string }): boolean {
  return attempt.outcome === "skipped";
}

function observationIsActive(observation: { active: boolean }): boolean {
  return observation.active;
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

  describe("per-agent breaches", () => {
    const BREACH_CONFIG = { memoryBytesPerAgent: 6 * 1024 ** 3, cpuPercentPerAgent: 10_000 };

    test("a running agent that was steered is recorded, not pushed", async () => {
      const { monitor, push, steer } = createMonitor({
        processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
        config: BREACH_CONFIG,
      });

      await monitor.tick();

      expect(steer.calls).toHaveLength(1);
      expect(push.sent).toHaveLength(1);
      expect(push.levels).toEqual(["record"]);
    });

    test("an idle agent cannot be steered, so its breach stays a notice", async () => {
      const { monitor, push } = createMonitor({
        agents: [summary({ isRunning: false })],
        processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
        config: BREACH_CONFIG,
      });

      await monitor.tick();

      expect(push.levels).toEqual(["notice"]);
    });

    test("notifyAgent off means no remedy was applied, so the breach stays a notice", async () => {
      const { monitor, push } = createMonitor({
        processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
        config: { ...BREACH_CONFIG, notifyAgent: false },
      });

      await monitor.tick();

      expect(push.levels).toEqual(["notice"]);
    });

    test("a steer that failed did not apply the remedy, so the breach stays a notice", async () => {
      const { monitor, push, steer } = createMonitor({
        processRows: [agentProcessRow("agent-1", 7 * 1024 * 1024, 0)],
        config: BREACH_CONFIG,
      });
      steer.fn.mockRejectedValueOnce(new Error("agent is gone"));

      await monitor.tick();

      expect(push.levels).toEqual(["notice"]);
    });

    function fleet(idleIds: readonly string[] = []) {
      const agents = ["agent-1", "agent-2", "agent-3", "agent-4"].map((id) =>
        summary({ id, isRunning: !idleIds.includes(id) }),
      );
      const rows = agents.map((agent, index) =>
        row({
          pid: 200 + index,
          rssKb: 7 * 1024 * 1024,
          cpuPercent: 0,
          command: `claude ...callerAgentId=${agent.id}`,
        }),
      );
      return { agents, rows };
    }

    test("a batched push is recorded when every breach in it was steered", async () => {
      const { agents, rows } = fleet();
      const { monitor, push } = createMonitor({ agents, processRows: rows, config: BREACH_CONFIG });

      await monitor.tick();

      expect(push.sent[0]?.data?.reason).toBe("resource_multi");
      expect(push.levels).toEqual(["record"]);
    });

    test("a batched push stays a notice when any breach in it could not be steered", async () => {
      const { agents, rows } = fleet(["agent-3"]);
      const { monitor, push } = createMonitor({ agents, processRows: rows, config: BREACH_CONFIG });

      await monitor.tick();

      expect(push.sent[0]?.data?.reason).toBe("resource_multi");
      expect(push.levels).toEqual(["notice"]);
    });
  });

  describe("system memory on the ladder", () => {
    const SWAP_HIGH: SystemMemorySample = {
      totalPhysicalBytes: 1e12,
      swapTotalBytes: 10_000_000,
      swapUsedBytes: 9_500_000,
    };
    const SWAP_LOW: SystemMemorySample = { ...SWAP_HIGH, swapUsedBytes: 100_000 };

    test("never pushes directly: the ladder owns the person-facing alert", async () => {
      const { monitor, push, agentManager } = createMonitor({
        agents: [],
        systemMemory: SWAP_HIGH,
        config: { systemSwapUsedRatio: 0.9 },
      });

      await monitor.tick();

      expect(push.sent).toHaveLength(0);
      expect(agentManager.setResourceAlert).not.toHaveBeenCalled();
    });

    test("with the reaper off there is no remedy, and a standard agent may try", async () => {
      const { monitor, remediation } = createMonitor({
        agents: [],
        systemMemory: SWAP_HIGH,
        config: { systemSwapUsedRatio: 0.9 },
      });

      await monitor.tick();

      const observation = remediation.last("system-memory");
      expect(observation).toMatchObject({
        key: "system-memory",
        kind: "system-memory",
        active: true,
        remedy: "none",
        level: "alert",
        graceMs: 10 * 60_000,
        escalation: { taskClass: "standard" },
      });
      // What the agent may touch, and what it must not: the boundary is in the task itself.
      expect(observation?.escalation?.task).toContain("orphaned build daemons");
      expect(observation?.escalation?.task).toContain("never");
      expect(observation?.summary).toContain("95%");
    });

    test("a live reaper is the remedy, and a dry run is not", async () => {
      const live = createMonitor({
        agents: [],
        systemMemory: SWAP_HIGH,
        config: { reaper: { enabled: true } },
      });
      await live.monitor.tick();
      expect(live.remediation.last("system-memory")?.remedy).toBe("live");

      const dryRun = createMonitor({
        agents: [],
        systemMemory: SWAP_HIGH,
        config: { reaper: { enabled: true, dryRun: true } },
      });
      await dryRun.monitor.tick();
      expect(dryRun.remediation.last("system-memory")?.remedy).toBe("none");
    });

    test("the evidence names the biggest process trees, labelled with their agent", async () => {
      const { monitor, remediation } = createMonitor({
        agents: [summary({ id: "agent-1" })],
        titles: { "agent-1": "Walk & Talk orchestrator" },
        processRows: [
          agentProcessRow("agent-1", 5 * 1024 * 1024, 0),
          row({ pid: 300, ppid: 1, rssKb: 3 * 1024 * 1024, command: "/opt/tools/simulator-host" }),
          row({ pid: 301, ppid: 1, rssKb: 10 * 1024, command: "tiny" }),
        ],
        systemMemory: SWAP_HIGH,
      });

      await monitor.tick();

      const evidence = remediation.last("system-memory")?.evidence ?? "";
      expect(evidence).toContain("- agent Walk & Talk orchestrator: 5.0 GB");
      expect(evidence).toContain("- simulator-host (pid 300): 3.0 GB");
      expect(evidence.indexOf("Walk & Talk")).toBeLessThan(evidence.indexOf("simulator-host"));
    });

    test("what the artifact janitor reclaimed this sweep is an attempt", async () => {
      const { monitor, remediation } = createMonitor({
        agents: [],
        systemMemory: SWAP_HIGH,
        sweepTestArtifacts: async () => ({
          dryRun: false,
          reclaimed: [
            {
              setId: "xcode-test-simulator-clones",
              label: "Xcode test simulator clone",
              name: "ABCD-1234",
              path: "/Users/t/Library/Developer/XCTestDevices/ABCD-1234",
              sizeBytes: 4 * 1024 ** 3,
              ageMs: 3 * 3_600_000,
              claim: "unowned",
            },
          ],
        }),
      });

      await monitor.tick();

      expect(remediation.last("system-memory")?.attempts).toEqual([
        expect.objectContaining({
          remedy: "artifact-janitor",
          outcome: "acted",
          detail: expect.stringContaining("ABCD-1234"),
        }),
      ]);
    });

    test("closes the episode once swap has been back under the threshold", async () => {
      const { monitor, remediation, sampler } = createMonitor({
        agents: [],
        systemMemory: SWAP_HIGH,
        config: { systemSwapUsedRatio: 0.9 },
      });
      await monitor.tick();
      expect(remediation.last("system-memory")?.active).toBe(true);

      sampler.sampleSystemMemory.mockResolvedValue(SWAP_LOW);
      await monitor.tick();

      expect(remediation.last("system-memory")?.active).toBe(false);
    });

    test("says nothing about a condition that never held", async () => {
      const { monitor, remediation } = createMonitor({ agents: [], systemMemory: SWAP_LOW });

      await monitor.tick();
      await monitor.tick();

      expect(remediation.observations).toEqual([]);
    });
  });

  describe("orphan build daemons on the ladder", () => {
    const SWEEP_MS = 60_000;
    const HEAVY_DAEMON = () => gradleDaemonRow({ rssKb: 3 * 1024 * 1024 });

    test("never pushes directly, even with the reaper off", async () => {
      const { monitor, push } = createMonitor({
        agents: [],
        processRows: [HEAVY_DAEMON()],
      });

      await monitor.tick();

      expect(push.sent).toHaveLength(0);
    });

    test("with the reaper off the operator opted out: a notice, no agent", async () => {
      const { monitor, remediation, steer } = createMonitor({
        agents: [],
        processRows: [HEAVY_DAEMON()],
      });

      await monitor.tick();

      expect(remediation.last("orphan-build-daemons")).toMatchObject({
        key: "orphan-build-daemons",
        kind: "orphan-build-daemons",
        active: true,
        remedy: "disabled",
        level: "notice",
      });
      expect(steer.fn).not.toHaveBeenCalled();
    });

    test("a dry-run reaper cannot act either: dry-run, notice", async () => {
      const { monitor, remediation } = createMonitor({
        agents: [],
        processRows: [HEAVY_DAEMON()],
        config: { reaper: { enabled: true, dryRun: true } },
      });

      await monitor.tick();

      expect(remediation.last("orphan-build-daemons")).toMatchObject({
        remedy: "dry-run",
        level: "notice",
      });
    });

    test("a live reaper is the remedy, an alert if it fails, and gets its idle window plus two sweeps", async () => {
      const { monitor, remediation } = createMonitor({
        agents: [],
        processRows: [HEAVY_DAEMON()],
        config: { reaper: { enabled: true, idleMinutes: 20 } },
      });

      await monitor.tick();

      const observation = remediation.last("orphan-build-daemons");
      expect(observation).toMatchObject({ remedy: "live", level: "alert" });
      expect(observation?.graceMs).toBe(20 * 60_000 + 2 * SWEEP_MS);
      expect(observation?.escalation).toMatchObject({ taskClass: "mechanical" });
      // The boundary an agent must respect is in the task, not left to its judgement.
      expect(observation?.escalation?.task).toContain("./gradlew --stop");
      expect(observation?.escalation?.task).toContain("never");
      expect(observation?.evidence).toContain("GradleDaemon");
      expect(observation?.evidence).toContain("28056");
    });

    test("below the threshold the condition does not hold", async () => {
      const { monitor, remediation } = createMonitor({
        agents: [],
        processRows: [gradleDaemonRow({ rssKb: 500 * 1024 })],
      });

      await monitor.tick();

      expect(remediation.observations).toEqual([]);
    });

    test("carries this episode's reaps as attempts, and closes the episode once they are gone", async () => {
      const clock = { ms: 1_000_000 };
      const { signaller } = createFakeSignaller();
      const sampler = createFakeSampler();
      let visible = true;
      const sampleWhileVisible = async () => (visible ? [HEAVY_DAEMON()] : []);
      sampler.sampleProcesses.mockImplementation(sampleWhileVisible);
      const { monitor, remediation } = createMonitor({
        agents: [],
        sampler,
        config: { reaper: { enabled: true } },
        signaller,
        now: () => clock.ms,
      });

      await sweep(monitor, 20, clock);

      const reaped = remediation.last("orphan-build-daemons");
      expect(reaped?.active).toBe(true);
      expect(reaped?.attempts).toEqual([
        expect.objectContaining({
          remedy: "reaper",
          outcome: "acted",
          detail: expect.stringMatching(/Gradle daemon pid 28056 \(3\.0 GB/),
        }),
      ]);

      visible = false;
      await sweep(monitor, 1, clock);

      const closed = remediation.last("orphan-build-daemons");
      expect(closed?.active).toBe(false);
      expect(closed?.attempts).toHaveLength(1);

      // A later, unrelated episode starts with a clean list.
      visible = true;
      const sampleUnrelatedDaemon = async () => [
        gradleDaemonRow({ pid: 999, rssKb: 3 * 1024 * 1024 }),
      ];
      sampler.sampleProcesses.mockImplementation(sampleUnrelatedDaemon);
      await sweep(monitor, 1, clock);
      expect(remediation.last("orphan-build-daemons")?.attempts ?? []).not.toContainEqual(
        expect.objectContaining({ detail: expect.stringContaining("pid 28056") }),
      );
    });

    test("says why the daemons it did not touch were spared", async () => {
      const clock = { ms: 1_000_000 };
      const { signaller, sent } = createFakeSignaller();
      const sampler = createFakeSampler();
      let cpuSeconds = 5_000;
      const sampleBusyAndOffAllowlist = async () => {
        cpuSeconds += 19.2;
        return [
          gradleDaemonRow({ cpuPercent: 32, cpuSeconds, etime: "3:00:00" }),
          row({
            pid: 77,
            ppid: 1,
            rssKb: 3 * 1024 * 1024,
            command: "/usr/bin/grep GradleDaemon /tmp/x",
          }),
        ];
      };
      sampler.sampleProcesses.mockImplementation(sampleBusyAndOffAllowlist);
      const { monitor, remediation } = createMonitor({
        agents: [],
        sampler,
        config: { reaper: { enabled: true } },
        signaller,
        now: () => clock.ms,
      });

      await sweep(monitor, 5, clock);

      expect(sent).toEqual([]);
      const spared = remediation.last("orphan-build-daemons")?.attempts?.filter(isSkippedAttempt);
      expect(spared).toHaveLength(1);
      expect(spared?.[0]?.remedy).toBe("reaper");
      expect(spared?.[0]?.detail).toContain("busy 1");
      expect(spared?.[0]?.detail).toContain("not-on-allowlist 1");
    });

    test("a daemon the reaper may not signal is reported as not-permitted", async () => {
      const clock = { ms: 1_000_000 };
      const { signaller } = createFakeSignaller({ notPermitted: [28056] });
      const { monitor, remediation } = createMonitor({
        agents: [],
        processRows: [HEAVY_DAEMON()],
        config: { reaper: { enabled: true } },
        signaller,
        now: () => clock.ms,
      });

      await sweep(monitor, 20, clock);

      const spared = remediation.last("orphan-build-daemons")?.attempts?.find(isSkippedAttempt);
      expect(spared?.detail).toContain("not-permitted 1");
    });

    test("turning the whole monitor off closes an open episode once", async () => {
      let enabled = true;
      const remediation = createRecordingSink();
      const monitor = new AgentResourceMonitor({
        agentManager: createFakeAgentManager([]),
        agentStorage: createFakeAgentStorage(),
        pushNotificationSender: createFakePushSender().sender,
        remediationSink: remediation.sink,
        serverId: "server-1",
        processSampler: createFakeSampler({ processRows: [HEAVY_DAEMON()] }),
        sendSystemMessageToAgent: createFakeSteer().fn,
        readDaemonConfig: () => ({ resourceMonitor: { ...SUSTAINED_ONE, enabled } }),
        logger: createLogger(),
        ownerUid: OWNER_UID,
        sleep: async () => {},
      });

      await monitor.tick();
      enabled = false;
      await monitor.tick();
      await monitor.tick();

      expect(remediation.forKey("orphan-build-daemons").map(observationIsActive)).toEqual([
        true,
        false,
      ]);
    });
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
    const { monitor, push, remediation } = createMonitor({
      agents: [],
      processRows: [gradleDaemonRow()],
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 30, clock);

    expect(sent).toEqual([]);
    expect(reapPushes(push.sent)).toHaveLength(0);
    // Reaping replaces nothing until it's enabled: the ladder is told the remedy is disabled.
    expect(remediation.last("orphan-build-daemons")?.remedy).toBe("disabled");
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

  test("a live build on a ppid-1 daemon is spared, and the log says why", async () => {
    // Recorded from Tyler's machine: two JVMs reparented to init, 3.4 GB and 2.9 GB, burning
    // ~32% CPU, genuinely mid-build. The reaper must spare them for as long as they are busy,
    // and the dry-run log must show it did rather than say nothing.
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    let cpuSeconds = 5_000;
    const sampler = createFakeSampler();
    sampler.sampleProcesses.mockImplementation(async () => {
      cpuSeconds += 19.2; // 32% of a 60s sweep
      return [gradleDaemonRow({ cpuPercent: 32, cpuSeconds, etime: "3:00:00" })];
    });
    const { monitor, push, logger } = createMonitor({
      agents: [],
      sampler,
      config: { reaper: { enabled: true, dryRun: true } },
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 40, clock);

    expect(sent).toEqual([]);
    expect(reapPushes(push.sent)).toHaveLength(0);
    const watched = logger.info.mock.calls.filter(
      ([, message]) => message === "Reaper: orphaned build daemons in view",
    );
    // One line per verdict change: first sighting, then busy for the next thirty-nine sweeps.
    expect(
      watched.map(
        ([fields]) => (fields as { daemons: Array<{ verdict: string }> }).daemons[0]?.verdict,
      ),
    ).toEqual(["first-sighting", "busy"]);
    expect(
      watched.map(
        ([fields]) => (fields as { daemons: Array<{ cpuPercent: number }> }).daemons[0]?.cpuPercent,
      )[1],
    ).toBe(32);
  });

  test("a ppid-1 process that only mentions GradleDaemon is reported as off the allowlist", async () => {
    const clock = { ms: 1_000_000 };
    const { signaller, sent } = createFakeSignaller();
    const { monitor, logger } = createMonitor({
      agents: [],
      processRows: [
        gradleDaemonRow({
          pid: 301,
          command: "grep -r org.gradle.launcher.daemon.bootstrap.GradleDaemon .",
        }),
      ],
      config: { reaper: { enabled: true, dryRun: true } },
      signaller,
      now: () => clock.ms,
    });

    await sweep(monitor, 40, clock);

    expect(sent).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      { daemons: [expect.objectContaining({ pid: 301, verdict: "not-on-allowlist" })] },
      "Reaper: orphaned build daemons in view",
    );
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

function failProcessSamples(sampler: ReturnType<typeof createFakeSampler>): void {
  sampler.sampleProcessTable.mockImplementation(async () => ({
    status: "failed",
    error: new Error("ps timed out"),
  }));
}

function createRecordingLedger() {
  const records: SaturationLedgerRecord[] = [];
  return {
    ledger: { append: vi.fn(async (record: SaturationLedgerRecord) => void records.push(record)) },
    records,
  };
}

function loadavg(load1: number): SystemLoadReading {
  return { kind: "loadavg", cores: 16, load1, load5: load1, load15: load1 };
}

describe("AgentResourceMonitor when process sampling fails", () => {
  test("stale rows never reach the reaper, the artifact janitor or the device cap", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({ processRows: [gradleDaemonRow()] });
    const sweepTestArtifacts = vi.fn(async () => ({ dryRun: false, reclaimed: [] }));
    const reportDeviceSample = vi.fn(async () => undefined);
    const { signaller, sent } = createFakeSignaller();
    const { monitor } = createMonitor({
      agents: [],
      sampler,
      signaller,
      config: { reaper: { enabled: true, idleMinutes: 1, minIdleSweeps: 1 } },
      sweepTestArtifacts,
      reportDeviceSample,
      now: () => clock.ms,
    });

    await sweep(monitor, 1, clock);
    failProcessSamples(sampler);
    await sweep(monitor, 10, clock);

    expect(sweepTestArtifacts).toHaveBeenCalledTimes(1);
    expect(reportDeviceSample).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  test("swap pressure is still reported, naming the last good sample's trees and its age", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({
      processRows: [agentProcessRow("agent-1", 4_000_000, 0)],
      systemMemory: { totalPhysicalBytes: 1e12, swapTotalBytes: 100, swapUsedBytes: 95 },
    });
    const { monitor, remediation } = createMonitor({
      sampler,
      titles: { "agent-1": "Android checkout" },
      now: () => clock.ms,
    });

    await sweep(monitor, 1, clock);
    failProcessSamples(sampler);
    await sweep(monitor, 2, clock);

    const observation = remediation.last("system-memory");
    expect(observation?.active).toBe(true);
    expect(observation?.evidence).toContain("from a sample 120s old");
    expect(observation?.evidence).toContain("Android checkout");
  });

  test("an agent's alert is held, not cleared, while its tree cannot be seen", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({
      processRows: [agentProcessRow("agent-1", 100_000_000, 0)],
    });
    const { monitor, agentManager } = createMonitor({ sampler, now: () => clock.ms });

    await sweep(monitor, 1, clock);
    expect(agentManager.setResourceAlert).toHaveBeenCalledTimes(1);
    failProcessSamples(sampler);
    await sweep(monitor, 3, clock);

    expect(agentManager.clearResourceAlert).not.toHaveBeenCalled();
  });

  test("a sweep that could not look restarts a daemon's idle clock", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({ processRows: [gradleDaemonRow()] });
    const { signaller, sent } = createFakeSignaller();
    const { monitor } = createMonitor({
      agents: [],
      sampler,
      signaller,
      config: { reaper: { enabled: true } },
      now: () => clock.ms,
    });

    // First sighting and one idle sweep, then twenty minutes blind.
    await sweep(monitor, 2, clock);
    failProcessSamples(sampler);
    await sweep(monitor, 20, clock);
    sampler.sampleProcessTable.mockImplementation(async () => ({
      status: "ok",
      rows: [gradleDaemonRow()],
    }));

    // Counting the blind stretch as idle would reap here, three idle sweeps and 20+ minutes in.
    await sweep(monitor, 3, clock);
    expect(sent).toEqual([]);

    await sweep(monitor, 15, clock);
    expect(sent).toEqual([{ pid: 28056, signal: "SIGTERM" }]);
  });
});

describe("AgentResourceMonitor saturation", () => {
  const SATURATION_3 = { saturation: { sustainedMinutes: 3 } } as const;

  test("opens after three sweeps at twice the cores, records it, and exposes the evidence", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({
      processRows: [agentProcessRow("agent-1", 1_000_000, 1_500)],
      load: loadavg(38),
    });
    const { ledger, records } = createRecordingLedger();
    const { monitor } = createMonitor({
      sampler,
      titles: { "agent-1": "Fix orders API" },
      config: SATURATION_3,
      saturationLedger: ledger,
      now: () => clock.ms,
    });

    await sweep(monitor, 2, clock);
    expect(records).toHaveLength(0);
    expect(monitor.getSaturationSweep()).toBeUndefined();

    await sweep(monitor, 1, clock);
    expect(records.map((record) => record.event)).toEqual(["open"]);
    expect(records[0]).toMatchObject({
      load: { load1: 38 },
      memory: { freeBytes: 8 * 1024 ** 3 },
      evidence: {
        sample: { status: "fresh" },
        agentTrees: [{ agentId: "agent-1", title: "Fix orders API" }],
      },
    });
    expect(monitor.getSaturationSweep()).toMatchObject({ transition: "opened" });
  });

  test("records every five minutes while it holds, then the clear", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({ load: loadavg(40) });
    const { ledger, records } = createRecordingLedger();
    const { monitor } = createMonitor({
      agents: [],
      sampler,
      config: SATURATION_3,
      saturationLedger: ledger,
      now: () => clock.ms,
    });

    await sweep(monitor, 13, clock);
    expect(records.map((record) => record.event)).toEqual(["open", "ongoing", "ongoing"]);
    expect(monitor.getSaturationSweep()?.transition).toBe("held");

    sampler.sampleSystemLoad.mockReturnValue({
      load: loadavg(6),
      freeMemoryBytes: 1,
      totalMemoryBytes: 2,
    });
    await sweep(monitor, 3, clock);

    expect(records.map((record) => record.event)).toEqual(["open", "ongoing", "ongoing", "clear"]);
    expect(records[3]).toMatchObject({ peakLoad1: 40 });
    expect(monitor.getSaturationSweep()).toBeUndefined();
  });

  test("detects saturation with ps failing, with stale attribution and an unknown cause", async () => {
    const clock = { ms: 1_000_000 };
    const sampler = createFakeSampler({
      processRows: [agentProcessRow("agent-1", 1_000_000, 1_500)],
      load: loadavg(38),
    });
    const { ledger, records } = createRecordingLedger();
    const { monitor } = createMonitor({
      sampler,
      config: SATURATION_3,
      saturationLedger: ledger,
      now: () => clock.ms,
    });

    await sweep(monitor, 1, clock);
    failProcessSamples(sampler);
    await sweep(monitor, 2, clock);

    expect(records[0]?.evidence).toMatchObject({
      sample: { status: "stale", ageMs: 120_000 },
      cause: { kind: "unknown" },
      agentTrees: [{ agentId: "agent-1" }],
    });
  });

  test("records nothing when turned off", async () => {
    const clock = { ms: 1_000_000 };
    const { ledger, records } = createRecordingLedger();
    const { monitor } = createMonitor({
      agents: [],
      sampler: createFakeSampler({ load: loadavg(40) }),
      config: { saturation: { enabled: false } },
      saturationLedger: ledger,
      now: () => clock.ms,
    });

    await sweep(monitor, 5, clock);

    expect(records).toHaveLength(0);
  });
});
