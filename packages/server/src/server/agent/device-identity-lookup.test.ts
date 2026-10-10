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

/** `adb devices -l` output for these emulator serials. */
function adbDeviceList(serials: readonly string[]): string {
  return `List of devices attached\n${serials.map((serial) => `${serial}\tdevice`).join("\n")}\n`;
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

  test("a second lookup re-checks the cached serial with one call, not a full adb sweep", async () => {
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "adb" && args[0] === "devices") {
        return "List of devices attached\nemulator-5554\tdevice\n";
      }
      return "yonderly_pixel\nOK\n";
    });
    const lookup = new DeviceIdentityLookup({ exec });

    await lookup.androidSerial("yonderly_pixel");
    const callsAfterFirst = exec.mock.calls.length;
    expect(await lookup.androidSerial("yonderly_pixel")).toBe("emulator-5554");

    expect(exec.mock.calls.slice(callsAfterFirst)).toEqual([
      ["adb", ["-s", "emulator-5554", "emu", "avd", "name"]],
    ]);
  });

  test("an emulator that restarted on another port is re-mapped, and its old port's new owner maps too", async () => {
    let ports: Record<string, string> = { "emulator-5554": "pixel_a" };
    const lookup = new DeviceIdentityLookup(
      fakeRunner({
        adbDevices: () => adbDeviceList(Object.keys(ports)),
        adbEmuAvdName: (serial) => `${ports[serial] ?? ""}\nOK\n`,
      }),
    );
    expect(await lookup.androidSerial("pixel_a")).toBe("emulator-5554");

    // pixel_a was killed and came back on 5556; pixel_b booted into the freed 5554.
    ports = { "emulator-5554": "pixel_b", "emulator-5556": "pixel_a" };

    expect(await lookup.androidSerial("pixel_a")).toBe("emulator-5556");
    expect(await lookup.androidSerial("pixel_b")).toBe("emulator-5554");
  });

  test("fresh: true rebuilds the whole map before answering", async () => {
    let ports: Record<string, string> = { "emulator-5554": "pixel_a" };
    const exec = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "adb" && args[0] === "devices") {
        return adbDeviceList(Object.keys(ports));
      }
      return `${ports[args[1] as string] ?? ""}\nOK\n`;
    });
    const lookup = new DeviceIdentityLookup({ exec });
    await lookup.androidSerial("pixel_a");
    ports = { "emulator-5556": "pixel_a" };
    exec.mockClear();

    expect(await lookup.androidSerial("pixel_a", { fresh: true })).toBe("emulator-5556");
    expect(exec.mock.calls[0]).toEqual(["adb", ["devices", "-l"]]);
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
