import { describe, expect, test, vi } from "vitest";
import { runDeviceShutdown } from "./device-shutdown.js";

describe("runDeviceShutdown", () => {
  test("shuts down an iOS simulator by UDID", async () => {
    const exec = vi.fn(async () => undefined);
    await runDeviceShutdown({ platform: "ios", deviceId: "UDID-1" }, { exec });

    expect(exec).toHaveBeenCalledWith("xcrun", ["simctl", "shutdown", "UDID-1"]);
  });

  test("kills an Android emulator by its adb serial, not its AVD name", async () => {
    const exec = vi.fn(async () => undefined);
    await runDeviceShutdown(
      { platform: "android", deviceId: "yonderly_pixel", serial: "emulator-5554" },
      { exec },
    );

    expect(exec).toHaveBeenCalledWith("adb", ["-s", "emulator-5554", "emu", "kill"]);
  });

  test("refuses to guess a serial for Android", async () => {
    const exec = vi.fn(async () => undefined);

    await expect(
      runDeviceShutdown({ platform: "android", deviceId: "yonderly_pixel" }, { exec }),
    ).rejects.toThrow(/serial/);
    expect(exec).not.toHaveBeenCalled();
  });
});
