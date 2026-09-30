import { describe, expect, test, vi } from "vitest";
import { PhysicalDeviceLeaseManager } from "./physical-device-lease-manager.js";
import type { PhysicalDevice } from "./physical-device-registry.js";

const MINUTE = 60_000;

function createManager(
  options: {
    devices?: PhysicalDevice[];
    enabled?: boolean;
    dryRun?: boolean;
    agentIds?: string[];
    reservedIds?: string[];
  } = {},
) {
  const state = {
    devices: options.devices ?? [],
    config: { enabled: options.enabled ?? true, dryRun: options.dryRun ?? false },
    agents: (options.agentIds ?? ["agent-1", "agent-2"]).map((agentId) => ({
      agentId,
      provider: "claude",
      isRunning: true,
    })),
    nowMs: 1_000_000,
    reserved: new Set(options.reservedIds ?? []),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  let leaseCounter = 0;
  const manager = new PhysicalDeviceLeaseManager({
    listConnectedDevices: () => state.devices,
    listAgents: () => state.agents,
    reservations: {
      reservedDeviceIds: () => state.reserved,
      isReserved: (deviceId) => state.reserved.has(deviceId),
    },
    readDaemonConfig: () => ({ deviceLeases: state.config }),
    logger,
    now: () => state.nowMs,
    createLeaseId: () => `physical-lease-${++leaseCounter}`,
  });
  return { manager, state, logger };
}

const USB_PIXEL: PhysicalDevice = {
  id: "FAKESERIAL0001",
  platform: "android",
  name: "Fake Pixel",
  transport: "usb",
};
const NETWORK_IPHONE: PhysicalDevice = {
  id: "00000000-000FAKE00E0001",
  platform: "ios",
  name: "Fake iPhone",
  transport: "network",
};

describe("PhysicalDeviceLeaseManager checkout", () => {
  test("disabled: reports disabled and never leases", async () => {
    const { manager } = createManager({ enabled: false, devices: [USB_PIXEL] });
    expect(await manager.checkout({ agentId: "agent-1", platform: "android" })).toEqual({
      status: "disabled",
    });
  });

  test("binds to the only free connected device of the platform", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    const result = await manager.checkout({ agentId: "agent-1", platform: "android" });
    expect(result).toMatchObject({
      status: "granted",
      platform: "android",
      device: { id: "FAKESERIAL0001", transport: "usb" },
    });
    expect(result.status === "granted" && result.device.targetHint).toContain("FAKESERIAL0001");
  });

  test("binds to a device named explicitly", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL, NETWORK_IPHONE] });
    const result = await manager.checkout({
      agentId: "agent-1",
      platform: "ios",
      device: NETWORK_IPHONE.id,
    });
    expect(result).toMatchObject({ status: "granted", device: { id: NETWORK_IPHONE.id } });
  });

  test("unavailable when nothing of the platform is connected", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    const result = await manager.checkout({ agentId: "agent-1", platform: "ios" });
    expect(result).toMatchObject({ status: "unavailable", platform: "ios" });
  });

  test("never binds a reserved device", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL], reservedIds: [USB_PIXEL.id] });
    const result = await manager.checkout({ agentId: "agent-1", platform: "android" });
    expect(result.status).toBe("unavailable");
  });

  test("a device already held by another agent is not handed out again", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });
    const result = await manager.checkout({ agentId: "agent-2", platform: "android" });
    expect(result.status).toBe("unavailable");
  });

  test("checkin frees the device for the next agent", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });
    expect(await manager.checkin({ agentId: "agent-1" })).toBe(1);
    const result = await manager.checkout({ agentId: "agent-2", platform: "android" });
    expect(result.status).toBe("granted");
  });
});

describe("PhysicalDeviceLeaseManager grace period and reconciliation", () => {
  test("a disconnected device keeps its holder inside the grace period, snapshot shows the countdown", async () => {
    const { manager, state } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    state.devices = [];
    state.nowMs += 10 * MINUTE;
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry).toMatchObject({ agentId: "agent-1", connected: false });
    expect(entry?.graceRemainingSeconds).toBeGreaterThan(0);
  });

  test("a device gone past the grace period releases the lease", async () => {
    const { manager, state } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    state.devices = [];
    // The grace clock starts at the sweep that first notices the disconnect, not retroactively
    // at the real disconnect time — so it takes two sweeps spanning the window to expire it,
    // same as the emulator cap's pendingTtlMinutes.
    await manager.getSnapshot();
    state.nowMs += 31 * MINUTE;
    await manager.getSnapshot();

    // Reconnected (perhaps a different cable, perhaps a different phone) — the lease should
    // already be gone from the grace-period expiry above, not from this reconnect.
    state.devices = [USB_PIXEL];
    const result = await manager.checkout({ agentId: "agent-2", platform: "android" });
    expect(result.status).toBe("granted");
  });

  test("reconnecting within the grace period keeps the same holder", async () => {
    const { manager, state } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    state.devices = [];
    state.nowMs += 10 * MINUTE;
    await manager.getSnapshot();
    state.devices = [USB_PIXEL];
    state.nowMs += 10 * MINUTE;

    const result = await manager.checkout({ agentId: "agent-2", platform: "android" });
    expect(result.status).toBe("unavailable");
  });
});

describe("PhysicalDeviceLeaseManager gateInstall", () => {
  test("installs to a free device lease it to the agent and allow", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    expect(decision).toEqual({ decision: "allow" });
    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices.find((d) => d.id === USB_PIXEL.id)?.agentId).toBe("agent-1");
  });

  test("installs to a device another agent holds is refused", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-2",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    expect(decision.decision).toBe("deny");
  });

  test("the same agent re-installing to its own device is allowed", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  test("a reserved device refuses installs from any agent", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL], reservedIds: [USB_PIXEL.id] });
    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    expect(decision.decision).toBe("deny");
  });

  test("untargeted with two connected devices of the same platform is refused", async () => {
    const other: PhysicalDevice = { ...USB_PIXEL, id: "FAKESERIAL0002" };
    const { manager } = createManager({ devices: [USB_PIXEL, other] });
    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb install app.apk",
    });
    expect(decision.decision).toBe("deny");
  });

  test("untargeted with exactly one connected device is leased and allowed", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb install app.apk",
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  test("gradlew installDebug with no target and two devices refuses (installs on all)", async () => {
    const other: PhysicalDevice = { ...USB_PIXEL, id: "FAKESERIAL0002" };
    const { manager } = createManager({ devices: [USB_PIXEL, other] });
    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "./gradlew installDebug",
    });
    expect(decision.decision).toBe("deny");
  });

  test("read-only commands pass untouched", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    expect(await manager.gateInstall({ agentId: "agent-1", command: "adb devices -l" })).toEqual({
      decision: "allow",
    });
    expect(await manager.gateInstall({ agentId: "agent-1", command: "adb logcat" })).toEqual({
      decision: "allow",
    });
  });

  test("ANDROID_SERIAL, adb -s, --device and -destination id= are all recognised as targets", async () => {
    const { manager } = createManager({
      devices: [USB_PIXEL, NETWORK_IPHONE],
      agentIds: ["agent-1", "agent-2"],
    });

    await manager.checkout({ agentId: "agent-2", platform: "android" });
    await expect(
      manager.gateInstall({
        agentId: "agent-1",
        command: `ANDROID_SERIAL=${USB_PIXEL.id} adb install app.apk`,
      }),
    ).resolves.toMatchObject({ decision: "deny" });

    await manager.checkin({ agentId: "agent-2" });
    await manager.checkout({ agentId: "agent-2", platform: "ios" });
    await expect(
      manager.gateInstall({
        agentId: "agent-1",
        command: `xcrun devicectl device install app --device ${NETWORK_IPHONE.id}`,
      }),
    ).resolves.toMatchObject({ decision: "deny" });
    await expect(
      manager.gateInstall({
        agentId: "agent-1",
        command: `xcodebuild test -destination 'id=${NETWORK_IPHONE.id}'`,
      }),
    ).resolves.toMatchObject({ decision: "deny" });
  });

  test("dry run records instead of refusing", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL], dryRun: true });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-2",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    expect(decision).toEqual({ decision: "allow" });
    const snapshot = await manager.getSnapshot();
    expect(snapshot.blocked[0]).toMatchObject({ dryRun: true, agentId: "agent-2" });
  });
});
