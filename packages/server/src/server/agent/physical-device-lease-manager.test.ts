import { describe, expect, test, vi } from "vitest";
import { PhysicalDeviceLeaseManager } from "./physical-device-lease-manager.js";
import type { PhysicalDevice } from "./physical-device-registry.js";
import type { DeviceLeaseAgentSummary } from "./device-lease-manager.js";
import { attributeProcessTrees } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

const MINUTE = 60_000;

function createManager(
  options: {
    devices?: PhysicalDevice[];
    enabled?: boolean;
    dryRun?: boolean;
    idleReleaseMinutes?: number;
    agentIds?: string[];
    agents?: DeviceLeaseAgentSummary[];
    reservedIds?: string[];
    /** Emulators adb also sees — an untargeted adb command could mean any of them too. */
    emulatorCount?: number;
  } = {},
) {
  const state = {
    devices: options.devices ?? [],
    config: {
      enabled: options.enabled ?? true,
      dryRun: options.dryRun ?? false,
      ...(options.idleReleaseMinutes === undefined
        ? {}
        : { idleReleaseMinutes: options.idleReleaseMinutes }),
    },
    agents:
      options.agents ??
      (options.agentIds ?? ["agent-1", "agent-2"]).map((agentId) => ({
        agentId,
        provider: "claude",
        isRunning: true,
      })),
    rows: [] as ProcessSampleRow[],
    nowMs: 1_000_000,
    reserved: new Set(options.reservedIds ?? []),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  let leaseCounter = 0;
  const manager = new PhysicalDeviceLeaseManager({
    listConnectedDevices: () => state.devices,
    countAndroidEmulators: () => options.emulatorCount ?? 0,
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

/** One resource-monitor sweep over the harness's `ps` rows, the way agent-resource-monitor.ts
 * hands it to `reportProcessSample`. */
function sweepRows(harness: ReturnType<typeof createManager>): void {
  const { manager, state } = harness;
  const { agentTrees } = attributeProcessTrees(
    state.rows,
    state.agents.map((agent) => agent.agentId),
  );
  manager.reportProcessSample({ rows: state.rows, agentTrees });
}

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

function childRow(pid: number, ppid: number, command: string): ProcessSampleRow {
  return { pid, ppid, uid: 501, rssKb: 10_000, cpuPercent: 0, etime: "05:00", command };
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

describe("PhysicalDeviceLeaseManager waiting", () => {
  test("a checkout that waits gets the device once its holder checks it in", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    const pending = manager.checkout({
      agentId: "agent-2",
      platform: "android",
      device: USB_PIXEL.id,
      wait: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.checkin({ agentId: "agent-1" });

    expect(await pending).toMatchObject({ status: "granted", device: { id: USB_PIXEL.id } });
  });

  test("waiting with no device of the platform connected returns at once", async () => {
    const { manager } = createManager({ devices: [NETWORK_IPHONE] });

    expect(
      await manager.checkout({ agentId: "agent-1", platform: "android", wait: true }),
    ).toMatchObject({ status: "unavailable" });
  });

  test("without wait, a held named device says who holds it", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    const result = await manager.checkout({
      agentId: "agent-2",
      platform: "android",
      device: USB_PIXEL.id,
    });
    expect(result.status === "unavailable" && result.message).toContain("agent-1");
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

describe("PhysicalDeviceLeaseManager idle Wi-Fi devices", () => {
  const IDLE_IPHONE: PhysicalDevice = { ...NETWORK_IPHONE, idle: true };

  test("an idle Wi-Fi iPhone nobody holds or reserved is left out of the snapshot", async () => {
    const { manager } = createManager({ devices: [IDLE_IPHONE] });
    expect((await manager.getSnapshot()).devices).toEqual([]);
  });

  test("an idle Wi-Fi iPhone is still a checkout target, and listed once held", async () => {
    const { manager } = createManager({ devices: [IDLE_IPHONE] });
    const result = await manager.checkout({ agentId: "agent-1", platform: "ios" });
    expect(result.status).toBe("granted");
    expect((await manager.getSnapshot()).devices).toEqual([
      expect.objectContaining({ id: IDLE_IPHONE.id, agentId: "agent-1", connected: true }),
    ]);
  });

  test("an idle Wi-Fi iPhone drops out of the snapshot again once checked in", async () => {
    const { manager } = createManager({ devices: [IDLE_IPHONE] });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });
    await manager.checkin({ agentId: "agent-1" });
    expect((await manager.getSnapshot()).devices).toEqual([]);
  });

  test("a checkout that names no device picks a phone in use before an idle one", async () => {
    const WIRED_IPHONE: PhysicalDevice = {
      id: "ffffffff-000FAKE00E0002",
      platform: "ios",
      name: "Fake Wired iPhone",
      transport: "usb",
    };
    const { manager } = createManager({ devices: [IDLE_IPHONE, WIRED_IPHONE] });
    const result = await manager.checkout({ agentId: "agent-1", platform: "ios" });
    expect(result).toMatchObject({ status: "granted", device: { id: WIRED_IPHONE.id } });
  });

  test("an install to an idle Wi-Fi iPhone leases it to the installer, and another agent is refused", async () => {
    const { manager } = createManager({ devices: [IDLE_IPHONE] });
    const command = `xcrun devicectl device install app --device ${IDLE_IPHONE.id} App.app`;
    expect(await manager.gateInstall({ agentId: "agent-1", command })).toEqual({
      decision: "allow",
    });
    expect((await manager.getSnapshot()).devices).toEqual([
      expect.objectContaining({ id: IDLE_IPHONE.id, agentId: "agent-1" }),
    ]);
    expect((await manager.gateInstall({ agentId: "agent-2", command })).decision).toBe("deny");
  });

  test("a held idle Wi-Fi iPhone that leaves the network keeps its holder through the grace period", async () => {
    const { manager, state } = createManager({ devices: [IDLE_IPHONE] });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });

    state.devices = [];
    state.nowMs += 10 * MINUTE;
    const entry = (await manager.getSnapshot()).devices[0];
    expect(entry).toMatchObject({ id: IDLE_IPHONE.id, agentId: "agent-1", connected: false });
    expect(entry?.graceRemainingSeconds).toBeGreaterThan(0);
  });

  test("an idle Wi-Fi iPhone reserved for Tyler stays listed", async () => {
    const { manager } = createManager({ devices: [IDLE_IPHONE], reservedIds: [IDLE_IPHONE.id] });
    expect((await manager.getSnapshot()).devices).toEqual([
      expect.objectContaining({ id: IDLE_IPHONE.id, reserved: true }),
    ]);
  });
});

describe("PhysicalDeviceLeaseManager detectionChanged", () => {
  test("a device appearing notifies once; the same list reported again does not notify", () => {
    const { manager, state } = createManager({ devices: [] });
    const listener = vi.fn();
    manager.subscribe(listener);

    state.devices = [USB_PIXEL];
    manager.detectionChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    manager.detectionChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("an idle flip on a Wi-Fi iPhone notifies", () => {
    const { manager, state } = createManager({ devices: [{ ...NETWORK_IPHONE, idle: true }] });
    const listener = vi.fn();
    manager.subscribe(listener);

    state.devices = [{ ...NETWORK_IPHONE, idle: false }];
    manager.detectionChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    manager.detectionChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a held device disappearing notifies once and starts the grace clock", async () => {
    const { manager, state } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    const listener = vi.fn();
    manager.subscribe(listener);
    state.devices = [];
    manager.detectionChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    const entry = (await manager.getSnapshot()).devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry).toMatchObject({ agentId: "agent-1", connected: false });
    expect(entry?.graceRemainingSeconds).toBeGreaterThan(0);
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

  test("untargeted adb with two connected devices is allowed: adb itself refuses to pick one", async () => {
    // And an ANDROID_SERIAL exported in the agent's shell, which the gate can't see, makes it
    // a perfectly good command — refusing it would be a false refusal.
    const other: PhysicalDevice = { ...USB_PIXEL, id: "FAKESERIAL0002" };
    const { manager } = createManager({ devices: [USB_PIXEL, other] });
    await manager.checkout({ agentId: "agent-2", platform: "android", device: USB_PIXEL.id });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb install app.apk",
    });
    expect(decision).toEqual({ decision: "allow" });
  });

  test("untargeted adb with one phone and a running emulator is allowed the same way", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL], emulatorCount: 1 });
    await manager.checkout({ agentId: "agent-2", platform: "android" });

    expect(
      await manager.gateInstall({ agentId: "agent-1", command: "adb install app.apk" }),
    ).toEqual({ decision: "allow" });
  });

  test("untargeted ios-deploy with two iPhones is refused with the exact targeting fix", async () => {
    const other: PhysicalDevice = { ...NETWORK_IPHONE, id: "00000000-000FAKE00E0002" };
    const { manager } = createManager({ devices: [NETWORK_IPHONE, other] });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "ios-deploy --bundle App.app",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.decision === "deny" && decision.message).toContain(`--id ${NETWORK_IPHONE.id}`);
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
    for (const command of ["./gradlew installDebug", "./gradlew :app:installDebug"]) {
      const decision = await manager.gateInstall({ agentId: "agent-1", command });
      expect(decision.decision, command).toBe("deny");
      expect(decision.decision === "deny" && decision.message, command).toContain(
        `ANDROID_SERIAL=${USB_PIXEL.id}`,
      );
    }
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

  test("read-only and build-only commands pass even on another agent's or Tyler's device", async () => {
    const { manager } = createManager({
      devices: [USB_PIXEL, NETWORK_IPHONE],
      reservedIds: [NETWORK_IPHONE.id],
    });
    await manager.checkout({ agentId: "agent-1", platform: "android" });

    for (const command of [
      `adb -s ${USB_PIXEL.id} shell pm list packages`,
      "adb shell pm path com.example",
      "xcodebuild -scheme App -destination 'generic/platform=iOS' archive",
      "xcodebuild build -scheme App -destination 'generic/platform=iOS'",
      "ios-deploy --detect",
    ]) {
      expect(await manager.gateInstall({ agentId: "agent-2", command }), command).toEqual({
        decision: "allow",
      });
    }
    expect((await manager.getSnapshot()).blocked).toEqual([]);
  });

  test("force-stop is refused only on a device another agent holds, and takes no lease", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });

    expect(
      await manager.gateInstall({
        agentId: "agent-1",
        command: `adb -s ${USB_PIXEL.id} shell am force-stop com.example`,
      }),
    ).toEqual({ decision: "allow" });
    expect((await manager.getSnapshot()).devices[0]?.agentId).toBeUndefined();

    await manager.checkout({ agentId: "agent-1", platform: "android" });
    const decision = await manager.gateInstall({
      agentId: "agent-2",
      command: `adb -s ${USB_PIXEL.id} shell am force-stop com.example`,
    });
    expect(decision.decision).toBe("deny");
  });

  test("a device named by its model name, user-set name or CoreDevice identifier is protected", async () => {
    const iphone: PhysicalDevice = {
      ...NETWORK_IPHONE,
      name: "iPhone 16e",
      aliases: ["Fake Name iPhone", "11111111-2222-3333-4444-FAKE00000001"],
    };
    const { manager } = createManager({ devices: [iphone] });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });

    for (const command of [
      "xcodebuild test -scheme App -destination 'platform=iOS,name=iPhone 16e'",
      "npx expo run:ios --device 'fake name iphone'",
      "xcrun devicectl device install app --device 11111111-2222-3333-4444-FAKE00000001 App.app",
      `xcrun devicectl device process launch --device ${iphone.id} com.example`,
    ]) {
      const decision = await manager.gateInstall({ agentId: "agent-2", command });
      expect(decision.decision, command).toBe("deny");
    }
  });

  test("reserving a device does not lock out the agent already holding it", async () => {
    const { manager, state } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-1", platform: "android" });
    state.reserved.add(USB_PIXEL.id);

    expect(
      await manager.gateInstall({
        agentId: "agent-1",
        command: `adb -s ${USB_PIXEL.id} install app.apk`,
      }),
    ).toEqual({ decision: "allow" });
    expect(
      (
        await manager.gateInstall({
          agentId: "agent-2",
          command: `adb -s ${USB_PIXEL.id} install app.apk`,
        })
      ).decision,
    ).toBe("deny");
  });

  test("a disconnected device keeps its name and transport in the snapshot", async () => {
    const { manager, state } = createManager({ devices: [NETWORK_IPHONE] });
    await manager.checkout({ agentId: "agent-1", platform: "ios" });
    state.devices = [];

    expect((await manager.getSnapshot()).devices[0]).toMatchObject({
      id: NETWORK_IPHONE.id,
      name: NETWORK_IPHONE.name,
      transport: "network",
      connected: false,
    });
  });
});

const IDLE_HOLDER: DeviceLeaseAgentSummary = {
  agentId: "agent-1",
  provider: "claude",
  isRunning: false,
};

describe("PhysicalDeviceLeaseManager idle release", () => {
  test("an install lease whose holder has been idle with no shell for 15 minutes is released idle", async () => {
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER] });
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    // The agent's own CLI process, present and idle, so the tree is attributable at all.
    harness.state.rows = [agentRootRow(500, "agent-1")];
    sweepRows(harness);

    harness.state.nowMs += 15 * MINUTE;
    sweepRows(harness);

    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: USB_PIXEL.id, reason: "idle" }),
      "Physical device lease released",
    );
    const snapshot = await harness.manager.getSnapshot();
    expect(snapshot.devices.find((device) => device.id === USB_PIXEL.id)?.agentId).toBeUndefined();
  });

  test("a holder with a live background install loop keeps the lease", async () => {
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER] });
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    harness.state.rows = [
      agentRootRow(500, "agent-1"),
      childRow(501, 500, "/bin/zsh -c ./install-loop.sh"),
    ];
    sweepRows(harness);

    harness.state.nowMs += 20 * MINUTE;
    sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(([, msg]) => msg === "Physical device lease released"),
    ).toBe(false);
  });

  test("a process outside the holder's tree running adb -s <serial> keeps the lease", async () => {
    const harness = createManager({
      devices: [USB_PIXEL],
      agents: [IDLE_HOLDER, { agentId: "agent-2", provider: "claude", isRunning: false }],
    });
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    harness.state.rows = [
      agentRootRow(700, "agent-2"),
      childRow(701, 700, `/bin/zsh -c adb -s ${USB_PIXEL.id} logcat`),
      childRow(702, 701, `adb -s ${USB_PIXEL.id} logcat`),
    ];
    sweepRows(harness);

    harness.state.nowMs += 20 * MINUTE;
    sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(([, msg]) => msg === "Physical device lease released"),
    ).toBe(false);
  });

  test("an install-gate decision resets the clock", async () => {
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER] });
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    sweepRows(harness);

    harness.state.nowMs += 10 * MINUTE;
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app2.apk`,
    });

    harness.state.nowMs += 10 * MINUTE;
    sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(([, msg]) => msg === "Physical device lease released"),
    ).toBe(false);
  });

  test("a reserved device is unaffected (reservations are not leases)", async () => {
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER] });
    harness.state.reserved.add(USB_PIXEL.id);
    sweepRows(harness);

    harness.state.nowMs += 60 * MINUTE;
    sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(([, msg]) => msg === "Physical device lease released"),
    ).toBe(false);
  });

  test("dry run logs and keeps the lease", async () => {
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER], dryRun: true });
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    harness.state.rows = [agentRootRow(500, "agent-1")];
    sweepRows(harness);

    harness.state.nowMs += 15 * MINUTE;
    sweepRows(harness);

    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, deviceId: USB_PIXEL.id }),
      "Would release an idle device lease",
    );
    const snapshot = await harness.manager.getSnapshot();
    expect(snapshot.devices.find((device) => device.id === USB_PIXEL.id)?.agentId).toBe("agent-1");
  });

  test("idleReleaseMinutes: 0 turns it off", async () => {
    const harness = createManager({
      devices: [USB_PIXEL],
      agents: [IDLE_HOLDER],
      idleReleaseMinutes: 0,
    });
    await harness.manager.gateInstall({
      agentId: "agent-1",
      command: `adb -s ${USB_PIXEL.id} install app.apk`,
    });
    sweepRows(harness);

    harness.state.nowMs += 60 * MINUTE;
    sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(([, msg]) => msg === "Physical device lease released"),
    ).toBe(false);
  });

  test("a holder whose process tree can't be attributed (no callerAgentId marker, as on Codex or OpenCode) keeps its lease rather than reading as idle", async () => {
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER] });
    await harness.manager.checkout({ agentId: "agent-1", platform: "android" });
    // No agentRootRow is ever added for agent-1 — its provider never carries the marker
    // attribution keys on, so its tree can never be found, in any sweep.
    sweepRows(harness);

    harness.state.nowMs += 20 * MINUTE;
    sweepRows(harness);

    expect(
      harness.logger.info.mock.calls.some(([, msg]) => msg === "Physical device lease released"),
    ).toBe(false);
  });
});

describe("PhysicalDeviceLeaseManager reconciling a gone agent", () => {
  test("detectionChanged releases a held lease in the same call, once the agent is no longer known", async () => {
    const harness = createManager({
      devices: [USB_PIXEL],
      agents: [{ agentId: "agent-1", provider: "claude", isRunning: true }],
    });
    const result = await harness.manager.checkout({ agentId: "agent-1", platform: "android" });
    expect(result.status).toBe("granted");

    // The agent manager no longer knows this agent — archived or closed.
    harness.state.agents = [];
    harness.manager.detectionChanged();

    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", reason: "agent-gone" }),
      "Physical device lease released",
    );
    const snapshot = await harness.manager.getSnapshot();
    expect(snapshot.devices.find((device) => device.id === USB_PIXEL.id)?.agentId).toBeUndefined();
  });
});
