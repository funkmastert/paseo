import { describe, expect, test, vi } from "vitest";
import {
  DeviceLeaseManager,
  type DeviceLeaseAgentSummary,
  type DeviceLeaseConfig,
} from "./device-lease-manager.js";
import { detectRunningDevices } from "./device-detection.js";
import { attributeProcessTrees } from "./process-attribution.js";
import type { ProcessSampleRow, SystemMemorySample } from "./process-sampler.js";

const GIBIBYTE = 1024 ** 3;

// The real command line of a booted simulator on Tyler's machine, with a swappable UDID.
function simulatorRow(pid: number, udid: string, etime = "02:14:00"): ProcessSampleRow {
  return {
    pid,
    ppid: 1,
    uid: 501,
    rssKb: 13_360,
    cpuPercent: 0.4,
    etime,
    command: `launchd_sim /Users/tylerthackray/Library/Developer/CoreSimulator/Devices/${udid}/data/var/run/launchd_bootstrap.plist`,
  };
}

function emulatorRow(pid: number, ppid: number, avd: string): ProcessSampleRow {
  return {
    pid,
    ppid,
    uid: 501,
    rssKb: 2_000_000,
    cpuPercent: 3,
    etime: "10:00",
    command: `/Users/tylerthackray/Library/Android/sdk/emulator/emulator -avd ${avd}`,
  };
}

/** What the sweep hands the cap once `ps` has been read. */
function runningSimulator(udid: string, uptimeSeconds: number) {
  return { platform: "ios" as const, deviceId: udid, pid: 101, pids: [101], uptimeSeconds };
}

const UDID_A = "A0A912ED-C766-4778-957C-F9680C7309F3";
const UDID_B = "1A9C8E3A-A8AC-4FAB-9286-D970E0F83945";
const UDID_C = "00000000-1111-2222-3333-444444444444";

const HEALTHY_MEMORY: SystemMemorySample = {
  totalPhysicalBytes: 64 * GIBIBYTE,
  swapTotalBytes: 21.5 * GIBIBYTE,
  swapUsedBytes: 1 * GIBIBYTE,
  availableBytes: 20 * GIBIBYTE,
};

// What the machine actually looked like when this feature was asked for.
const THRASHING_MEMORY: SystemMemorySample = {
  totalPhysicalBytes: 64 * GIBIBYTE,
  swapTotalBytes: 21.5 * GIBIBYTE,
  swapUsedBytes: 20.6 * GIBIBYTE,
  availableBytes: 0.4 * GIBIBYTE,
};

function createManager(
  options: {
    config?: DeviceLeaseConfig;
    rows?: ProcessSampleRow[];
    memory?: SystemMemorySample;
    agentIds?: string[];
    drainIntervalMs?: number;
    agents?: DeviceLeaseAgentSummary[];
    /** UDID → simulator name, as `simctl list` would report it. */
    simulatorNames?: Record<string, string>;
    /** AVD name → adb serial. */
    androidSerials?: Record<string, string>;
    /** Serials/UDIDs the physical detection currently sees connected. */
    physicalTargets?: string[];
    /** Makes every identity lookup take a turn of the event loop, like the real adb call. */
    slowIdentityLookup?: boolean;
    /** Replaces the fake shutdown command, e.g. with one that never settles (a wedged simctl). */
    shutdownExec?: () => Promise<void>;
  } = {},
) {
  const state = {
    config: options.config ?? { enabled: true },
    rows: options.rows ?? [],
    memory: options.memory ?? HEALTHY_MEMORY,
    agents:
      options.agents ??
      (options.agentIds ?? ["agent-1", "agent-2", "agent-3"]).map((agentId) => ({
        agentId,
        provider: "claude",
        isRunning: true,
      })),
    nowMs: 1_000_000,
  };
  let leaseCounter = 0;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sendSystemMessageToAgent = vi.fn(async () => undefined);
  const shutdownExec = vi.fn(options.shutdownExec ?? (async () => undefined));
  const androidSerial = vi.fn(async (avd: string, _options?: { fresh?: boolean }) => {
    if (options.slowIdentityLookup) await new Promise((resolve) => setTimeout(resolve, 5));
    return options.androidSerials?.[avd];
  });
  const manager = new DeviceLeaseManager({
    processSampler: {
      sampleProcesses: async () => state.rows,
      sampleSystemMemory: async () => state.memory,
    },
    readDaemonConfig: () => ({ deviceLeases: state.config }),
    listAgents: () => state.agents,
    sendSystemMessageToAgent,
    // Never shell out to real adb/xcrun in a unit test.
    identityLookup: {
      androidSerial,
      iosSimulatorName: async (udid: string) => {
        if (options.slowIdentityLookup) await new Promise((resolve) => setTimeout(resolve, 5));
        return options.simulatorNames?.[udid];
      },
    },
    isPhysicalDeviceTarget: (target: string) => options.physicalTargets?.includes(target) ?? false,
    shutdownRunner: { exec: shutdownExec },
    logger,
    now: () => state.nowMs,
    // An M3 Max: 3 total slots, 2 per platform.
    readHardware: async () => ({
      memoryBytes: 68_719_476_736,
      cpuCount: 16,
      performanceCpuCount: 12,
    }),
    sampleMaxAgeMs: 0,
    ...(options.drainIntervalMs === undefined ? {} : { drainIntervalMs: options.drainIntervalMs }),
    createLeaseId: () => `lease-${++leaseCounter}`,
  });
  return { manager, state, logger, sendSystemMessageToAgent, shutdownExec, androidSerial };
}

describe("DeviceLeaseManager", () => {
  test("does nothing at all while the cap is off", async () => {
    const { manager } = createManager({
      config: { enabled: false },
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B), simulatorRow(3, UDID_C)],
    });

    expect(await manager.checkout({ agentId: "agent-1", platform: "ios" })).toEqual({
      status: "disabled",
    });
    expect(
      await manager.gateLaunch({
        agentId: "agent-1",
        command: "xcrun simctl boot 'iPhone 17 Pro'",
      }),
    ).toEqual({ decision: "allow" });
  });

  test("lets a launch through and leases the slot it took", async () => {
    const { manager } = createManager();

    expect(
      await manager.gateLaunch({
        agentId: "agent-1",
        command: "xcrun simctl boot 'iPhone 17 Pro'",
      }),
    ).toEqual({ decision: "allow" });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.used).toBe(1);
    expect(snapshot.devices).toEqual([
      expect.objectContaining({
        platform: "ios",
        state: "starting",
        agentId: "agent-1",
        attribution: "lease",
        source: "launch",
      }),
    ]);
  });

  test("refuses a launch past the per-platform cap and says what to do instead", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B)],
    });

    const decision = await manager.gateLaunch({
      agentId: "agent-3",
      command: "xcrun simctl boot 'iPhone 17 Pro'",
    });

    expect(decision.decision).toBe("deny");
    const message = decision.decision === "deny" ? decision.message : "";
    expect(message).toContain("already running 2 ios devices");
    expect(message).toContain("device_checkout");
    expect(message).toContain("2 running without a lease");
    expect(message).toContain("Do not retry");
  });

  test("a device Tyler booted by hand fills a slot like any other", async () => {
    const { manager } = createManager({
      // Three simulators, none of them leased, none of them an agent's.
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B), simulatorRow(3, UDID_C)],
    });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.used).toBe(3);
    expect(snapshot.devices.every((device) => device.attribution === "none")).toBe(true);
    // ps's elapsed column is where "running for 2h14m" comes from without a lease.
    expect(snapshot.devices[0].heldForSeconds).toBe(8040);
    expect(
      await manager.gateLaunch({ agentId: "agent-1", command: "emulator -avd Pixel_7" }),
    ).toMatchObject({ decision: "deny" });
  });

  test("dry run reports the refusal and lets the launch through", async () => {
    const { manager, logger } = createManager({
      config: { enabled: true, dryRun: true },
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B)],
    });

    expect(
      await manager.gateLaunch({
        agentId: "agent-3",
        command: "xcrun simctl boot 'iPhone 17 Pro'",
      }),
    ).toEqual({ decision: "allow" });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.blocked).toEqual([
      expect.objectContaining({
        agentId: "agent-3",
        platform: "ios",
        command: "xcrun simctl boot",
        dryRun: true,
      }),
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
      "Device cap would have refused a device launch",
    );
  });

  test("the guaranteed floor allows the first device of a platform even with no headroom", async () => {
    const { manager } = createManager({ memory: THRASHING_MEMORY });

    const decision = await manager.gateLaunch({
      agentId: "agent-1",
      command: "xcrun simctl boot 'iPhone 17 Pro'",
    });

    expect(decision).toEqual({ decision: "allow" });
  });

  test("headroom still refuses a second device of the same platform", async () => {
    const { manager } = createManager({
      memory: THRASHING_MEMORY,
      rows: [simulatorRow(1, UDID_A)],
    });
    // The floor device is already running and held, so this boot targets a new one.
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });

    const decision = await manager.gateLaunch({
      agentId: "agent-2",
      command: `xcrun simctl boot ${UDID_B}`,
    });

    expect(decision.decision).toBe("deny");
    expect(decision.decision === "deny" && decision.message).toContain("swap is 96% used");
  });

  test("the floor is per platform: an iOS floor launch is allowed while Android is at 99% swap", async () => {
    const { manager } = createManager({
      memory: { ...THRASHING_MEMORY, swapUsedBytes: THRASHING_MEMORY.swapTotalBytes * 0.99 },
      rows: [emulatorRow(1, 0, "Pixel_7")],
    });
    await manager.checkout({ agentId: "agent-1", platform: "android", device: "Pixel_7" });

    const decision = await manager.gateLaunch({
      agentId: "agent-2",
      command: "xcrun simctl boot 'iPhone 17 Pro'",
    });

    expect(decision).toEqual({ decision: "allow" });
  });

  test("re-booting a device that is already up costs no slot", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B)],
    });

    expect(
      await manager.gateLaunch({ agentId: "agent-3", command: `xcrun simctl boot ${UDID_A}` }),
    ).toEqual({ decision: "allow" });
  });

  test("an agent that checked out first walks through the gate on its own lease", async () => {
    const { manager } = createManager();

    const checkout = await manager.checkout({
      agentId: "agent-1",
      platform: "ios",
      reason: "run the UI tests",
    });
    expect(checkout).toMatchObject({ status: "granted", leaseId: "lease-1" });

    expect(
      await manager.gateLaunch({
        agentId: "agent-1",
        command: "xcrun simctl boot 'iPhone 17 Pro'",
      }),
    ).toEqual({ decision: "allow" });
    // One lease, not two: the launch found the checkout instead of taking another slot.
    const snapshot = await manager.getSnapshot();
    expect(snapshot.used).toBe(1);
    expect(snapshot.devices[0].reason).toBe("run the UI tests");
  });

  test("tells an agent that will not wait exactly how full the machine is", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B)],
    });
    // Both already held, so there is nothing left for agent-3 to reuse.
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });
    await manager.checkout({ agentId: "agent-2", platform: "ios", device: UDID_B });

    expect(await manager.checkout({ agentId: "agent-3", platform: "ios" })).toEqual({
      status: "unavailable",
      platform: "ios",
      message: "the machine is already running 2 ios devices (2 of 3 slots in use)",
    });
  });

  test("queues an agent and grants the slot when a device stops", async () => {
    const { manager, state } = createManager({
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B)],
    });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });
    await manager.checkout({ agentId: "agent-2", platform: "ios", device: UDID_B });

    const pending = manager.checkout({ agentId: "agent-3", platform: "ios", wait: true });
    await vi.waitFor(async () => {
      expect((await manager.getSnapshot()).waiting).toEqual([
        expect.objectContaining({ agentId: "agent-3", platform: "ios" }),
      ]);
    });

    // One simulator shuts down; the next sweep hands the slot to whoever was waiting.
    state.rows = [simulatorRow(1, UDID_A)];
    await manager.reconcileFromSample({
      devices: [{ platform: "ios", deviceId: UDID_A, pid: 1, pids: [1], uptimeSeconds: 8040 }],
      systemMemory: HEALTHY_MEMORY,
    });

    expect(await pending).toMatchObject({ status: "granted", platform: "ios" });
    expect((await manager.getSnapshot()).waiting).toEqual([]);
  });

  test("check-in frees the slot for the next agent", async () => {
    const { manager } = createManager();

    const first = await manager.checkout({ agentId: "agent-1", platform: "android" });
    const second = await manager.checkout({ agentId: "agent-2", platform: "android" });
    expect(second.status).toBe("granted");
    // Both android slots are gone now.
    expect(await manager.checkout({ agentId: "agent-3", platform: "android" })).toMatchObject({
      status: "unavailable",
    });

    expect(await manager.checkin({ agentId: "agent-1" })).toBe(1);
    expect(first.status === "granted" && first.leaseId).toBe("lease-1");
    expect(await manager.checkout({ agentId: "agent-3", platform: "android" })).toMatchObject({
      status: "granted",
    });
  });

  test("a crashed agent's lease is reclaimed, and its device still counts", async () => {
    const { manager, state } = createManager({
      rows: [emulatorRow(10, 9, "Pixel_7")],
      agentIds: ["agent-1"],
    });
    // The agent owns the emulator through its process tree.
    await manager.reconcileFromSample({
      devices: [
        { platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10], agentId: "agent-1" },
      ],
      systemMemory: HEALTHY_MEMORY,
    });
    await manager.checkout({ agentId: "agent-1", platform: "android" });
    expect((await manager.getSnapshot()).devices[0]).toMatchObject({
      agentId: "agent-1",
      attribution: "lease",
    });

    // The agent dies. Its emulator does not.
    state.agents = [];
    await manager.reconcileFromSample({
      devices: [{ platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10] }],
      systemMemory: HEALTHY_MEMORY,
    });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices).toEqual([
      expect.objectContaining({ deviceId: "Pixel_7", attribution: "none" }),
    ]);
    // The lease is gone; the slot is not. Reclaiming a lease must never hide a running device.
    expect(snapshot.used).toBe(1);
  });

  test("a lease whose device never boots expires instead of holding a slot forever", async () => {
    const { manager, state } = createManager();

    await manager.checkout({ agentId: "agent-1", platform: "ios" });
    expect((await manager.getSnapshot()).used).toBe(1);

    state.nowMs += 26 * 60_000;
    expect((await manager.getSnapshot()).used).toBe(0);
  });

  test("a long native build keeps the slot it is building for", async () => {
    const { manager, state } = createManager();

    await manager.checkout({ agentId: "agent-1", platform: "ios", wait: false });

    // A cold `expo run:ios`: pods, then a native build, then the simulator.
    state.nowMs += 20 * 60_000;
    await manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:ios" });

    // Well past the TTL measured from checkout, but only 20 minutes into this build.
    state.nowMs += 20 * 60_000;
    expect((await manager.getSnapshot()).used).toBe(1);
  });

  test("restarting the build clock does not stop the device binding to the lease", async () => {
    const { manager, state } = createManager();

    await manager.checkout({ agentId: "agent-1", platform: "ios", wait: false });
    state.nowMs += 60_000;
    await manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:ios" });

    // The simulator this lease was waiting for boots 30s after that launch.
    state.nowMs += 60_000;
    state.rows = [simulatorRow(101, UDID_A, "00:30")];
    await manager.reconcileFromSample({
      devices: [runningSimulator(UDID_A, 30)],
      systemMemory: state.memory,
    });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.used).toBe(1);
    expect(snapshot.devices).toEqual([
      expect.objectContaining({ deviceId: UDID_A, attribution: "lease", agentId: "agent-1" }),
    ]);
  });

  test("a rebuild against the agent's own simulator does not take a second slot", async () => {
    const { manager, state } = createManager();

    await manager.checkout({ agentId: "agent-1", platform: "ios", wait: false });
    await manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:ios" });

    // The simulator boots and the sweep binds the lease to it.
    state.nowMs += 60_000;
    state.rows = [simulatorRow(101, UDID_A, "00:30")];
    await manager.reconcileFromSample({
      devices: [runningSimulator(UDID_A, 30)],
      systemMemory: state.memory,
    });
    expect((await manager.getSnapshot()).used).toBe(1);

    // Edit, rebuild, run again. A runner that names no device reuses the booted one, so this
    // costs no new slot — leasing a second one would count one simulator twice.
    state.nowMs += 120_000;
    expect(await manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:ios" })).toEqual({
      decision: "allow",
    });
    expect((await manager.getSnapshot()).used).toBe(1);
  });

  test("an agent iterating on one device does not fill its platform by itself", async () => {
    const { manager, state } = createManager();

    await manager.checkout({ agentId: "agent-1", platform: "ios", wait: false });
    await manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:ios" });
    state.nowMs += 60_000;
    state.rows = [simulatorRow(101, UDID_A, "00:30")];
    await manager.reconcileFromSample({
      devices: [runningSimulator(UDID_A, 30)],
      systemMemory: state.memory,
    });

    state.nowMs += 120_000;
    await manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:ios" });

    // One simulator is running and the machine allows two. agent-2 gets the other one.
    state.nowMs += 1_000;
    expect(
      (await manager.checkout({ agentId: "agent-2", platform: "ios", wait: false })).status,
    ).toBe("granted");
  });

  test("a queued agent is served when the device it was waiting on stops", async () => {
    const { manager, state } = createManager({
      rows: [simulatorRow(101, UDID_A), simulatorRow(102, UDID_B)],
      drainIntervalMs: 20,
    });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });
    await manager.checkout({ agentId: "agent-2", platform: "ios", device: UDID_B });

    const waiting = manager.checkout({ agentId: "agent-3", platform: "ios", wait: true });
    await vi.waitFor(async () => {
      expect((await manager.getSnapshot()).waiting).toHaveLength(1);
    });

    // A simulator shuts down. Nothing reports that, so only a fresh scan can notice it.
    state.rows = [simulatorRow(101, UDID_A)];
    state.nowMs += 6_000;

    expect((await waiting).status).toBe("granted");
  });
  test("a dry run reports the occupancy the real cap would have seen", async () => {
    const { manager } = createManager({ config: { enabled: true, dryRun: true } });

    // Three agents want an iOS slot on a machine that allows two. In a real run the first two
    // get leases and the third waits, holding nothing.
    for (const agentId of ["agent-1", "agent-2", "agent-3"]) {
      expect((await manager.checkout({ agentId, platform: "ios" })).status).toBe("granted");
    }

    const snapshot = await manager.getSnapshot();
    expect(snapshot.usedByPlatform.ios).toBe(2);
    // The readout still names all three holders; only the count is the real cap's.
    expect(snapshot.devices.map((device) => device.agentId)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
    ]);
  });

  test("a dry run's uncounted lease does not refuse the agent behind it", async () => {
    const { manager } = createManager({ config: { enabled: true, dryRun: true } });

    for (const agentId of ["agent-1", "agent-2", "agent-3"]) {
      await manager.checkout({ agentId, platform: "ios" });
    }

    // Nothing actually booted, so the cap would not have refused this launch either.
    const { blocked } = await manager.getSnapshot();
    expect(blocked).toEqual([]);
  });

  // A session answers every change by taking a snapshot. Snapshots that notified when nothing
  // changed re-entered that listener forever without yielding: the daemon spun at 100% and the
  // app sat on its loading screen (2026-09-19).
  test("a snapshot that changes nothing does not notify, so a listener that re-snapshots settles", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_A)],
    });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });

    let notifications = 0;
    const settled: Promise<unknown>[] = [];
    manager.subscribe(() => {
      notifications += 1;
      if (notifications > 50) throw new Error("device status listener re-entered without end");
      settled.push(manager.getSnapshot());
    });

    await manager.getSnapshot();
    await manager.getSnapshot();
    await Promise.all(settled);
    expect(notifications).toBe(0);

    // A real change still gets through, exactly once.
    await manager.checkin({ agentId: "agent-1" });
    await Promise.all(settled);
    expect(notifications).toBe(1);
  });
});

/**
 * The half of the cap that exists because not every provider can be refused
 * (device-launch-enforcement.ts). A Codex or Pi agent boots a device nothing stopped; the cap
 * still has to hold in aggregate, still has to say whose it is, and still must not touch it.
 */
describe("DeviceLeaseManager with a provider it cannot refuse", () => {
  const UNGUARDED_AGENTS = [
    { agentId: "agent-claude", provider: "claude", isRunning: true },
    { agentId: "agent-pi", provider: "pi", isRunning: true },
  ];

  test("an unleased device from an unguarded agent takes a slot from the guarded ones", async () => {
    const { manager } = createManager({
      agents: UNGUARDED_AGENTS,
      config: { enabled: true, totalSlots: 2, slotsPerPlatform: 2 },
    });

    // Pi boots two emulators. Nothing refused them; nobody checked them out.
    await manager.reconcileFromSample({
      devices: [
        { platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10], agentId: "agent-pi" },
        { platform: "android", deviceId: "Pixel_8", pid: 20, pids: [20], agentId: "agent-pi" },
      ],
      systemMemory: HEALTHY_MEMORY,
    });

    // The cap holds in aggregate: occupancy is the union of running devices and leases, so the
    // Claude agent is refused even though the slots went to an agent the cap could not refuse.
    const decision = await manager.gateLaunch({
      agentId: "agent-claude",
      command: "emulator -avd Pixel_9",
    });
    expect(decision.decision).toBe("deny");
    expect((await manager.getSnapshot()).used).toBe(2);
  });

  test("an unleased device is charged to the agent whose process tree owns it, once", async () => {
    const { manager, sendSystemMessageToAgent } = createManager({ agents: UNGUARDED_AGENTS });
    const sample = {
      devices: [
        {
          platform: "android" as const,
          deviceId: "Pixel_7",
          pid: 10,
          pids: [10],
          agentId: "agent-pi",
        },
      ],
      systemMemory: HEALTHY_MEMORY,
    };

    await manager.reconcileFromSample(sample);
    expect(sendSystemMessageToAgent).toHaveBeenCalledTimes(1);
    const [agentId, body] = sendSystemMessageToAgent.mock.calls[0] as unknown as [string, string];
    expect(agentId).toBe("agent-pi");
    expect(body).toContain("Pixel_7");
    expect(body).toContain("device_checkout");
    // It says the cap cannot refuse this agent rather than implying a gate that does not exist.
    expect(body).toContain("Nothing refuses your device launches");
    // And it promises not to do anything to the device, because a build may be running on it.
    expect(body).toContain("Nothing has been shut down");

    // The sweep runs every minute. The agent hears about one device once.
    await manager.reconcileFromSample(sample);
    await manager.reconcileFromSample(sample);
    expect(sendSystemMessageToAgent).toHaveBeenCalledTimes(1);
  });

  test("a second device is a second message, and a reboot is said again", async () => {
    const { manager, sendSystemMessageToAgent } = createManager({ agents: UNGUARDED_AGENTS });
    const pixel7 = {
      platform: "android" as const,
      deviceId: "Pixel_7",
      pid: 10,
      pids: [10],
      agentId: "agent-pi",
    };
    const pixel8 = { ...pixel7, deviceId: "Pixel_8", pid: 20, pids: [20] };

    await manager.reconcileFromSample({ devices: [pixel7], systemMemory: HEALTHY_MEMORY });
    await manager.reconcileFromSample({
      devices: [pixel7, pixel8],
      systemMemory: HEALTHY_MEMORY,
    });
    expect(sendSystemMessageToAgent).toHaveBeenCalledTimes(2);

    // Both stop, then Pixel_7 comes back. A new device is new news.
    await manager.reconcileFromSample({ devices: [], systemMemory: HEALTHY_MEMORY });
    await manager.reconcileFromSample({ devices: [pixel7], systemMemory: HEALTHY_MEMORY });
    expect(sendSystemMessageToAgent).toHaveBeenCalledTimes(3);
  });

  test("a device the agent checked out is not charged to it", async () => {
    const { manager, sendSystemMessageToAgent } = createManager({ agents: UNGUARDED_AGENTS });
    await manager.checkout({ agentId: "agent-pi", platform: "android" });

    await manager.reconcileFromSample({
      devices: [
        { platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10], agentId: "agent-pi" },
      ],
      systemMemory: HEALTHY_MEMORY,
    });

    expect(sendSystemMessageToAgent).not.toHaveBeenCalled();
  });

  test("an idle agent is not steered, and a dry run tells nobody", async () => {
    const idle = [{ agentId: "agent-pi", provider: "pi", isRunning: false }];
    const { manager: idleManager, sendSystemMessageToAgent: idleSend } = createManager({
      agents: idle,
    });
    await idleManager.reconcileFromSample({
      devices: [
        { platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10], agentId: "agent-pi" },
      ],
      systemMemory: HEALTHY_MEMORY,
    });
    // Steering an idle agent starts a turn of its own; it gets the UI and the log instead.
    expect(idleSend).not.toHaveBeenCalled();

    const { manager: dryManager, sendSystemMessageToAgent: drySend } = createManager({
      agents: UNGUARDED_AGENTS,
      config: { enabled: true, dryRun: true },
    });
    await dryManager.reconcileFromSample({
      devices: [
        { platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10], agentId: "agent-pi" },
      ],
      systemMemory: HEALTHY_MEMORY,
    });
    expect(drySend).not.toHaveBeenCalled();
  });

  test("an unleased simulator has no owner ps can name, so nobody is told and it still counts", async () => {
    const { manager, sendSystemMessageToAgent } = createManager({ agents: UNGUARDED_AGENTS });

    // launchd_sim is reparented to pid 1, so a simulator never sits in an agent's tree.
    await manager.reconcileFromSample({
      devices: [{ platform: "ios", deviceId: UDID_A, pid: 7, pids: [7], uptimeSeconds: 8_040 }],
      systemMemory: HEALTHY_MEMORY,
    });

    expect(sendSystemMessageToAgent).not.toHaveBeenCalled();
    const snapshot = await manager.getSnapshot();
    expect(snapshot.used).toBe(1);
    expect(snapshot.devices[0]).toMatchObject({ attribution: "none", heldForSeconds: 8_040 });
    // Nothing invents a holder for it. Unattributed pressure is reported as exactly that.
    expect(snapshot.devices[0]?.agentId).toBeUndefined();
  });

  test("nothing about an unleased device is killed, stopped or signalled", async () => {
    const { manager } = createManager({ agents: UNGUARDED_AGENTS });
    const sample = {
      devices: [
        {
          platform: "android" as const,
          deviceId: "Pixel_7",
          pid: 10,
          pids: [10],
          agentId: "agent-pi",
        },
      ],
      systemMemory: THRASHING_MEMORY,
    };

    await manager.reconcileFromSample(sample);
    // Even with the machine thrashing — the state this whole feature exists for — the device
    // survives every sweep. Reaping a booted device is a different, riskier feature.
    await manager.reconcileFromSample(sample);
    expect((await manager.getSnapshot()).devices).toEqual([
      expect.objectContaining({ deviceId: "Pixel_7" }),
    ]);
  });

  test("the snapshot says which of the live providers the cap cannot refuse", async () => {
    const { manager } = createManager({
      agents: [
        { agentId: "agent-claude", provider: "claude", isRunning: true },
        { agentId: "agent-codex", provider: "codex", isRunning: true },
        { agentId: "agent-pi", provider: "pi", isRunning: true },
        { agentId: "agent-pi-2", provider: "pi", isRunning: false },
      ],
    });

    const snapshot = await manager.getSnapshot();
    // Weakest first: what the cap cannot do is the part worth reading.
    expect(snapshot.enforcement).toEqual([
      expect.objectContaining({ provider: "pi", tier: "observes" }),
      expect.objectContaining({ provider: "codex", tier: "asks" }),
      expect.objectContaining({ provider: "claude", tier: "refuses" }),
    ]);
  });

  test("a device entry carries its holder's provider and tier", async () => {
    const { manager } = createManager({ agents: UNGUARDED_AGENTS });
    await manager.reconcileFromSample({
      devices: [
        { platform: "android", deviceId: "Pixel_7", pid: 10, pids: [10], agentId: "agent-pi" },
      ],
      systemMemory: HEALTHY_MEMORY,
    });

    // The sweep leases a device it finds in an agent's process tree to that agent.
    expect((await manager.getSnapshot()).devices[0]).toMatchObject({
      agentId: "agent-pi",
      attribution: "lease",
      provider: "pi",
      enforcement: "observes",
    });
  });
});

describe("DeviceLeaseManager reuse", () => {
  test("checkout binds to the device the caller names", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_A), simulatorRow(2, UDID_B)],
    });

    const result = await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_B });

    expect(result).toMatchObject({ status: "granted", device: { deviceId: UDID_B } });
    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices.find((d) => d.deviceId === UDID_B)).toMatchObject({
      agentId: "agent-1",
      attribution: "lease",
      state: "running",
    });
    // Only one running device was claimed — the other is still free.
    expect(snapshot.devices.find((d) => d.deviceId === UDID_A)?.agentId).toBeUndefined();
  });

  test("checkout binds to an unheld running device when none is named", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });

    const result = await manager.checkout({ agentId: "agent-1", platform: "ios" });

    expect(result).toMatchObject({ status: "granted", device: { deviceId: UDID_A } });
    // Binds immediately — no "starting" lease, so no never-started clock is running.
    expect((await manager.getSnapshot()).devices[0]).toMatchObject({
      deviceId: UDID_A,
      state: "running",
      agentId: "agent-1",
    });
  });

  test("a named device that isn't running allocates a new slot instead of reusing another one", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });

    const result = await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_C });

    // Granted a pending slot, not bound to UDID_A — the caller asked for a specific device.
    expect(result).toMatchObject({ status: "granted" });
    expect(result.status === "granted" && result.device).toBeUndefined();
    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices.find((d) => d.deviceId === UDID_A)?.agentId).toBeUndefined();
    expect(snapshot.devices.some((d) => d.state === "starting" && d.agentId === "agent-1")).toBe(
      true,
    );
  });

  test("checkout never binds to a device reserved for Tyler", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });
    manager.reserveDevice(UDID_A);

    const result = await manager.checkout({ agentId: "agent-1", platform: "ios" });

    // Nothing to reuse, so a new slot was allocated instead.
    expect(result).toMatchObject({ status: "granted" });
    expect(result.status === "granted" && result.device).toBeUndefined();
  });

  test("checkout explicitly naming a reserved device does not hand it over", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });
    manager.reserveDevice(UDID_A);

    const result = await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });

    expect(result.status === "granted" && result.device?.deviceId).not.toBe(UDID_A);
  });

  test("a reservation survives even though it does not evict a current holder", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });

    manager.reserveDevice(UDID_A);

    const entry = (await manager.getSnapshot()).devices.find((d) => d.deviceId === UDID_A);
    expect(entry).toMatchObject({ agentId: "agent-1", reserved: true });
  });

  test("unreserve makes the device eligible for reuse again", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });
    manager.reserveDevice(UDID_A);
    manager.unreserveDevice(UDID_A);

    const result = await manager.checkout({ agentId: "agent-1", platform: "ios" });

    expect(result).toMatchObject({ status: "granted", device: { deviceId: UDID_A } });
  });

  test("an untargeted runner uses the free running device: allowed, and the agent's lease binds to it", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });

    const decision = await manager.gateLaunch({
      agentId: "agent-1",
      command: "npx expo run:ios",
    });

    expect(decision).toEqual({ decision: "allow" });
    expect((await manager.getSnapshot()).devices).toEqual([
      expect.objectContaining({ deviceId: UDID_A, agentId: "agent-1", attribution: "lease" }),
    ]);
  });

  test("open -a Simulator and react-native run-android with a free device are allowed and bound", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_A), emulatorRow(2, 0, "yonderly_pixel")],
    });

    expect(await manager.gateLaunch({ agentId: "agent-1", command: "open -a Simulator" })).toEqual({
      decision: "allow",
    });
    expect(
      await manager.gateLaunch({ agentId: "agent-2", command: "npx react-native run-android" }),
    ).toEqual({ decision: "allow" });

    const devices = (await manager.getSnapshot()).devices;
    expect(devices.find((d) => d.deviceId === UDID_A)?.agentId).toBe("agent-1");
    expect(devices.find((d) => d.deviceId === "yonderly_pixel")?.agentId).toBe("agent-2");
  });

  test("dry run binds the reused device too and records no refusal", async () => {
    const { manager } = createManager({
      config: { enabled: true, dryRun: true },
      rows: [simulatorRow(1, UDID_A)],
    });

    expect(await manager.gateLaunch({ agentId: "agent-1", command: "expo run:ios" })).toEqual({
      decision: "allow",
    });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices[0]?.agentId).toBe("agent-1");
    expect(snapshot.blocked).toEqual([]);
  });

  test("an untargeted runner while every running device is held is allowed and takes no slot", async () => {
    const { manager } = createManager({
      config: { enabled: true, totalSlots: 1, slotsPerPlatform: 1 },
      rows: [simulatorRow(1, UDID_A)],
    });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });

    // It boots nothing — a device is already up — so the full cap is no reason to refuse it.
    expect(await manager.gateLaunch({ agentId: "agent-2", command: "npx expo run:ios" })).toEqual({
      decision: "allow",
    });
    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0]?.agentId).toBe("agent-1");
  });

  test("a runner naming a running simulator by name binds to it instead of taking a new slot", async () => {
    const { manager } = createManager({
      config: { enabled: true, totalSlots: 1, slotsPerPlatform: 1 },
      rows: [simulatorRow(1, UDID_A)],
      simulatorNames: { [UDID_A]: "iPhone 17 Pro" },
    });

    expect(
      await manager.gateLaunch({
        agentId: "agent-1",
        command: "npx expo run:ios --device 'iPhone 17 Pro'",
      }),
    ).toEqual({ decision: "allow" });
    expect((await manager.getSnapshot()).devices).toEqual([
      expect.objectContaining({ deviceId: UDID_A, agentId: "agent-1" }),
    ]);
  });

  test("a runner naming a connected physical device is left to the install gate", async () => {
    const { manager } = createManager({
      config: { enabled: true, totalSlots: 1, slotsPerPlatform: 1 },
      rows: [simulatorRow(1, UDID_A)],
      physicalTargets: ["00008000-00000000000FAKE1"],
    });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });

    expect(
      await manager.gateLaunch({
        agentId: "agent-2",
        command: "npx expo run:ios --device 00008000-00000000000FAKE1",
      }),
    ).toEqual({ decision: "allow" });
    expect((await manager.getSnapshot()).devices).toHaveLength(1);
  });

  test("a launch that names a device that is not running still goes through the cap", async () => {
    const { manager } = createManager({
      config: { enabled: true, totalSlots: 1, slotsPerPlatform: 1 },
      rows: [simulatorRow(1, UDID_A)],
    });

    const decision = await manager.gateLaunch({
      agentId: "agent-1",
      command: "xcrun simctl boot 'iPhone 17'",
    });

    expect(decision.decision).toBe("deny");
    // The refusal points at the free device it could have used instead.
    expect(decision.decision === "deny" && decision.message).toContain(UDID_A);
  });

  test("naming an already-running device in a launch still binds a lease to it", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_A)] });

    expect(
      await manager.gateLaunch({ agentId: "agent-1", command: `xcrun simctl boot ${UDID_A}` }),
    ).toEqual({ decision: "allow" });

    expect((await manager.getSnapshot()).devices[0]).toMatchObject({
      deviceId: UDID_A,
      agentId: "agent-1",
    });
  });
});

describe("DeviceLeaseManager shutdownDevice", () => {
  test("shuts down an iOS simulator nobody holds", async () => {
    const { manager, shutdownExec } = createManager({ rows: [simulatorRow(1, UDID_A)] });

    expect(await manager.shutdownDevice({ deviceId: UDID_A })).toEqual({ status: "shut-down" });
    expect(shutdownExec).toHaveBeenCalledWith("xcrun", ["simctl", "shutdown", UDID_A]);
  });

  test("fails closed for Android when no adb serial can be resolved", async () => {
    // createManager's identityLookup fake always resolves to undefined — the runner must never
    // be asked to guess a serial, since `adb -s <wrong serial> emu kill` kills someone else's.
    const { manager, shutdownExec } = createManager({
      rows: [emulatorRow(1, 0, "yonderly_pixel")],
    });

    const result = await manager.shutdownDevice({ deviceId: "yonderly_pixel" });

    expect(result).toMatchObject({ status: "failed" });
    expect(shutdownExec).not.toHaveBeenCalled();
  });

  test("shuts down an Android emulator by its resolved serial", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const exec = vi.fn(async () => undefined);
    const manager = new DeviceLeaseManager({
      processSampler: {
        sampleProcesses: async () => [emulatorRow(1, 0, "yonderly_pixel")],
        sampleSystemMemory: async () => HEALTHY_MEMORY,
      },
      readDaemonConfig: () => ({ deviceLeases: { enabled: true } }),
      listAgents: () => [],
      identityLookup: {
        androidSerial: async () => "emulator-5554",
        iosSimulatorName: async () => undefined,
      },
      shutdownRunner: { exec },
      logger,
      sampleMaxAgeMs: 0,
    });

    expect(await manager.shutdownDevice({ deviceId: "yonderly_pixel" })).toEqual({
      status: "shut-down",
    });
    expect(exec).toHaveBeenCalledWith("adb", ["-s", "emulator-5554", "emu", "kill"]);
  });

  test("reports not-running for a device that isn't up", async () => {
    const { manager } = createManager();

    expect(await manager.shutdownDevice({ deviceId: UDID_A })).toEqual({ status: "not-running" });
  });

  test("refuses a mid-turn holder's device without a second confirmation", async () => {
    const { manager, shutdownExec } = createManager({ rows: [simulatorRow(1, UDID_A)] });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });

    const result = await manager.shutdownDevice({ deviceId: UDID_A });

    expect(result.status).toBe("needs-confirmation");
    expect(shutdownExec).not.toHaveBeenCalled();
  });

  test("a second confirmation shuts down a mid-turn holder's device anyway", async () => {
    const { manager, shutdownExec } = createManager({ rows: [simulatorRow(1, UDID_A)] });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });

    const result = await manager.shutdownDevice({
      deviceId: UDID_A,
      confirmMidTurnHolder: true,
    });

    expect(result).toEqual({ status: "shut-down" });
    expect(shutdownExec).toHaveBeenCalledWith("xcrun", ["simctl", "shutdown", UDID_A]);
  });

  test("an idle (not mid-turn) holder needs no second confirmation", async () => {
    const { manager, shutdownExec } = createManager({
      rows: [simulatorRow(1, UDID_A)],
      agents: [{ agentId: "agent-1", provider: "claude", isRunning: false }],
    });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_A });

    expect(await manager.shutdownDevice({ deviceId: UDID_A })).toEqual({ status: "shut-down" });
    expect(shutdownExec).toHaveBeenCalled();
  });
});

/** A row under some parent: a shell, the command it runs, or a process inside a simulator. */
function childRow(pid: number, ppid: number, command: string): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb: 10_000, cpuPercent: 0, etime: "05:00", command };
}

/** One resource-monitor sweep over the harness's `ps` rows, handed over the way the monitor does. */
async function sweepRows(harness: ReturnType<typeof createManager>): Promise<void> {
  const { manager, state } = harness;
  const { agentTrees } = attributeProcessTrees(
    state.rows,
    state.agents.map((agent) => agent.agentId),
  );
  await manager.reconcileFromSample({
    devices: detectRunningDevices({ rows: state.rows, agentTrees }),
    systemMemory: state.memory,
    rows: state.rows,
    agentTrees,
  });
}

/**
 * A simulator the daemon saw the agent boot: a checkout with nothing running, then the device
 * appears a minute later (up 30 s, so after the lease) and the sweep binds the lease to it.
 */
async function checkOutAndBoot(
  harness: ReturnType<typeof createManager>,
  input: { agentId: string; udid: string; pid: number },
): Promise<void> {
  const { manager, state } = harness;
  const result = await manager.checkout({ agentId: input.agentId, platform: "ios" });
  expect(result.status).toBe("granted");
  state.nowMs += 60_000;
  state.rows = [...state.rows, simulatorRow(input.pid, input.udid, "00:30")];
  await sweepRows(harness);
}

const IDLE_HOLDER: DeviceLeaseAgentSummary = {
  agentId: "agent-1",
  provider: "claude",
  isRunning: false,
};

describe("DeviceLeaseManager agent-held simulator shutdown", () => {
  test("daemon shutdown shuts down a simulator an agent booted, leaving reserved and unleased ones alone", async () => {
    const harness = createManager();
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });
    // Booted after, so the checkout above could not reuse either. UDID_C stays unleased.
    harness.state.rows.push(simulatorRow(2, UDID_B), simulatorRow(3, UDID_C));
    harness.manager.reserveDevice(UDID_B);
    await sweepRows(harness);

    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();

    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);
    expect(harness.shutdownExec).toHaveBeenCalledWith("xcrun", ["simctl", "shutdown", UDID_A]);
  });

  test("a hand-booted simulator an agent reused is never shut down, at daemon shutdown or idle", async () => {
    const harness = createManager({ rows: [simulatorRow(1, UDID_A)], agents: [IDLE_HOLDER] });
    // Tyler booted UDID_A two hours ago; the agent checks it out by name and gets it reused.
    const result = await harness.manager.checkout({
      agentId: "agent-1",
      platform: "ios",
      device: UDID_A,
    });
    expect(result.status === "granted" && result.device?.deviceId).toBe(UDID_A);

    await sweepRows(harness);
    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);
    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();

    expect(harness.shutdownExec).not.toHaveBeenCalled();
  });

  test("a launch that names an already-running simulator binds a lease the teardown leaves alone", async () => {
    const harness = createManager({ rows: [simulatorRow(1, UDID_A)] });

    await harness.manager.gateLaunch({
      agentId: "agent-1",
      command: `npx expo run:ios --device ${UDID_A}`,
    });
    expect((await harness.manager.getSnapshot()).devices[0]).toMatchObject({
      deviceId: UDID_A,
      agentId: "agent-1",
      attribution: "lease",
    });
    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();

    expect(harness.shutdownExec).not.toHaveBeenCalled();
  });

  test("daemon shutdown releases the lease once the simulator is down", async () => {
    const harness = createManager();
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();
    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);

    // The lease is gone, so calling it again (e.g. a retried shutdown) finds nothing left to do.
    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();
    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);
  });

  test("a wedged simctl at daemon shutdown does not block past its own timeout, and leaves the lease alone", async () => {
    // Never settles: exactly a wedged `simctl`. The teardown must give up on it rather than
    // wait, and stop() bounds its own wait further (shutdown-budget.ts).
    const harness = createManager({ shutdownExec: () => new Promise<void>(() => undefined) });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });
    vi.useFakeTimers();
    try {
      let settled = false;
      const call = harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown().then(() => {
        settled = true;
        return undefined;
      });
      // device-lease-manager.ts's SIMULATOR_SHUTDOWN_TIMEOUT_MS.
      await vi.advanceTimersByTimeAsync(5_000);
      await call;

      expect(settled).toBe(true);
      expect(harness.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: UDID_A }),
        "Failed to shut down an agent-held simulator; leaving it for the OS to tear down",
      );
    } finally {
      vi.useRealTimers();
    }
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("the idle sweep shuts down a simulator nothing has used for 30 minutes", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });
    // The agent CLI and one of the simulator's own processes, which names its UDID in its path.
    // Neither is use: the root is no command, and the device's own tree is the device.
    harness.state.rows.push(
      agentRootRow(500, "agent-1"),
      childRow(
        901,
        900,
        `/usr/libexec/testmanagerd --device /CoreSimulator/Devices/${UDID_A}/data`,
      ),
    );
    await sweepRows(harness);
    expect(harness.shutdownExec).not.toHaveBeenCalled();

    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);

    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);
    expect(harness.shutdownExec).toHaveBeenCalledWith("xcrun", ["simctl", "shutdown", UDID_A]);
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: UDID_A, trigger: "idle-sweep" }),
      "Shut down an agent-held simulator",
    );
  });

  test("a holder idle only 10 minutes keeps its simulator", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 10 * 60_000;
    await sweepRows(harness);

    expect(harness.shutdownExec).not.toHaveBeenCalled();
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("a holder going back to running resets the idle clock", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 20 * 60_000;
    harness.state.agents = [{ ...IDLE_HOLDER, isRunning: true }];
    await sweepRows(harness);

    harness.state.nowMs += 20 * 60_000;
    harness.state.agents = [IDLE_HOLDER];
    await sweepRows(harness);

    // 40 minutes since the lease was bound, but only 20 since the holder was last running.
    expect(harness.shutdownExec).not.toHaveBeenCalled();
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("an idle holder's background xcodebuild test keeps its simulator until the run ends", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });
    // The agent started UI tests as a background shell and ended its turn to wait for them.
    const testRun = [
      agentRootRow(500, "agent-1"),
      childRow(501, 500, "/bin/zsh -c xcodebuild test -scheme App -destination 'name=iPhone 17'"),
      childRow(502, 501, "/usr/bin/xcodebuild test -scheme App -destination name=iPhone 17"),
    ];
    harness.state.rows.push(...testRun);
    await sweepRows(harness);

    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);
    expect(harness.shutdownExec).not.toHaveBeenCalled();

    // The run ends; the clock runs from the last sweep that saw it.
    harness.state.rows = harness.state.rows.filter((row) => row.pid !== 501 && row.pid !== 502);
    harness.state.nowMs += 29 * 60_000;
    await sweepRows(harness);
    expect(harness.shutdownExec).not.toHaveBeenCalled();
    harness.state.nowMs += 2 * 60_000;
    await sweepRows(harness);
    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);
  });

  test("another process naming the simulator's UDID keeps it, whoever runs it", async () => {
    // A child agent testing on its idle leader's simulator by id.
    const harness = createManager({
      agents: [IDLE_HOLDER, { agentId: "agent-2", provider: "claude", isRunning: false }],
    });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });
    harness.state.rows.push(
      agentRootRow(700, "agent-2"),
      childRow(701, 700, `/bin/zsh -c xcrun simctl spawn ${UDID_A} log stream`),
      childRow(702, 701, `xcrun simctl spawn ${UDID_A} log stream`),
    );
    await sweepRows(harness);

    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);

    expect(harness.shutdownExec).not.toHaveBeenCalled();
  });

  test("without the sweep's process rows the idle sweep shuts nothing down", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 31 * 60_000;
    await harness.manager.reconcileFromSample({
      devices: [runningSimulator(UDID_A, 60 + 31 * 60)],
      systemMemory: harness.state.memory,
    });

    expect(harness.shutdownExec).not.toHaveBeenCalled();
  });

  test("a reserved simulator is never shut down by the idle sweep even if somehow leased", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });
    harness.manager.reserveDevice(UDID_A);

    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);

    expect(harness.shutdownExec).not.toHaveBeenCalled();
  });
});

describe("DeviceLeaseManager simulator teardown config", () => {
  test("simulatorTeardown.enabled false leaves agent-booted simulators up at shutdown and idle", async () => {
    const harness = createManager({
      config: { enabled: true, simulatorTeardown: { enabled: false } },
      agents: [IDLE_HOLDER],
    });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);
    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();

    expect(harness.shutdownExec).not.toHaveBeenCalled();
  });

  test("simulatorTeardown.idleMinutes sets the idle window", async () => {
    const harness = createManager({
      config: { enabled: true, simulatorTeardown: { idleMinutes: 5 } },
      agents: [IDLE_HOLDER],
    });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 6 * 60_000;
    await sweepRows(harness);

    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);
  });

  test("the cap's dry run says what it would shut down and releases nothing", async () => {
    const harness = createManager({
      config: { enabled: true, dryRun: true },
      agents: [IDLE_HOLDER],
    });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 31 * 60_000;
    await sweepRows(harness);
    await harness.manager.shutdownAgentHeldSimulatorsForDaemonShutdown();

    expect(harness.shutdownExec).not.toHaveBeenCalled();
    const wouldLines = harness.logger.info.mock.calls.filter(
      ([, msg]) => msg === "Would shut down an agent-held simulator",
    );
    expect(wouldLines.map(([fields]) => fields)).toEqual([
      expect.objectContaining({ dryRun: true, deviceId: UDID_A, trigger: "idle-sweep" }),
      expect.objectContaining({ dryRun: true, deviceId: UDID_A, trigger: "daemon-shutdown" }),
    ]);
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("the mode line reports the teardown, and reports it off while the cap is off", () => {
    const harness = createManager({ config: { enabled: true, dryRun: true } });
    harness.manager.reportMode();
    harness.state.config = { enabled: false };
    harness.manager.reportMode();

    const modes = harness.logger.info.mock.calls
      .filter(([fields, msg]) => msg === "Monitor mode" && fields.monitor === "simulator-teardown")
      .map(([fields]) => fields);
    expect(modes).toEqual([
      { monitor: "simulator-teardown", enabled: true, dryRun: true },
      { monitor: "simulator-teardown", enabled: false, dryRun: false },
    ]);
  });
});

describe("DeviceLeaseManager idle release", () => {
  test("an emulator lease whose holder goes idle with no shell for 15 minutes is released, and the emulator keeps its slot", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    // Booted without checking out; adoptAttributedDevices leases it straight to the agent whose
    // tree it sits in.
    harness.state.rows = [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")];
    await sweepRows(harness);
    expect((await harness.manager.getSnapshot()).used).toBe(1);

    harness.state.nowMs += 15 * 60_000;
    await sweepRows(harness);

    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "android", deviceId: "pixel_a", reason: "idle" }),
      "Device slot released",
    );
    const snapshot = await harness.manager.getSnapshot();
    expect(snapshot.used).toBe(1);
    expect(snapshot.devices[0]).toMatchObject({ deviceId: "pixel_a", attribution: "process" });
  });

  test("a holder mid-turn keeps its emulator lease past 15 minutes", async () => {
    const harness = createManager({ agents: [{ ...IDLE_HOLDER, isRunning: true }] });
    harness.state.rows = [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")];
    await sweepRows(harness);

    harness.state.nowMs += 20 * 60_000;
    await sweepRows(harness);

    expect(harness.logger.info.mock.calls.some(([, msg]) => msg === "Device slot released")).toBe(
      false,
    );
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("a live background shell (a Gradle build) keeps the lease past 15 minutes", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    harness.state.rows = [
      agentRootRow(500, "agent-1"),
      emulatorRow(501, 500, "pixel_a"),
      childRow(502, 500, "/bin/zsh -c ./gradlew assembleDebug"),
    ];
    await sweepRows(harness);

    harness.state.nowMs += 20 * 60_000;
    await sweepRows(harness);

    expect(harness.logger.info.mock.calls.some(([, msg]) => msg === "Device slot released")).toBe(
      false,
    );
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("another process naming the device's id keeps the lease", async () => {
    const harness = createManager({
      agents: [IDLE_HOLDER, { agentId: "agent-2", provider: "claude", isRunning: false }],
    });
    harness.state.rows = [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "fake_pixel_a")];
    await sweepRows(harness);

    harness.state.rows.push(
      agentRootRow(700, "agent-2"),
      childRow(701, 700, "/bin/zsh -c adb -s fake_pixel_a logcat"),
      childRow(702, 701, "adb -s fake_pixel_a logcat"),
    );
    harness.state.nowMs += 20 * 60_000;
    await sweepRows(harness);

    expect(harness.logger.info.mock.calls.some(([, msg]) => msg === "Device slot released")).toBe(
      false,
    );
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("a booted: true simulator lease is never idle-released; the teardown still shuts it down at its own limit", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    await checkOutAndBoot(harness, { agentId: "agent-1", udid: UDID_A, pid: 900 });

    harness.state.nowMs += 16 * 60_000;
    await sweepRows(harness);
    expect(
      harness.logger.info.mock.calls.some(
        ([fields, msg]) => msg === "Device slot released" && fields.reason === "idle",
      ),
    ).toBe(false);
    expect((await harness.manager.getSnapshot()).used).toBe(1);

    // Past the teardown's own 30-minute idle limit, it shuts the simulator down instead.
    harness.state.nowMs += 15 * 60_000;
    await sweepRows(harness);
    expect(harness.shutdownExec).toHaveBeenCalledTimes(1);
  });

  test("a checkout decision resets the clock", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER], rows: [simulatorRow(1, UDID_A)] });
    const first = await harness.manager.checkout({
      agentId: "agent-1",
      platform: "ios",
      device: UDID_A,
    });
    expect(first.status).toBe("granted");
    await sweepRows(harness);

    harness.state.nowMs += 10 * 60_000;
    const again = await harness.manager.checkout({
      agentId: "agent-1",
      platform: "ios",
      device: UDID_A,
    });
    expect(again.status).toBe("granted");

    harness.state.nowMs += 10 * 60_000;
    await sweepRows(harness);
    // 20 minutes since the lease was taken, but only 10 since the last checkout touched it.
    expect(
      harness.logger.info.mock.calls.some(
        ([fields, msg]) => msg === "Device slot released" && fields.reason === "idle",
      ),
    ).toBe(false);
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("a launch-gate decision resets the clock", async () => {
    const harness = createManager({ agents: [IDLE_HOLDER] });
    harness.state.rows = [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")];
    await sweepRows(harness);

    harness.state.nowMs += 10 * 60_000;
    await harness.manager.gateLaunch({
      agentId: "agent-1",
      command: "npx expo run:android",
    });

    harness.state.nowMs += 10 * 60_000;
    await sweepRows(harness);
    expect(
      harness.logger.info.mock.calls.some(
        ([fields, msg]) => msg === "Device slot released" && fields.reason === "idle",
      ),
    ).toBe(false);
  });

  test("idleReleaseMinutes: 0 turns it off", async () => {
    const harness = createManager({
      config: { enabled: true, idleReleaseMinutes: 0 },
      agents: [IDLE_HOLDER],
    });
    harness.state.rows = [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")];
    await sweepRows(harness);

    harness.state.nowMs += 60 * 60_000;
    await sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(
        ([fields, msg]) => msg === "Device slot released" && fields.reason === "idle",
      ),
    ).toBe(false);
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });

  test("dry run logs and keeps the lease", async () => {
    const harness = createManager({
      config: { enabled: true, dryRun: true },
      agents: [IDLE_HOLDER],
    });
    harness.state.rows = [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")];
    await sweepRows(harness);

    harness.state.nowMs += 15 * 60_000;
    await sweepRows(harness);

    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, deviceId: "pixel_a" }),
      "Would release an idle device lease",
    );
    expect((await harness.manager.getSnapshot()).used).toBe(1);
  });
});

describe("DeviceLeaseManager refreshSnapshot", () => {
  test("notifies subscribers without needing a lease or config change", () => {
    const { manager } = createManager();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.refreshSnapshot();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a subsequent getSnapshot reflects a config edit made since the last push", async () => {
    const { manager, state } = createManager({ config: { enabled: true, dryRun: false } });
    expect((await manager.getSnapshot()).dryRun).toBe(false);

    state.config = { enabled: true, dryRun: true };
    const listener = vi.fn();
    manager.subscribe(listener);
    manager.refreshSnapshot();

    expect(listener).toHaveBeenCalledTimes(1);
    expect((await manager.getSnapshot()).dryRun).toBe(true);
  });
});

/** A Claude agent's root process, the way process attribution finds it in `ps`. */
function agentRootRow(pid: number, agentId: string): ProcessSampleRow {
  return {
    pid,
    ppid: 1,
    uid: 501,
    rssKb: 100_000,
    cpuPercent: 1,
    etime: "10:00",
    command: `claude --mcp-config {"url":"http://127.0.0.1:6767/mcp?callerAgentId=${agentId}"}`,
  };
}

describe("DeviceLeaseManager never hands a live agent's device to another", () => {
  test("an emulator in a running agent's process tree is not reused by another agent's checkout", async () => {
    const { manager } = createManager({
      rows: [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")],
    });

    const result = await manager.checkout({ agentId: "agent-2", platform: "android" });

    expect(result.status === "granted" && result.device).toBeUndefined();
    const pixel = (await manager.getSnapshot()).devices.find((d) => d.deviceId === "pixel_a");
    expect(pixel?.agentId).toBe("agent-1");
  });

  test("an untargeted runner from another agent is allowed but never bound to it", async () => {
    const { manager } = createManager({
      rows: [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")],
    });

    expect(
      await manager.gateLaunch({ agentId: "agent-2", command: "npx expo run:android" }),
    ).toEqual({ decision: "allow" });
    const pixel = (await manager.getSnapshot()).devices.find((d) => d.deviceId === "pixel_a");
    expect(pixel?.agentId).toBe("agent-1");
  });

  test("the sweep leases a process-attributed device to its agent, so it shows as held", async () => {
    const { manager } = createManager({
      rows: [agentRootRow(500, "agent-1"), emulatorRow(501, 500, "pixel_a")],
    });
    const sample = await manager.getSnapshot();
    expect(sample.devices[0]).toMatchObject({ attribution: "process", agentId: "agent-1" });

    await manager.reconcileFromSample({
      devices: [
        {
          platform: "android",
          deviceId: "pixel_a",
          pid: 501,
          pids: [501],
          agentId: "agent-1",
        },
      ],
      systemMemory: HEALTHY_MEMORY,
    });

    // Process attribution is lost the moment the agent's shell exits and the emulator is
    // reparented; the lease is what keeps the device held after that.
    expect(manager.listLeasedDeviceIds()).toEqual(["pixel_a"]);
  });
});

describe("DeviceLeaseManager concurrent launches", () => {
  test("two concurrent untargeted launches never both get the same device", async () => {
    const { manager } = createManager({
      rows: [emulatorRow(1, 0, "pixel_a")],
      androidSerials: { pixel_a: "emulator-5554" },
      slowIdentityLookup: true,
    });

    await Promise.all([
      manager.gateLaunch({ agentId: "agent-1", command: "npx expo run:android" }),
      manager.gateLaunch({ agentId: "agent-2", command: "npx expo run:android" }),
    ]);

    const holders = (await manager.getSnapshot()).devices
      .filter((d) => d.deviceId === "pixel_a")
      .map((d) => d.agentId);
    expect(holders).toHaveLength(1);
    expect(manager.listLeasedDeviceIds()).toEqual(["pixel_a"]);
  });

  test("two concurrent checkouts never both get the same device", async () => {
    const { manager } = createManager({
      rows: [emulatorRow(1, 0, "pixel_a")],
      androidSerials: { pixel_a: "emulator-5554" },
      slowIdentityLookup: true,
    });

    const results = await Promise.all([
      manager.checkout({ agentId: "agent-1", platform: "android" }),
      manager.checkout({ agentId: "agent-2", platform: "android" }),
    ]);

    const bound = results.filter((result) => result.status === "granted" && result.device);
    expect(bound).toHaveLength(1);
    expect(manager.listLeasedDeviceIds()).toEqual(["pixel_a"]);
  });
});

describe("DeviceLeaseManager checkout naming a busy device", () => {
  test("a named device another agent holds is reported busy, not swapped for a new slot", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_C)] });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_C });

    const result = await manager.checkout({
      agentId: "agent-2",
      platform: "ios",
      device: UDID_C,
      wait: false,
    });

    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.status === "unavailable" && result.message).toContain("agent-1");
    expect(manager.listLeasedDeviceIds()).toEqual([UDID_C]);
    expect((await manager.getSnapshot()).devices).toHaveLength(1);
  });

  test("a named device reserved for Tyler is reported reserved", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_C)] });
    manager.reserveDevice(UDID_C);

    const result = await manager.checkout({ agentId: "agent-2", platform: "ios", device: UDID_C });

    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.status === "unavailable" && result.message).toMatch(/reserved/i);
    expect((await manager.getSnapshot()).devices).toHaveLength(1);
  });

  test("waiting on a named busy device grants that device once its holder checks in", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_C)], drainIntervalMs: 60_000 });
    await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_C });

    const pending = manager.checkout({
      agentId: "agent-2",
      platform: "ios",
      device: UDID_C,
      wait: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.checkin({ agentId: "agent-1" });

    expect(await pending).toMatchObject({ status: "granted", device: { deviceId: UDID_C } });
    const entry = (await manager.getSnapshot()).devices.find((d) => d.deviceId === UDID_C);
    expect(entry?.agentId).toBe("agent-2");
  });

  test("naming a device the caller already holds returns its existing lease", async () => {
    const { manager } = createManager({ rows: [simulatorRow(1, UDID_C)] });
    const first = await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_C });

    const again = await manager.checkout({ agentId: "agent-1", platform: "ios", device: UDID_C });

    expect(again).toMatchObject({ status: "granted", device: { deviceId: UDID_C } });
    expect(first.status === "granted" && again.status === "granted" && again.leaseId).toBe(
      first.status === "granted" && first.leaseId,
    );
    expect((await manager.getSnapshot()).devices).toHaveLength(1);
  });
});

describe("DeviceLeaseManager device names", () => {
  test("a simulator's status entry carries its simctl name", async () => {
    const { manager } = createManager({
      rows: [simulatorRow(1, UDID_C)],
      simulatorNames: { [UDID_C]: "iPhone 17 Pro" },
    });

    expect((await manager.getSnapshot()).devices[0]).toMatchObject({
      deviceId: UDID_C,
      name: "iPhone 17 Pro",
    });
  });

  test("shut down re-resolves the emulator's adb serial rather than trusting a cache", async () => {
    const { manager, shutdownExec, androidSerial } = createManager({
      rows: [emulatorRow(1, 0, "pixel_a")],
      androidSerials: { pixel_a: "emulator-5556" },
    });

    expect(await manager.shutdownDevice({ deviceId: "pixel_a" })).toEqual({ status: "shut-down" });
    expect(androidSerial).toHaveBeenCalledWith("pixel_a", { fresh: true });
    expect(shutdownExec).toHaveBeenCalledWith("adb", ["-s", "emulator-5556", "emu", "kill"]);
  });
});
