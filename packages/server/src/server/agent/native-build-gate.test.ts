import { describe, expect, test, vi } from "vitest";
import type { DeviceLaunchGate, DeviceLaunchGateDecision } from "./device-lease-manager.js";
import {
  BUILD_GATE_GRANT_BACKSTOP_MS,
  BUILD_GATE_RUNNER_SETUP_MS,
  type BuildGateConfig,
  createNativeBuildGate,
} from "./native-build-gate.js";
import type { BuildGateHardware, BuildGateMachineReading } from "./native-build-headroom.js";
import { attributeProcessTrees } from "./process-attribution.js";
import type { ProcessSampleRow, ProcessTableSample } from "./process-sampler.js";

const GIB = 1024 ** 3;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STUDIO_JAVA = "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java";
const XCODEBUILD = "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild";
const AGENTS = [
  { agentId: "agent-a", title: "Android release build" },
  { agentId: "agent-b", title: "iOS snapshot tests" },
  { agentId: "agent-c", title: "Pixel verify" },
  { agentId: "agent-d", title: "Release notes" },
];
/** The 16-core, 64 GiB Mac the defaults are sized for: a floor of 3 and a ceiling of 5. */
const BIG_MACHINE: BuildGateHardware = { cpuCount: 16, memoryBytes: 64 * GIB };

function row(pid: number, ppid: number, command: string, etime = "04:12"): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb: 1000, cpuPercent: 0, etime, command };
}

function agentRoot(pid: number, agentId: string): ProcessSampleRow {
  return row(pid, 1, `claude --mcp-config http://127.0.0.1:6767/mcp?callerAgentId=${agentId}`);
}

/** An agent's provider process, the shell running its command, and what that shell runs. */
function agentRunning(
  agentId: string,
  base: number,
  command: string,
  etime = "04:12",
): ProcessSampleRow[] {
  return [
    agentRoot(base, agentId),
    row(base + 1, base, "/bin/zsh -c build"),
    row(base + 2, base + 1, command, etime),
  ];
}

function gradlew(args: string): string {
  return `${STUDIO_JAVA} -Xmx64m -Dorg.gradle.appname=gradlew -jar /w/android/gradle/wrapper/gradle-wrapper.jar ${args}`;
}

/** The shell Claude's Bash tool runs a command in: the command text is in its argv. */
function bashTool(command: string): string {
  return (
    "/bin/zsh -c source /Users/t/.claude/shell-snapshots/snapshot-zsh.sh 2>/dev/null || true " +
    `&& eval '${command}' < /dev/null && pwd -P >| /tmp/claude-cwd`
  );
}

function healthyMachine(takenAtMs: number): BuildGateMachineReading {
  return {
    takenAtMs,
    systemMemory: {
      totalPhysicalBytes: 64 * GIB,
      swapTotalBytes: 20 * GIB,
      swapUsedBytes: 4 * GIB,
      availableBytes: 30 * GIB,
      memoryPressureLevel: 1,
    },
    systemLoad: {
      load: { kind: "loadavg", cores: 16, load1: 6, load5: 6, load15: 6 },
      freeMemoryBytes: 2 * GIB,
      totalMemoryBytes: 64 * GIB,
    },
    memoryBrakeHeld: false,
    diskBrakeHeld: false,
    cpuSaturated: false,
  };
}

function setup(
  overrides: {
    config?: BuildGateConfig;
    freeGiB?: number;
    lowFreeGB?: number;
    sampleTimeoutMs?: number;
    sideProcesses?: ReadonlyMap<string, readonly number[]>;
    hardware?: BuildGateHardware;
    platform?: NodeJS.Platform;
  } = {},
) {
  const state = {
    rows: [] as ProcessSampleRow[],
    // Burst is off unless a test turns it on, so the floor's tests read as they always did.
    config: {
      maxConcurrent: 1,
      burst: { enabled: false },
      ...overrides.config,
    } as BuildGateConfig,
    freeGiB: overrides.freeGiB ?? 200,
    diskFails: false,
    table: undefined as Promise<ProcessTableSample> | undefined,
    innerDecision: { decision: "allow" } as DeviceLaunchGateDecision,
    nowMs: 1_000_000,
  };
  const inner = {
    gateLaunch: vi.fn(async () => state.innerDecision),
    explainRefusalToAgent: vi.fn(async () => undefined),
  } satisfies DeviceLaunchGate;
  const sampleProcessTable = vi.fn(
    (): Promise<ProcessTableSample> =>
      state.table ?? Promise.resolve({ status: "ok", rows: state.rows }),
  );
  const sent: Array<{ agentId: string; body: string }> = [];
  const logger = { info: vi.fn(), warn: vi.fn() };
  const gate = createNativeBuildGate({
    inner,
    processSampler: { sampleProcessTable },
    listAgents: () => AGENTS,
    ...(overrides.sideProcesses
      ? { readAgentSideProcesses: () => overrides.sideProcesses ?? new Map() }
      : {}),
    readConfig: () => ({
      buildGate: state.config,
      ...(overrides.lowFreeGB !== undefined
        ? { remediation: { disk: { lowFreeGB: overrides.lowFreeGB } } }
        : {}),
    }),
    readFreeDiskBytes: async () => {
      if (state.diskFails) throw new Error("statfs: EIO");
      return state.freeGiB * GIB;
    },
    sendSystemMessageToAgent: async (agentId, body) => void sent.push({ agentId, body }),
    logger,
    now: () => state.nowMs,
    readHardware: () => overrides.hardware ?? BIG_MACHINE,
    ...(overrides.platform ? { platform: overrides.platform } : {}),
    ...(overrides.sampleTimeoutMs !== undefined
      ? { sampleTimeoutMs: overrides.sampleTimeoutMs }
      : {}),
  });
  const ask = (agentId: string, command: string) => gate.gateLaunch({ agentId, command });
  /** What the resource monitor hands the gate each sweep: this sweep's attributed `ps`. */
  const sweep = () =>
    gate.observeSample({
      rows: state.rows,
      agentTrees: attributeProcessTrees(
        state.rows,
        AGENTS.map((agent) => agent.agentId),
      ).agentTrees,
    });
  const advance = (ms: number) => {
    state.nowMs += ms;
  };
  /** What the monitor hands the gate at the end of a sweep: the machine, healthy unless said. */
  const machine = (changes: Partial<BuildGateMachineReading> = {}) =>
    gate.observeMachine({ ...healthyMachine(state.nowMs), ...changes });
  /** Three sweeps two minutes apart in all: enough swap history to say swap is steady. */
  const warmUp = (changes: Partial<BuildGateMachineReading> = {}) => {
    machine(changes);
    advance(MINUTE);
    machine(changes);
    advance(MINUTE);
    machine(changes);
  };
  return {
    gate,
    state,
    inner,
    sampleProcessTable,
    sent,
    logger,
    ask,
    sweep,
    advance,
    machine,
    warmUp,
  };
}

function denial(decision: DeviceLaunchGateDecision): string {
  if (decision.decision !== "deny") throw new Error("expected a denial");
  return decision.message;
}

function logged(mock: ReturnType<typeof vi.fn>, message: string): number {
  return mock.mock.calls.filter(([, said]) => said === message).length;
}

const ALLOW: DeviceLaunchGateDecision = { decision: "allow" };
const DENY = expect.objectContaining({ decision: "deny" });

describe("native build gate: counting and refusing", () => {
  test("with one Gradle build running and a cap of 1, an agent's build is refused, naming the holder", async () => {
    const { state, inner, ask, logger } = setup();
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));

    const message = denial(await ask("agent-b", "cd android && ./gradlew assembleDebug"));

    expect(message).toContain("`gradlew assembleDebug` was not run");
    expect(message).toContain("the limit is 1");
    expect(message).toContain(
      '`gradlew assembleRelease` by "Android release build" (agent agent-a)',
    );
    expect(message).toContain("running 4m12s");
    expect(message).toMatch(/sleep 120/);
    expect(message).toContain("after 120 minutes");
    expect(inner.gateLaunch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-b", command: "gradlew assembleDebug", running: 1 }),
      "Build gate refused a native build",
    );
  });

  test("a read-only command passes without a scan, straight to the inner gate", async () => {
    const { state, inner, sampleProcessTable, ask } = setup();
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    expect(await ask("agent-b", "xcodebuild -list")).toEqual(ALLOW);
    expect(await ask("agent-b", "git status")).toEqual(ALLOW);
    expect(sampleProcessTable).not.toHaveBeenCalled();
    expect(inner.gateLaunch).toHaveBeenCalledTimes(2);
  });

  test("under the disk low line, any native build is refused, and the agent is told to wait, not delete", async () => {
    // 19 GB is above the 5 GB critical floor; one build writes 10 to 34 GB.
    const { ask, inner } = setup({ freeGiB: 19, config: { maxConcurrent: 4 } });
    const message = denial(await ask("agent-b", "xcodebuild test -scheme App"));
    expect(message).toContain("free disk is 19.0 GB, under the 20.0 GB line");
    expect(message).toMatch(/sleep 300/);
    expect(message).toContain("Do not delete DerivedData");
    expect(inner.gateLaunch).not.toHaveBeenCalled();
  });

  test("the disk line is remediation.disk.lowFreeGB", async () => {
    const lowered = setup({ freeGiB: 19, lowFreeGB: 10 });
    expect(await lowered.ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
    const raised = setup({ freeGiB: 35, lowFreeGB: 40 });
    expect(denial(await raised.ask("agent-b", "./gradlew assembleDebug"))).toContain(
      "under the 40.0 GB line",
    );
  });

  test("a build started outside every agent holds the slot too", async () => {
    const { state, ask } = setup();
    state.rows = [row(300, 1, gradlew(":app:assembleDebug"))];
    expect(denial(await ask("agent-a", "./gradlew assembleRelease"))).toContain(
      "outside every agent's process tree",
    );
  });

  test("the asking agent's own running build is named as its own", async () => {
    const { state, ask } = setup();
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    expect(denial(await ask("agent-a", "./gradlew assembleRelease"))).toContain(
      "your own earlier build `gradlew assembleRelease`",
    );
  });

  test("a build an agent's ask_jev command runs is that agent's", async () => {
    const { state, ask } = setup({ sideProcesses: new Map([["agent-a", [700]]]) });
    state.rows = [row(700, 1, "/bin/sh -c jev command"), row(701, 700, gradlew("assembleDebug"))];
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain("(agent agent-a)");
  });

  test("a build past maxBuildMinutes stops holding a slot, and that is logged once", async () => {
    // Review #10: a hung xcodebuild test held every agent's build off for its whole life.
    const { state, ask, advance, logger } = setup();
    state.rows = agentRunning("agent-a", 100, `${XCODEBUILD} test -scheme App`, "02:05:00");
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
    advance(10 * SECOND);
    state.rows = agentRunning("agent-a", 100, `${XCODEBUILD} test -scheme App`, "02:05:10");
    expect(await ask("agent-c", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(logged(logger.info, "Build gate stopped counting a build past maxBuildMinutes")).toBe(1);

    const longer = setup({ config: { maxBuildMinutes: 180 } });
    longer.state.rows = agentRunning("agent-a", 100, `${XCODEBUILD} test -scheme App`, "02:05:00");
    expect(denial(await longer.ask("agent-b", "./gradlew assembleDebug"))).toContain(
      "after 180 minutes",
    );
  });

  test("at a cap of 2, a second build passes; a third waits until one of them ends", async () => {
    const { state, ask, advance } = setup({ config: { maxConcurrent: 2 } });
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));

    expect(await ask("agent-b", "xcodebuild test -scheme App")).toEqual(ALLOW);
    const message = denial(await ask("agent-c", "./gradlew installDebug"));
    expect(message).toContain("2 native builds");
    expect(message).toContain(
      '`xcodebuild test` for "iOS snapshot tests" (agent agent-b), allowed',
    );

    // The second build appears: it holds the slot its allowance held, not a second one.
    advance(10 * SECOND);
    state.rows = [
      ...agentRunning("agent-a", 100, gradlew("assembleRelease")),
      ...agentRunning("agent-b", 200, `${XCODEBUILD} test -scheme App`),
    ];
    expect(denial(await ask("agent-c", "./gradlew installDebug"))).toContain("2 native builds");
    advance(10 * SECOND);
    state.rows = agentRunning("agent-b", 200, `${XCODEBUILD} test -scheme App`);
    expect(await ask("agent-c", "./gradlew installDebug")).toEqual(ALLOW);
  });
});

describe("native build gate: allowances", () => {
  test("a build that finished between two decisions gives its slot back, to its own agent and others", async () => {
    // Review #4: an incremental build that started and ended between scans held the slot 3 minutes.
    const own = setup();
    expect(await own.ask("agent-a", "./gradlew assembleDebug")).toEqual(ALLOW);
    own.advance(10 * SECOND);
    expect(await own.ask("agent-a", "./gradlew installDebug")).toEqual(ALLOW);

    const other = setup();
    expect(await other.ask("agent-a", "./gradlew assembleDebug")).toEqual(ALLOW);
    other.advance(60 * SECOND);
    expect(await other.ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("builds asked for in the same moment are not both allowed: a fresh allowance is not judged by an early scan", async () => {
    const { ask, advance } = setup();
    expect(await ask("agent-a", "./gradlew assembleDebug")).toEqual(ALLOW);
    advance(1 * SECOND);
    expect(denial(await ask("agent-a", "xcodebuild -scheme App"))).toContain(
      "your own `gradlew assembleDebug`, allowed 1s ago and starting",
    );
  });

  test("an allowance holds while its launcher waits in heavy.sh, and ends when the launcher does", async () => {
    // Review #5: heavy.sh can queue a build for minutes before its Gradle client exists.
    const { state, ask, advance } = setup();
    const command = "nice -n 10 ~/bozeo-ops/cpu-policing/heavy.sh ./gradlew :app:assembleDebug";
    expect(await ask("agent-a", command)).toEqual(ALLOW);
    state.rows = [
      agentRoot(100, "agent-a"),
      row(101, 100, bashTool(command)),
      row(
        102,
        101,
        "/usr/bin/perl -e use strict; my ($dir, $slots, @cmd) = @ARGV; /Users/t/locks 2 ./gradlew :app:assembleDebug",
      ),
    ];
    advance(10 * MINUTE);
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain(
      '`gradlew :app:assembleDebug` for "Android release build" (agent agent-a), allowed 10m00s ago and starting',
    );
    state.rows = [agentRoot(100, "agent-a")];
    advance(10 * SECOND);
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("a launcher that never starts its build lets go at the backstop", async () => {
    const { state, ask, advance } = setup();
    const command = "./gradlew assembleDebug";
    expect(await ask("agent-a", command)).toEqual(ALLOW);
    state.rows = [agentRoot(100, "agent-a"), row(101, 100, bashTool(command))];
    advance(BUILD_GATE_GRANT_BACKSTOP_MS - MINUTE);
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(DENY);
    advance(2 * MINUTE);
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("an expo run holds the slot while it sets up and through its native build, not while it serves Metro", async () => {
    const { state, ask, advance } = setup();
    expect(await ask("agent-a", "npx expo run:ios")).toEqual(ALLOW);
    const agent = [agentRoot(100, "agent-a"), row(101, 100, bashTool("npx expo run:ios"))];
    const runner = row(102, 101, "/opt/homebrew/bin/node /w/node_modules/.bin/expo run:ios");

    // Prebuild and pods: no native build yet.
    state.rows = [...agent, runner];
    advance(5 * MINUTE);
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain(
      '`expo run:ios` by "Android release build" (agent agent-a), setting up',
    );
    // Its xcodebuild runs.
    state.rows = [
      ...agent,
      runner,
      row(103, 102, `${XCODEBUILD} -workspace ios/App.xcworkspace -scheme App`),
    ];
    advance(MINUTE);
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain(
      '`xcodebuild build` by "Android release build"',
    );
    // Installed; expo now serves Metro and builds nothing.
    state.rows = [...agent, runner];
    advance(MINUTE);
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("a runner never seen building stops holding a slot after its setup bound", async () => {
    const { state, ask } = setup();
    state.rows = agentRunning(
      "agent-a",
      100,
      "/opt/homebrew/bin/node /w/node_modules/.bin/expo run:android",
      `${BUILD_GATE_RUNNER_SETUP_MS / MINUTE + 1}:00`,
    );
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("a build the inner gate refuses gives its slot back", async () => {
    const { state, ask } = setup();
    state.innerDecision = { decision: "deny", message: "Device cap: no slot" };
    expect(await ask("agent-b", "npx expo run:ios")).toEqual({
      decision: "deny",
      message: "Device cap: no slot",
    });
    state.innerDecision = ALLOW;
    expect(await ask("agent-c", "./gradlew assembleDebug")).toEqual(ALLOW);
  });
});

describe("native build gate: the sample", () => {
  test("a recent monitor sample decides without a ps of its own", async () => {
    // Review #6: one ps a minute, shared with the monitor.
    const { state, ask, sweep, advance, sampleProcessTable } = setup();
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    sweep();
    advance(3 * SECOND);
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain("agent-a");
    expect(sampleProcessTable).not.toHaveBeenCalled();
  });

  test("builds asking together share one ps and are decided one after the other", async () => {
    const { ask, sampleProcessTable } = setup();
    const decisions = await Promise.all([
      ask("agent-a", "./gradlew assembleRelease"),
      ask("agent-b", "./gradlew assembleDebug"),
    ]);
    expect(decisions.map((decision) => decision.decision).sort()).toEqual(["allow", "deny"]);
    expect(sampleProcessTable).toHaveBeenCalledTimes(1);
  });

  test("a ps that outlasts its bound falls back to the monitor's last sample", async () => {
    const { state, ask, sweep, advance } = setup({ sampleTimeoutMs: 20 });
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    sweep();
    advance(90 * SECOND);
    state.table = new Promise<ProcessTableSample>(() => undefined);
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain("agent-a");
  });

  test("with no sample in time and none recent, it fails open and says so once", async () => {
    const hung = setup({ sampleTimeoutMs: 20 });
    hung.state.table = new Promise<ProcessTableSample>(() => undefined);
    expect(await hung.ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
    hung.advance(10 * SECOND);
    expect(await hung.ask("agent-c", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(logged(hung.logger.warn, "Build gate had no process sample in time; allowing")).toBe(1);

    const failed = setup();
    failed.state.table = Promise.resolve({ status: "failed", error: new Error("ps timed out") });
    expect(await failed.ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("a disk read that throws skips the disk check", async () => {
    const { state, ask } = setup();
    state.diskFails = true;
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
  });
});

describe("native build gate: modes and explanations", () => {
  test("dry run records what it would refuse and allows it", async () => {
    const { state, ask, logger, inner } = setup({ config: { dryRun: true } });
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(inner.gateLaunch).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        agentId: "agent-b",
        command: "gradlew assembleDebug",
      }),
      "Build gate would have refused a native build",
    );
  });

  test("config off allows every build without a scan", async () => {
    const { state, ask, sampleProcessTable } = setup({ config: { enabled: false } });
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    state.freeGiB = 1;
    expect(await ask("agent-b", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(sampleProcessTable).not.toHaveBeenCalled();
  });

  test("its own refusal is explained by the gate itself; others go to the inner gate", async () => {
    const { state, ask, gate, sent, inner } = setup();
    state.rows = agentRunning("agent-a", 100, gradlew("assembleRelease"));
    const message = denial(await ask("agent-b", "./gradlew assembleDebug"));

    await gate.explainRefusalToAgent?.({ agentId: "agent-b", message });
    expect(sent).toEqual([{ agentId: "agent-b", body: message }]);
    expect(inner.explainRefusalToAgent).not.toHaveBeenCalled();

    await gate.explainRefusalToAgent?.({ agentId: "agent-b", message: "Device cap: no slot" });
    expect(inner.explainRefusalToAgent).toHaveBeenCalledWith({
      agentId: "agent-b",
      message: "Device cap: no slot",
    });
  });
});

/** `n` builds started by hand, each under its own parent so each counts once. */
function handBuilds(n: number): ProcessSampleRow[] {
  return Array.from({ length: n }, (_, index) => {
    const base = 500 + index * 10;
    return [row(base, 1, "/bin/zsh -c build"), row(base + 1, base, gradlew("assembleDebug"))];
  }).flat();
}

const BURST_ON = { maxConcurrent: 3, burst: { enabled: true } } satisfies BuildGateConfig;

describe("native build gate: hardware defaults", () => {
  test("with no maxConcurrent set, the floor comes from the machine: 3 on a 16-core, 64 GiB Mac", async () => {
    const { state, ask, logger } = setup();
    state.config = { burst: { enabled: false } };
    state.rows = handBuilds(2);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ max: 3, burst: false }),
      "Build gate allowed a native build",
    );
    state.rows = handBuilds(3);
    advanceBeyondGrant(state);
    expect(denial(await ask("agent-d", "./gradlew assembleDebug"))).toContain("the limit is 3");
  });

  test("on a small machine the floor is 1 and there is no burst above it", async () => {
    const { state, ask, warmUp } = setup({ hardware: { cpuCount: 8, memoryBytes: 16 * GIB } });
    state.config = {};
    warmUp();
    state.rows = handBuilds(1);
    const message = denial(await ask("agent-d", "./gradlew assembleDebug"));
    expect(message).toContain("the limit is 1");
    expect(message).not.toContain("burst");
  });
});

/** Moves past the grace an allowance is given, so the next decision sees it as the scan sees it. */
function advanceBeyondGrant(state: { nowMs: number }) {
  state.nowMs += 10 * SECOND;
}

describe("native build gate: burst", () => {
  test("a build above the floor passes when every headroom check does, and is logged as burst with the numbers", async () => {
    const { state, ask, warmUp, logger, inner } = setup({ config: BURST_ON });
    warmUp();
    state.rows = handBuilds(3);

    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);

    expect(inner.gateLaunch).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-d",
        running: 3,
        max: 3,
        burst: true,
        burstMax: 5,
        headroom: expect.objectContaining({
          availableGB: 30,
          requiredMemoryGB: 8,
          freeDiskGB: 200,
          requiredDiskGB: 80,
          loadPerCore: 0.38,
        }),
      }),
      "Build gate allowed a native build",
    );
  });

  test("a build within the floor is not a burst build", async () => {
    const { state, ask, warmUp, logger } = setup({ config: BURST_ON });
    warmUp();
    state.rows = handBuilds(2);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ burst: false, headroom: expect.any(Object) }),
      "Build gate allowed a native build",
    );
  });

  test.each([
    ["the memory brake holds", { memoryBrakeHeld: true }, "memory check failed", "memory brake"],
    [
      "available memory is short",
      {
        systemMemory: {
          totalPhysicalBytes: 64 * GIB,
          swapTotalBytes: 20 * GIB,
          swapUsedBytes: 4 * GIB,
          availableBytes: 5 * GIB,
          memoryPressureLevel: 1,
        },
      },
      "memory check failed",
      "5 GB of memory is available and 8 GB is needed",
    ],
    ["CPU saturation is open", { cpuSaturated: true }, "CPU check failed", "saturation"],
    [
      "load is over the line",
      {
        systemLoad: {
          load: { kind: "loadavg" as const, cores: 16, load1: 20, load5: 20, load15: 20 },
          freeMemoryBytes: 0,
          totalMemoryBytes: 64 * GIB,
        },
      },
      "CPU check failed",
      "load is 20 on 16 cores",
    ],
    ["the disk brake holds", { diskBrakeHeld: true }, "disk check failed", "disk brake"],
  ])(
    "when %s, burst is refused and the refusal says which check",
    async (_, overrides, check, detail) => {
      const { state, ask, warmUp, logger, inner } = setup({ config: BURST_ON });
      warmUp(overrides);
      state.rows = handBuilds(3);

      const message = denial(await ask("agent-d", "./gradlew assembleDebug"));

      expect(message).toContain("The guaranteed limit is 3");
      expect(message).toContain("burst build (up to 5)");
      expect(message).toContain(check);
      expect(message).toContain(detail);
      expect(inner.gateLaunch).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "no-headroom",
          check: check.split(" ")[0]?.toLowerCase(),
          burst: false,
          headroom: expect.any(Object),
        }),
        "Build gate refused a native build",
      );
    },
  );

  test("swap that grew in the last minutes refuses burst", async () => {
    const { state, ask, warmUp, advance, machine } = setup({ config: BURST_ON });
    warmUp();
    advance(10 * SECOND);
    machine({
      systemMemory: {
        totalPhysicalBytes: 64 * GIB,
        swapTotalBytes: 20 * GIB,
        swapUsedBytes: 5 * GIB,
        availableBytes: 30 * GIB,
        memoryPressureLevel: 1,
      },
    });
    state.rows = handBuilds(3);
    const message = denial(await ask("agent-d", "./gradlew assembleDebug"));
    expect(message).toContain("swap check failed");
    expect(message).toContain("swap grew 1 GB in the last 5 minutes");
  });

  test("free disk must cover the low line plus a reserve for each build, including the new one", async () => {
    const { state, ask, warmUp } = setup({ config: BURST_ON, freeGiB: 79 });
    warmUp();
    state.rows = handBuilds(3);
    const message = denial(await ask("agent-d", "./gradlew assembleDebug"));
    expect(message).toContain("disk check failed");
    expect(message).toContain("79 GB of disk is free and 80 GB is needed");
    state.freeGiB = 80;
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);
  });

  test("with no reading from the monitor, burst fails closed, and so does a stale one", async () => {
    const none = setup({ config: BURST_ON });
    none.state.rows = handBuilds(3);
    expect(denial(await none.ask("agent-d", "./gradlew assembleDebug"))).toContain(
      "the resource monitor has not reported a reading",
    );

    const stale = setup({ config: BURST_ON });
    stale.warmUp();
    stale.state.rows = handBuilds(3);
    stale.advance(3 * MINUTE);
    expect(denial(await stale.ask("agent-d", "./gradlew assembleDebug"))).toContain(
      "last reading is 180s old",
    );
  });

  test("a free-disk read that throws skips the floor's disk check but refuses burst", async () => {
    const { state, ask, warmUp } = setup({ config: BURST_ON });
    state.diskFails = true;
    warmUp();
    state.rows = handBuilds(2);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);
    state.rows = handBuilds(3);
    advanceBeyondGrant(state);
    expect(denial(await ask("agent-d", "./gradlew assembleDebug"))).toContain(
      "free disk could not be read",
    );
  });

  test("the burst ceiling holds even with every check passing", async () => {
    const { state, ask, warmUp, logger } = setup({ config: BURST_ON });
    warmUp();
    state.rows = handBuilds(5);
    const message = denial(await ask("agent-d", "./gradlew assembleDebug"));
    expect(message).toContain(
      "both the guaranteed limit (3) and the burst ceiling (5) are reached",
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "at-burst-cap", max: 3, burstMax: 5 }),
      "Build gate refused a native build",
    );
  });

  test("burst off leaves the floor as the limit, and says nothing of burst", async () => {
    const { state, ask, warmUp, logger } = setup({
      config: { maxConcurrent: 3, burst: { enabled: false } },
    });
    warmUp();
    state.rows = handBuilds(3);
    const message = denial(await ask("agent-d", "./gradlew assembleDebug"));
    expect(message).toContain("the limit is 3 at a time");
    expect(message).not.toContain("burst");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "at-cap" }),
      "Build gate refused a native build",
    );
  });

  test("a ceiling at or under the floor is no burst", async () => {
    const { state, ask, warmUp } = setup({
      config: { maxConcurrent: 3, burst: { enabled: true, maxConcurrent: 2 } },
    });
    warmUp();
    state.rows = handBuilds(3);
    expect(denial(await ask("agent-d", "./gradlew assembleDebug"))).toContain(
      "the limit is 3 at a time",
    );
  });

  test("a second burst build waits for a reading that has seen the first one run", async () => {
    const { state, ask, warmUp, advance, machine } = setup({ config: BURST_ON });
    warmUp();
    state.rows = handBuilds(3);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);

    advance(10 * SECOND);
    machine();
    expect(denial(await ask("agent-a", "./gradlew assembleRelease"))).toContain(
      "settling check failed",
    );

    advance(100 * SECOND);
    machine();
    state.rows = [...handBuilds(3), ...agentRunning("agent-d", 400, gradlew("assembleDebug"))];
    expect(await ask("agent-a", "./gradlew assembleRelease")).toEqual(ALLOW);
    state.rows = [
      ...handBuilds(3),
      ...agentRunning("agent-d", 400, gradlew("assembleDebug")),
      ...agentRunning("agent-a", 450, gradlew("assembleRelease")),
    ];
    advance(100 * SECOND);
    machine();
    expect(denial(await ask("agent-b", "./gradlew assembleDebug"))).toContain(
      "burst ceiling (5) are reached",
    );
  });

  test("a granted burst build is left alone when headroom drops; only the next build is refused", async () => {
    const { state, ask, warmUp, advance, machine, inner } = setup({ config: BURST_ON });
    warmUp();
    state.rows = handBuilds(3);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);

    // The shell still runs the allowed command, so the allowance stands.
    state.rows = [
      ...handBuilds(3),
      agentRoot(400, "agent-d"),
      row(401, 400, "/bin/zsh -c ./gradlew assembleDebug"),
    ];
    advance(10 * SECOND);
    machine({ memoryBrakeHeld: true });
    const message = denial(await ask("agent-a", "./gradlew assembleRelease"));

    expect(message).toContain("memory check failed");
    expect(message).toContain('for "Release notes" (agent agent-d), allowed');
    expect(inner.gateLaunch).toHaveBeenCalledTimes(1);
  });

  test("a burst build the device cap then refuses gives its slot back and does not delay the next", async () => {
    const { state, ask, warmUp, inner } = setup({ config: BURST_ON });
    warmUp();
    state.rows = handBuilds(3);
    state.innerDecision = { decision: "deny", message: "Device cap: no slot" };
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(state.innerDecision);

    state.innerDecision = { decision: "allow" };
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(inner.gateLaunch).toHaveBeenCalledTimes(2);
  });

  test("dry run logs the headroom refusal and allows the build", async () => {
    const { state, ask, logger } = setup({ config: { ...BURST_ON, dryRun: true } });
    state.rows = handBuilds(3);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, reason: "no-headroom", check: "reading" }),
      "Build gate would have refused a native build",
    );
  });

  test("on Windows, burst needs no pressure level or swap: free memory, CPU busy share and disk decide", async () => {
    const windows = {
      systemMemory: undefined,
      systemLoad: {
        load: { kind: "cpu-busy" as const, cores: 16, busyFraction: 0.4, load1: 6.4 },
        freeMemoryBytes: 20 * GIB,
        totalMemoryBytes: 64 * GIB,
      },
    };
    const { state, ask, machine, advance } = setup({ config: BURST_ON, platform: "win32" });
    machine(windows);
    state.rows = handBuilds(3);
    expect(await ask("agent-d", "./gradlew assembleDebug")).toEqual(ALLOW);

    advance(10 * SECOND);
    machine({
      ...windows,
      systemLoad: {
        ...windows.systemLoad,
        load: { kind: "cpu-busy", cores: 16, busyFraction: 0.9, load1: 14.4 },
      },
    });
    state.rows = [...handBuilds(3), ...agentRunning("agent-d", 400, gradlew("assembleDebug"))];
    expect(denial(await ask("agent-a", "./gradlew assembleRelease"))).toContain(
      "the CPU is 90% busy",
    );
  });
});
