/**
 * Runs the actual shut-down command for a device, once DeviceLeaseManager has decided it's safe
 * to. Split out from the manager so the command construction is testable without a fake process
 * sampler: `xcrun simctl shutdown <udid>` for iOS, `adb -s <serial> emu kill` for Android — the
 * Android command needs the adb serial, never the AVD name, so a caller without one can't shut
 * anything down (see device-identity-lookup.ts).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DevicePlatform } from "./device-detection.js";

const execFileAsync = promisify(execFile);

export interface DeviceShutdownRunner {
  exec(command: string, args: readonly string[]): Promise<void>;
}

export const defaultDeviceShutdownRunner: DeviceShutdownRunner = {
  async exec(command, args) {
    await execFileAsync(command, args as string[], { timeout: 15_000 });
  },
};

export async function runDeviceShutdown(
  device: { platform: DevicePlatform; deviceId: string; serial?: string },
  runner: DeviceShutdownRunner,
): Promise<void> {
  if (device.platform === "ios") {
    await runner.exec("xcrun", ["simctl", "shutdown", device.deviceId]);
    return;
  }
  if (!device.serial) {
    throw new Error(
      `Cannot shut down Android device "${device.deviceId}": no adb serial was found for it.`,
    );
  }
  await runner.exec("adb", ["-s", device.serial, "emu", "kill"]);
}
