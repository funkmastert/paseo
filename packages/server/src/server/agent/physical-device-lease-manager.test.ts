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

  test("installs to a held device via a same-command shell variable are refused too, not just a literal serial", async () => {
    // The incident: a leader ran `S=<serial>; APP=...; APK=...; adb -s $S install -r -d $APK`
    // while a sibling agent held the same phone. A literal-token-only target match reads "$S" as
    // a device nothing is connected as — "nothing to protect" — and lets the install run
    // unguarded against the real, held device $S resolves to.
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-2", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: `S=${USB_PIXEL.id}; APP=com.example; APK=app.apk; adb -s $S install -r -d $APK`,
    });
    expect(decision.decision).toBe("deny");
    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices.find((d) => d.id === USB_PIXEL.id)?.agentId).toBe("agent-2");
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

  // A target the gate truly can't resolve fails closed, not open. `$EXPORTED_ELSEWHERE` names no
  // assignment in these commands, the same as `export`ing it in the agent's shell profile, or
  // setting it in an earlier, separate tool call — this gate has no way to read either. It still
  // means exactly one real device, so it must never fall back to "nothing to protect" the way a
  // genuinely unconnected literal device name does.
  test("unresolved target, one connected device held by another agent: refused", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-2", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb -s $EXPORTED_ELSEWHERE install app.apk",
    });
    expect(decision.decision).toBe("deny");
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry?.agentId).toBe("agent-2");
  });

  test("unresolved target, two connected devices: refused with the exact literal-name targeting fix, no plain-adb exemption", async () => {
    const other: PhysicalDevice = { ...USB_PIXEL, id: "FAKESERIAL0002" };
    const { manager } = createManager({ devices: [USB_PIXEL, other] });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb -s $EXPORTED_ELSEWHERE install app.apk",
    });
    expect(decision.decision).toBe("deny");
    const message = decision.decision === "deny" ? decision.message : "";
    expect(message).toContain("names a device this gate can't resolve");
    expect(message).toContain("Name the device literally");
    expect(message).toContain(USB_PIXEL.id);
    expect(message).toContain(other.id);
    const snapshot = await manager.getSnapshot();
    const held = snapshot.devices.filter((d) => d.agentId !== undefined);
    expect(held).toEqual([]);
  });

  test("unresolved target, one free connected device: bound to the caller, same as a resolved target would be", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb -s $EXPORTED_ELSEWHERE install app.apk",
    });
    expect(decision).toEqual({ decision: "allow" });
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry?.agentId).toBe("agent-1");
  });

  test("unresolved target, iOS: an unresolved --device target on a device another agent holds is refused", async () => {
    const { manager } = createManager({ devices: [NETWORK_IPHONE] });
    await manager.checkout({ agentId: "agent-2", platform: "ios" });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command:
        "UDID=$(xcrun devicectl list devices | head -1); xcrun devicectl device install app --device $UDID --app app.app",
    });
    expect(decision.decision).toBe("deny");
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === NETWORK_IPHONE.id);
    expect(entry?.agentId).toBe("agent-2");
  });

  test("unresolved target with android emulators also reachable: never auto-binds the lone phone", async () => {
    // adb can also reach 2 running emulators; `-s $X` could resolve to either of those just as
    // well as the one physical phone. Binding the phone here would be a phantom lease — the
    // command may never touch it at all.
    const { manager } = createManager({ devices: [USB_PIXEL], emulatorCount: 2 });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb -s $EXPORTED_ELSEWHERE install app.apk",
    });
    expect(decision.decision).toBe("deny");
    const message = decision.decision === "deny" ? decision.message : "";
    expect(message).toContain("2 running emulators");
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry?.agentId).toBeUndefined();
  });

  test("xargs: a piped adb install onto a held device is refused, not run ungated", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-2", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: `ls *.apk | xargs adb -s ${USB_PIXEL.id} install`,
    });
    expect(decision.decision).toBe("deny");
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry?.agentId).toBe("agent-2");
  });

  test("xargs -I{} with a {} placeholder onto a held device is refused", async () => {
    const { manager } = createManager({ devices: [USB_PIXEL] });
    await manager.checkout({ agentId: "agent-2", platform: "android" });

    const decision = await manager.gateInstall({
      agentId: "agent-1",
      command: "adb devices | xargs -I{} adb -s {} install x.apk",
    });
    expect(decision.decision).toBe("deny");
    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.id === USB_PIXEL.id);
    expect(entry?.agentId).toBe("agent-2");
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

describe("PhysicalDeviceLeaseManager holder lineage", () => {
  test("a held device names the holder's leader when the holder is a child", async () => {
    // Tyler's report: the status named a leader he didn't recognize. A child's own title may not
    // say which effort it belongs to, so the snapshot carries the leader's id too (the client
    // already has every agent's title in its session store and resolves both — the daemon sends
    // ids, it has no business deciding what an agent is called).
    const { manager } = createManager({
      devices: [USB_PIXEL],
      agents: [
        { agentId: "child-1", provider: "claude", isRunning: true, parentAgentId: "leader-1" },
      ],
    });
    await manager.checkout({ agentId: "child-1", platform: "android" });

    const snapshot = await manager.getSnapshot();
    expect(snapshot.devices.find((d) => d.agentId === "child-1")).toMatchObject({
      agentId: "child-1",
      leaderAgentId: "leader-1",
    });
  });

  test("a held device run by a root leader itself carries no leaderAgentId", async () => {
    const { manager } = createManager({
      devices: [USB_PIXEL],
      agents: [{ agentId: "leader-1", provider: "claude", isRunning: true }],
    });
    await manager.checkout({ agentId: "leader-1", platform: "android" });

    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.agentId === "leader-1");
    expect(entry?.leaderAgentId).toBeUndefined();
  });

  test("leaderAgentId walks to the root across a 3-level leader -> worker -> sub-worker chain", async () => {
    // A grandchild's lease (held by sub-worker, two hops below root-leader) must still name the
    // root leader, not the intermediate worker — the leader Tyler actually recognizes.
    const { manager } = createManager({
      devices: [USB_PIXEL],
      agents: [
        { agentId: "sub-worker", provider: "claude", isRunning: true, parentAgentId: "worker" },
        { agentId: "worker", provider: "claude", isRunning: true, parentAgentId: "root-leader" },
        { agentId: "root-leader", provider: "claude", isRunning: true },
      ],
    });
    await manager.checkout({ agentId: "sub-worker", platform: "android" });

    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.agentId === "sub-worker");
    expect(entry?.leaderAgentId).toBe("root-leader");
  });

  test("a cycle in parentAgentId doesn't loop forever — it just stops", async () => {
    const { manager } = createManager({
      devices: [USB_PIXEL],
      agents: [
        { agentId: "a", provider: "claude", isRunning: true, parentAgentId: "b" },
        { agentId: "b", provider: "claude", isRunning: true, parentAgentId: "a" },
      ],
    });
    await manager.checkout({ agentId: "a", platform: "android" });

    const snapshot = await manager.getSnapshot();
    const entry = snapshot.devices.find((d) => d.agentId === "a");
    expect(entry?.leaderAgentId).toBe("b");
  });
});

describe("PhysicalDeviceLeaseManager held-time refresh", () => {
  test("a sweep pushes a fresh snapshot for a quietly-held lease, so heldForSeconds doesn't freeze", async () => {
    // Tyler's report: the app showed "held 0s" minutes into a real hold. The daemon computes
    // heldForSeconds correctly on every getSnapshot() call, but nothing re-pushed one: reconcile()
    // only notifies on an actual lease-table change, and a lease that nobody touches and that
    // never goes idle never changes. The sweep has to push on its own, on the same cadence as the
    // resource monitor, or the UI shows whatever heldForSeconds was true at the last bind/release.
    const harness = createManager({ devices: [USB_PIXEL], agents: [IDLE_HOLDER] });
    await harness.manager.checkout({ agentId: "agent-1", platform: "android" });
    harness.state.rows = [agentRootRow(500, "agent-1")];
    // One sweep right after the bind primes lastUsedAtMs; clear the listener so only the next,
    // genuinely-quiet sweep is under test.
    sweepRows(harness);
    const listener = vi.fn();
    harness.manager.subscribe(listener);

    harness.state.nowMs += MINUTE;
    sweepRows(harness);

    expect(listener).toHaveBeenCalled();
    const snapshot = await harness.manager.getSnapshot();
    expect(snapshot.devices.find((device) => device.id === USB_PIXEL.id)?.heldForSeconds).toBe(60);
  });

  test("a sweep with no leases at all pushes nothing new", async () => {
    const harness = createManager({ devices: [USB_PIXEL] });
    sweepRows(harness);
    const listener = vi.fn();
    harness.manager.subscribe(listener);

    harness.state.nowMs += MINUTE;
    sweepRows(harness);

    expect(listener).not.toHaveBeenCalled();
  });
});
