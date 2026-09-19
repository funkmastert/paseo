import { describe, expect, test, vi } from "vitest";
import { DeviceLeaseManager, type DeviceLeaseConfig } from "./device-lease-manager.js";
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
  } = {},
) {
  const state = {
    config: options.config ?? { enabled: true },
    rows: options.rows ?? [],
    memory: options.memory ?? HEALTHY_MEMORY,
    agentIds: options.agentIds ?? ["agent-1", "agent-2", "agent-3"],
    nowMs: 1_000_000,
  };
  let leaseCounter = 0;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const manager = new DeviceLeaseManager({
    processSampler: {
      sampleProcesses: async () => state.rows,
      sampleSystemMemory: async () => state.memory,
    },
    readDaemonConfig: () => ({ deviceLeases: state.config }),
    listAgentIds: () => state.agentIds,
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
  return { manager, state, logger };
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

  test("refuses when the machine has no memory headroom, with a slot free", async () => {
    const { manager } = createManager({ memory: THRASHING_MEMORY });

    const decision = await manager.gateLaunch({
      agentId: "agent-1",
      command: "xcrun simctl boot 'iPhone 17 Pro'",
    });

    expect(decision.decision).toBe("deny");
    expect(decision.decision === "deny" && decision.message).toContain("swap is 96% used");
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
    state.agentIds = [];
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
});
