import { describe, expect, test, vi } from "vitest";
import { createComposedDeviceLaunchGate } from "./device-gate-composition.js";
import { DeviceLeaseManager, type DeviceLeaseAgentSummary } from "./device-lease-manager.js";
import { PhysicalDeviceLeaseManager } from "./physical-device-lease-manager.js";
import type { PhysicalDevice } from "./physical-device-registry.js";
import type { ProcessSampleRow, SystemMemorySample } from "./process-sampler.js";

const GIBIBYTE = 1024 ** 3;

const HEALTHY_MEMORY: SystemMemorySample = {
  totalPhysicalBytes: 64 * GIBIBYTE,
  swapTotalBytes: 21.5 * GIBIBYTE,
  swapUsedBytes: 1 * GIBIBYTE,
  availableBytes: 20 * GIBIBYTE,
};

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

function androidPhone(id: string): PhysicalDevice {
  return { id, platform: "android", transport: "usb" };
}

/**
 * Wires the real `DeviceLeaseManager` and `PhysicalDeviceLeaseManager` the way `bootstrap.ts`
 * does — sharing one `deviceLeases` config and reservation store, each told how many devices
 * the OTHER registry has (the `countAndroidEmulators` / `countPhysicalAndroidDevices` mirror
 * pair) — then composes them through `createComposedDeviceLaunchGate`. The emulator cap's own
 * `gateLaunch` stands in for `bootstrap.ts`'s artifact-janitor-wrapped `emulatorLaunchGate`: the
 * janitor is a separate layer outside this composition, covered by
 * test-artifact-launch-gate.test.ts.
 */
function createComposition(
  options: {
    config?: { enabled?: boolean; dryRun?: boolean };
    rows?: ProcessSampleRow[];
    physicalDevices?: PhysicalDevice[];
    agents?: DeviceLeaseAgentSummary[];
  } = {},
) {
  const state = {
    config: { enabled: true, ...options.config },
    rows: options.rows ?? [],
    physicalDevices: options.physicalDevices ?? [],
    agents: options.agents ?? [
      { agentId: "agent-1", provider: "claude", isRunning: true },
      { agentId: "agent-2", provider: "claude", isRunning: true },
    ],
    nowMs: 1_000_000,
  };
  const reserved = new Set<string>();
  const reservations = {
    reservedDeviceIds: () => reserved as ReadonlySet<string>,
    isReserved: (deviceId: string) => reserved.has(deviceId),
    reserve: (deviceId: string) => reserved.add(deviceId),
    unreserve: (deviceId: string) => reserved.delete(deviceId),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  let leaseCounter = 0;

  const deviceLeaseManager = new DeviceLeaseManager({
    processSampler: {
      sampleProcesses: async () => state.rows,
      sampleSystemMemory: async () => HEALTHY_MEMORY,
    },
    readDaemonConfig: () => ({ deviceLeases: state.config }),
    listAgents: () => state.agents,
    reservations,
    identityLookup: {
      androidSerial: async () => undefined,
      iosSimulatorName: async () => undefined,
    },
    logger,
    now: () => state.nowMs,
    readHardware: async () => ({
      memoryBytes: 68_719_476_736,
      cpuCount: 16,
      performanceCpuCount: 12,
    }),
    sampleMaxAgeMs: 0,
    createLeaseId: () => `emulator-lease-${++leaseCounter}`,
    countPhysicalAndroidDevices: () =>
      state.physicalDevices.filter((device) => device.platform === "android").length,
  });

  const physicalDeviceLeaseManager = new PhysicalDeviceLeaseManager({
    listConnectedDevices: () => state.physicalDevices,
    countAndroidEmulators: () =>
      state.rows.filter((row) => row.command.includes("/emulator ")).length,
    listAgents: () => state.agents,
    reservations,
    readDaemonConfig: () => ({ deviceLeases: state.config }),
    logger,
    now: () => state.nowMs,
    createLeaseId: () => `physical-lease-${++leaseCounter}`,
  });

  const gate = createComposedDeviceLaunchGate({
    bootGate: deviceLeaseManager,
    emulatorInstallGate: deviceLeaseManager,
    physicalInstallGate: physicalDeviceLeaseManager,
  });

  return { gate, deviceLeaseManager, physicalDeviceLeaseManager, state };
}

describe("createComposedDeviceLaunchGate", () => {
  test("runs boot, then emulator install, then physical install, in that order", async () => {
    const { gate, deviceLeaseManager, physicalDeviceLeaseManager } = createComposition();
    const bootSpy = vi.spyOn(deviceLeaseManager, "gateLaunch");
    const emulatorInstallSpy = vi.spyOn(deviceLeaseManager, "gateInstall");
    const physicalInstallSpy = vi.spyOn(physicalDeviceLeaseManager, "gateInstall");

    await gate.gateLaunch({ agentId: "agent-1", command: "adb devices" });

    const bootOrder = bootSpy.mock.invocationCallOrder[0] as number;
    const emulatorOrder = emulatorInstallSpy.mock.invocationCallOrder[0] as number;
    const physicalOrder = physicalInstallSpy.mock.invocationCallOrder[0] as number;
    expect(bootOrder).toBeLessThan(emulatorOrder);
    expect(emulatorOrder).toBeLessThan(physicalOrder);
  });

  test("a refusal from the emulator install gate wins, and the physical gate is never consulted", async () => {
    const { gate, deviceLeaseManager, physicalDeviceLeaseManager } = createComposition({
      rows: [emulatorRow(501, 999, "emulator-5554")],
    });
    await deviceLeaseManager.checkout({
      agentId: "agent-2",
      platform: "android",
      device: "emulator-5554",
    });
    const physicalInstallSpy = vi.spyOn(physicalDeviceLeaseManager, "gateInstall");

    const decision = await gate.gateLaunch({
      agentId: "agent-1",
      command: "adb -s emulator-5554 install app.apk",
    });

    expect(decision.decision).toBe("deny");
    const message = decision.decision === "deny" ? decision.message : "";
    expect(message).toContain("agent-2");
    expect(physicalInstallSpy).not.toHaveBeenCalled();
  });

  test("a refusal from the physical install gate wins over the emulator gate's allow", async () => {
    const phone = androidPhone("FAKE-PHONE-SERIAL-0001");
    const { gate, physicalDeviceLeaseManager } = createComposition({ physicalDevices: [phone] });
    await physicalDeviceLeaseManager.checkout({
      agentId: "agent-2",
      platform: "android",
      device: phone.id,
    });

    const decision = await gate.gateLaunch({
      agentId: "agent-1",
      command: `adb -s ${phone.id} install app.apk`,
    });

    expect(decision.decision).toBe("deny");
    const message = decision.decision === "deny" ? decision.message : "";
    expect(message).toContain("agent-2");
  });

  test("a command naming a physical device, which the emulator gate never matches, still reaches the physical gate", async () => {
    const phone = androidPhone("FAKE-PHONE-SERIAL-0003");
    const { gate, deviceLeaseManager, physicalDeviceLeaseManager } = createComposition({
      physicalDevices: [phone],
    });
    await physicalDeviceLeaseManager.checkout({
      agentId: "agent-2",
      platform: "android",
      device: phone.id,
    });
    const emulatorInstallSpy = vi.spyOn(deviceLeaseManager, "gateInstall");

    const decision = await gate.gateLaunch({
      agentId: "agent-1",
      command: `adb -s ${phone.id} install app.apk`,
    });

    // The emulator gate ran (every command passes through it) but had nothing to protect — no
    // running device named this target — so it allowed, and the physical gate made the call.
    const emulatorResult = await emulatorInstallSpy.mock.results[0]?.value;
    expect(emulatorResult).toEqual({ decision: "allow" });
    expect(decision.decision).toBe("deny");
  });

  test("dry run records the refusal without denying", async () => {
    const { gate, deviceLeaseManager } = createComposition({
      config: { enabled: true, dryRun: true },
      rows: [emulatorRow(501, 999, "emulator-5555")],
    });
    await deviceLeaseManager.checkout({
      agentId: "agent-2",
      platform: "android",
      device: "emulator-5555",
    });

    const decision = await gate.gateLaunch({
      agentId: "agent-1",
      command: "adb -s emulator-5555 install app.apk",
    });

    expect(decision).toEqual({ decision: "allow" });
    const snapshot = await deviceLeaseManager.getSnapshot();
    expect(snapshot.blocked).toEqual([
      expect.objectContaining({ agentId: "agent-1", dryRun: true }),
    ]);
  });

  test("a plain ambiguous adb install (a phone plus a running emulator) is allowed by both gates", async () => {
    const phone = androidPhone("FAKE-PHONE-SERIAL-0002");
    const { gate } = createComposition({
      rows: [emulatorRow(501, 999, "emulator-5556")],
      physicalDevices: [phone],
    });

    const decision = await gate.gateLaunch({ agentId: "agent-1", command: "adb install app.apk" });

    expect(decision).toEqual({ decision: "allow" });
  });
});
