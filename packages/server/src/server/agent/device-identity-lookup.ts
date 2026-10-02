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

/** How long an unknown UDID waits before `simctl list` is asked again — a simulator whose name
 * can't be found must not cost a subprocess on every status push. */
const SIMULATOR_NAME_RETRY_MS = 30_000;

export interface AndroidSerialLookupOptions {
  /** Rebuild the whole AVD↔serial map before answering, instead of re-checking one cached
   * entry. Shut down uses this: `adb -s <serial> emu kill` against a stale serial kills
   * whichever emulator now owns that port. */
  fresh?: boolean;
}

export class DeviceIdentityLookup {
  private readonly runner: DeviceIdentityRunner;
  private readonly now: () => number;
  private avdToSerial = new Map<string, string>();
  private readonly udidToName = new Map<string, string>();
  private androidMapInFlight: Promise<void> | undefined;
  private simulatorListInFlight: Promise<void> | undefined;
  private simulatorListAtMs: number | undefined;

  constructor(runner: DeviceIdentityRunner = defaultRunner, now: () => number = Date.now) {
    this.runner = runner;
    this.now = now;
  }

  /**
   * The adb serial (`emulator-5554`) for a running AVD. A cached serial is only trusted after
   * `adb -s <serial> emu avd name` still answers with this AVD: emulators restart onto other
   * console ports, and a serial that pointed at this AVD a minute ago may point at another
   * agent's emulator now. A mismatch rebuilds the whole map.
   */
  async androidSerial(
    avdName: string,
    options: AndroidSerialLookupOptions = {},
  ): Promise<string | undefined> {
    const cached = this.avdToSerial.get(avdName);
    if (cached && !options.fresh) {
      if ((await this.readAvdName(cached)) === avdName) return cached;
    }
    await this.refreshAndroidMap();
    return this.avdToSerial.get(avdName);
  }

  /** The human-facing simulator name (`iPhone 17 Pro`) for a booted UDID. */
  async iosSimulatorName(udid: string): Promise<string | undefined> {
    const key = udid.toUpperCase();
    if (this.udidToName.has(key)) return this.udidToName.get(key);
    if (
      this.simulatorListAtMs !== undefined &&
      this.now() - this.simulatorListAtMs < SIMULATOR_NAME_RETRY_MS
    ) {
      return undefined;
    }
    this.simulatorListInFlight ??= this.readSimulatorList().finally(() => {
      this.simulatorListInFlight = undefined;
    });
    await this.simulatorListInFlight;
    return this.udidToName.get(key);
  }

  /** A name already resolved, without shelling out — for the status snapshot, which is built
   * synchronously. */
  cachedIosSimulatorName(udid: string): string | undefined {
    return this.udidToName.get(udid.toUpperCase());
  }

  private async readSimulatorList(): Promise<void> {
    this.simulatorListAtMs = this.now();
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
    }
  }

  /** Rebuilds the map from `adb devices -l`, deduped across concurrent callers. */
  private async refreshAndroidMap(): Promise<void> {
    this.androidMapInFlight ??= this.doRefreshAndroidMap().finally(() => {
      this.androidMapInFlight = undefined;
    });
    return await this.androidMapInFlight;
  }

  /** Every emulator serial is asked again: a serial already in the map may belong to a
   * different AVD now. Replaced wholesale, so a serial that went away takes its entry with it. */
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
    const next = new Map<string, string>();
    await Promise.all(
      serials.map(async (serial) => {
        const name = await this.readAvdName(serial);
        if (name) next.set(name, serial);
      }),
    );
    this.avdToSerial = next;
  }

  /** `adb -s <serial> emu avd name`, or undefined when that emulator doesn't answer. */
  private async readAvdName(serial: string): Promise<string | undefined> {
    try {
      const stdout = await this.runner.exec("adb", ["-s", serial, "emu", "avd", "name"]);
      // `emu avd name` prints the name, then "OK" on its own line.
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && line !== "OK");
    } catch {
      return undefined;
    }
  }
}
