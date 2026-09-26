import { describe, expect, test } from "vitest";
import {
  collectDeviceIdReferences,
  countDevicesByPlatform,
  detectRunningDevices,
} from "./device-detection.js";
import type { ProcessSampleRow } from "./process-sampler.js";

function row(
  overrides: Partial<ProcessSampleRow> & { pid: number; command: string },
): ProcessSampleRow {
  return {
    ppid: 1,
    uid: 501,
    rssKb: 1024,
    cpuPercent: 0,
    etime: "01:00",
    ...overrides,
  };
}

// Copied off Tyler's machine while two simulators were booted: the UDID lives in launchd_sim's
// argv, and nowhere else in the 277 processes the device runs.
const LAUNCHD_SIM_A =
  "launchd_sim /Users/tylerthackray/Library/Developer/CoreSimulator/Devices/A0A912ED-C766-4778-957C-F9680C7309F3/data/var/run/launchd_bootstrap.plist";
const LAUNCHD_SIM_B =
  "launchd_sim /Users/tylerthackray/Library/Developer/CoreSimulator/Devices/1A9C8E3A-A8AC-4FAB-9286-D970E0F83945/data/var/run/launchd_bootstrap.plist";
const SIM_CHILD =
  "/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.5.simruntime/Contents/Resources/RuntimeRoot/System/Library/Frameworks/ShazamKit.framework/shazamd";
const EMULATOR_LAUNCHER =
  "/Users/tylerthackray/Library/Android/sdk/emulator/emulator -avd Pixel_7_API_34 -netdelay none";
const EMULATOR_QEMU =
  "/Users/tylerthackray/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_7_API_34 -netdelay none";

describe("detectRunningDevices", () => {
  test("finds one device per booted simulator, keyed by UDID", () => {
    const devices = detectRunningDevices({
      rows: [
        row({ pid: 92780, command: LAUNCHD_SIM_A }),
        row({ pid: 88155, command: LAUNCHD_SIM_B }),
        row({ pid: 4646, ppid: 92780, command: SIM_CHILD }),
      ],
      agentTrees: [],
    });

    expect(devices).toHaveLength(2);
    expect(devices.map((device) => device.deviceId)).toEqual([
      "1A9C8E3A-A8AC-4FAB-9286-D970E0F83945",
      "A0A912ED-C766-4778-957C-F9680C7309F3",
    ]);
    expect(devices.every((device) => device.platform === "ios")).toBe(true);
    // The simulator's processes belong to the device, not to whoever booted it.
    expect(devices[1].pids).toEqual([92780, 4646]);
  });

  test("counts the emulator launcher and its qemu child as one device", () => {
    const devices = detectRunningDevices({
      rows: [
        row({ pid: 500, command: EMULATOR_LAUNCHER }),
        row({ pid: 501, ppid: 500, command: EMULATOR_QEMU }),
      ],
      agentTrees: [],
    });

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ platform: "android", deviceId: "Pixel_7_API_34", pid: 500 });
    expect(devices[0].pids).toEqual([500, 501]);
  });

  test("attributes a device to the agent whose tree launched it", () => {
    const devices = detectRunningDevices({
      rows: [
        row({ pid: 500, ppid: 400, command: EMULATOR_LAUNCHER }),
        row({ pid: 92780, command: LAUNCHD_SIM_A }),
      ],
      agentTrees: [{ agentId: "agent-1", pids: [400, 500] }],
    });

    expect(devices.find((device) => device.platform === "android")?.agentId).toBe("agent-1");
    // launchd_sim is reparented to pid 1 at boot, so no tree contains it and nothing is guessed.
    expect(devices.find((device) => device.platform === "ios")?.agentId).toBeUndefined();
  });

  test("ignores processes that only mention a device", () => {
    const devices = detectRunningDevices({
      rows: [
        row({
          pid: 1,
          command:
            "grep -r launchd_sim /Users/tylerthackray/Library/Developer/CoreSimulator/Devices/A0A912ED-C766-4778-957C-F9680C7309F3/",
        }),
        row({ pid: 2, command: "/usr/bin/adb -s emulator-5554 logcat" }),
        row({ pid: 3, command: "/opt/homebrew/bin/qemu-system-x86_64 -m 4096 -hda disk.img" }),
        row({
          pid: 4,
          command: "/Users/tylerthackray/Library/Android/sdk/emulator/emulator -list-avds",
        }),
      ],
      agentTrees: [],
    });

    expect(devices).toEqual([]);
  });

  test("counts by platform", () => {
    const devices = detectRunningDevices({
      rows: [
        row({ pid: 92780, command: LAUNCHD_SIM_A }),
        row({ pid: 88155, command: LAUNCHD_SIM_B }),
        row({ pid: 500, command: EMULATOR_LAUNCHER }),
      ],
      agentTrees: [],
    });

    expect(countDevicesByPlatform(devices)).toEqual({ ios: 2, android: 1 });
  });
});

// A test clone lives in a second device set. Taken from CoreSimulator's own log on Tyler's
// machine: `…/XCTestDevices/<UDID>/data`, created as "Clone 3 of iPhone 16 Pro".
const XCTEST_CLONE_UDID = "1C56B10C-38C1-4547-ABDA-D36412FF01CA";
const XCTEST_CLONE_ROOT = "/Users/tylerthackray/Library/Developer/XCTestDevices";
const LAUNCHD_SIM_CLONE = `launchd_sim ${XCTEST_CLONE_ROOT}/${XCTEST_CLONE_UDID}/data/var/run/launchd_bootstrap.plist`;

describe("collectDeviceIdReferences", () => {
  test("reports the device set a booted simulator's data directory lives in", () => {
    const references = collectDeviceIdReferences([row({ pid: 1, command: LAUNCHD_SIM_A })]);
    expect(references.get("A0A912ED-C766-4778-957C-F9680C7309F3")).toEqual({
      bootedInSetRoot: "/Users/tylerthackray/Library/Developer/CoreSimulator/Devices",
      pids: [1],
    });
  });

  test("sees a booted test clone, which detectRunningDevices cannot", () => {
    const rows = [row({ pid: 1, command: LAUNCHD_SIM_CLONE })];
    // The count's pattern needs the literal path segment `/Devices/`, and `/XCTestDevices/`
    // does not contain it — see the janitor doc on why the count is left alone.
    expect(detectRunningDevices({ rows, agentTrees: [] })).toEqual([]);
    expect(collectDeviceIdReferences(rows).get(XCTEST_CLONE_UDID)).toEqual({
      bootedInSetRoot: XCTEST_CLONE_ROOT,
      pids: [1],
    });
  });

  test("reports a UDID any process merely names, with no set root", () => {
    const references = collectDeviceIdReferences([
      row({
        pid: 7,
        command: `/usr/bin/xcodebuild test -destination platform=iOS Simulator,id=${XCTEST_CLONE_UDID}`,
      }),
    ]);
    expect(references.get(XCTEST_CLONE_UDID)).toEqual({ pids: [7] });
  });

  test("normalizes case and collects every pid that names a UDID", () => {
    const references = collectDeviceIdReferences([
      row({ pid: 1, command: LAUNCHD_SIM_CLONE }),
      row({ pid: 2, command: `xcrun simctl --set X launch ${XCTEST_CLONE_UDID.toLowerCase()}` }),
    ]);
    expect(references.get(XCTEST_CLONE_UDID)?.pids).toEqual([1, 2]);
  });

  test("reports nothing for a sample with no UDIDs in it", () => {
    expect(collectDeviceIdReferences([row({ pid: 1, command: EMULATOR_LAUNCHER })]).size).toBe(0);
  });
});
