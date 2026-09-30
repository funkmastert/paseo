/**
 * Enriches a running device's bare id with the human-facing name and, for Android, the adb
 * serial a command actually needs (`adb -s <serial> …`). Never runs on the process-scan path —
 * `device-detection.ts` stays a pure `ps` read, one sample per sweep — this only runs when a
 * checkout or gate decision needs to tell an agent exactly which device it got, and caches by
 * device id so a busy sweep doesn't re-shell out for the same emulator every time.
 *
 * Fails open: any subprocess error or unparsable output yields `undefined`, never a throw. A
 * device the cap cannot name is still leased correctly; it just can't be addressed as precisely
 * in the response text.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DeviceIdentityRunner {
  exec(command: string, args: readonly string[]): Promise<string>;
}

const defaultRunner: DeviceIdentityRunner = {
  async exec(command, args) {
    const { stdout } = await execFileAsync(command, args as string[], { timeout: 4_000 });
    return stdout;
  },
};

export class DeviceIdentityLookup {
  private readonly runner: DeviceIdentityRunner;
  private readonly avdToSerial = new Map<string, string>();
  private readonly udidToName = new Map<string, string>();
  private androidMapInFlight: Promise<void> | undefined;

  constructor(runner: DeviceIdentityRunner = defaultRunner) {
    this.runner = runner;
  }

  /** The adb serial (`emulator-5554`) for a running AVD, from a cached `adb devices -l` sweep. */
  async androidSerial(avdName: string): Promise<string | undefined> {
    if (this.avdToSerial.has(avdName)) return this.avdToSerial.get(avdName);
    await this.refreshAndroidMap();
    return this.avdToSerial.get(avdName);
  }

  /** The human-facing simulator name (`iPhone 17 Pro`) for a booted UDID. */
  async iosSimulatorName(udid: string): Promise<string | undefined> {
    if (this.udidToName.has(udid)) return this.udidToName.get(udid);
    try {
      const stdout = await this.runner.exec("xcrun", ["simctl", "list", "devices", "-j"]);
      const parsed = JSON.parse(stdout) as {
        devices?: Record<string, Array<{ udid?: string; name?: string }>>;
      };
      for (const entries of Object.values(parsed.devices ?? {})) {
        for (const entry of entries) {
          if (entry.udid && entry.name) this.udidToName.set(entry.udid.toUpperCase(), entry.name);
        }
      }
    } catch {
      // No Xcode tools, or simctl is wedged — the cap still works without a friendly name.
      return undefined;
    }
    return this.udidToName.get(udid.toUpperCase());
  }

  /** One `adb -s <serial> emu avd name` per unmapped serial, deduped across concurrent callers. */
  private async refreshAndroidMap(): Promise<void> {
    this.androidMapInFlight ??= this.doRefreshAndroidMap().finally(() => {
      this.androidMapInFlight = undefined;
    });
    return await this.androidMapInFlight;
  }

  private async doRefreshAndroidMap(): Promise<void> {
    let serials: string[];
    try {
      const stdout = await this.runner.exec("adb", ["devices", "-l"]);
      serials = stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((serial): serial is string => Boolean(serial) && serial.startsWith("emulator-"));
    } catch {
      return;
    }
    await Promise.all(
      serials.map(async (serial) => {
        if ([...this.avdToSerial.values()].includes(serial)) return;
        try {
          const stdout = await this.runner.exec("adb", ["-s", serial, "emu", "avd", "name"]);
          // `emu avd name` prints the name, then "OK" on its own line.
          const name = stdout
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0 && line !== "OK");
          if (name) this.avdToSerial.set(name, serial);
        } catch {
          // This one emulator didn't answer; the rest of the map is still useful.
        }
      }),
    );
  }
}
