import { describe, expect, test, vi } from "vitest";
import { DeviceIdentityLookup, type DeviceIdentityRunner } from "./device-identity-lookup.js";

function fakeRunner(handlers: {
  adbDevices?: () => string;
  adbEmuAvdName?: (serial: string) => string;
  simctlList?: () => string;
}): DeviceIdentityRunner {
  return {
    async exec(command, args) {
      if (command === "adb" && args[0] === "devices") return handlers.adbDevices?.() ?? "";
      if (command === "adb" && args[0] === "-s") {
        return handlers.adbEmuAvdName?.(args[1] as string) ?? "";
      }
      if (command === "xcrun") return handlers.simctlList?.() ?? "";
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

describe("DeviceIdentityLookup", () => {
  test("maps an AVD name to its adb serial", async () => {
    const lookup = new DeviceIdentityLookup(
      fakeRunner({
        adbDevices: () => "List of devices attached\nemulator-5554\tdevice product:sdk\n",
        adbEmuAvdName: () => "yonderly_pixel\nOK\n",
      }),
    );

    expect(await lookup.androidSerial("yonderly_pixel")).toBe("emulator-5554");
  });

  test("caches the map: a second lookup does not shell out again", async () => {
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "adb" && args[0] === "devices") {
        return "List of devices attached\nemulator-5554\tdevice\n";
      }
      return "yonderly_pixel\nOK\n";
    });
    const lookup = new DeviceIdentityLookup({ exec });

    await lookup.androidSerial("yonderly_pixel");
    const callsAfterFirst = exec.mock.calls.length;
    await lookup.androidSerial("yonderly_pixel");

    expect(exec.mock.calls.length).toBe(callsAfterFirst);
  });

  test("an AVD nobody has booted resolves to undefined, never a throw", async () => {
    const lookup = new DeviceIdentityLookup(
      fakeRunner({ adbDevices: () => "List of devices attached\n" }),
    );

    await expect(lookup.androidSerial("nothing_booted")).resolves.toBeUndefined();
  });

  test("adb missing fails open instead of throwing", async () => {
    const lookup = new DeviceIdentityLookup({
      exec: vi.fn(async () => {
        throw new Error("spawn adb ENOENT");
      }),
    });

    await expect(lookup.androidSerial("any")).resolves.toBeUndefined();
  });

  test("maps a booted UDID to its simulator name", async () => {
    const lookup = new DeviceIdentityLookup(
      fakeRunner({
        simctlList: () =>
          JSON.stringify({
            devices: {
              "iOS-17-0": [{ udid: "00000000-0000-0000-0000-000000000001", name: "iPhone 17 Pro" }],
            },
          }),
      }),
    );

    expect(await lookup.iosSimulatorName("00000000-0000-0000-0000-000000000001")).toBe(
      "iPhone 17 Pro",
    );
  });

  test("xcrun missing (no Xcode tools) fails open instead of throwing", async () => {
    const lookup = new DeviceIdentityLookup({
      exec: vi.fn(async () => {
        throw new Error('xcrun: error: unable to find utility "simctl"');
      }),
    });

    await expect(lookup.iosSimulatorName("any-udid")).resolves.toBeUndefined();
  });
});
