/**
 * Polls `xcrun devicectl list devices --json-output <file>` for live physical-iOS detection
 * (docs/device-leases.md, Physical devices). Polling, not a stream — unlike `adb track-devices`,
 * devicectl has no watch mode. macOS only, and quietly off when Xcode command line tools are
 * missing (an ENOENT on the first attempt turns polling off for good; it is not a crash to retry).
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevicectlDevicesJson, type DevicectlPhysicalDevice } from "./device-devicectl.js";

export interface DevicectlPollingServiceLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface DevicectlPollingServiceRunner {
  (outputPath: string): Promise<void>;
}

export interface DevicectlPollingServiceOptions {
  onDevicesChanged: (devices: DevicectlPhysicalDevice[]) => void;
  logger: DevicectlPollingServiceLogger;
  intervalMs?: number;
  /** Runs `devicectl list devices --json-output <outputPath>`, writing the file. Injectable for
   * tests; the default shells out via execFile and checks `process.platform`. */
  runDevicectl?: DevicectlPollingServiceRunner;
  platform?: NodeJS.Platform;
}

const DEFAULT_INTERVAL_MS = 15_000;

async function defaultRunDevicectl(outputPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "xcrun",
      ["devicectl", "list", "devices", "--json-output", outputPath],
      { timeout: 10_000 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

export class DevicectlPollingService {
  private readonly onDevicesChanged: (devices: DevicectlPhysicalDevice[]) => void;
  private readonly logger: DevicectlPollingServiceLogger;
  private readonly intervalMs: number;
  private readonly runDevicectl: DevicectlPollingServiceRunner;
  private readonly platform: NodeJS.Platform;

  private timer: ReturnType<typeof setInterval> | undefined;
  private unavailable = false;
  private polling = false;

  constructor(options: DevicectlPollingServiceOptions) {
    this.onDevicesChanged = options.onDevicesChanged;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.runDevicectl = options.runDevicectl ?? defaultRunDevicectl;
    this.platform = options.platform ?? process.platform;
  }

  start(): void {
    if (this.timer || this.platform !== "darwin") return;
    this.unavailable = false;
    void this.poll();
    const timer = setInterval(() => void this.poll(), this.intervalMs);
    timer.unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  private async poll(): Promise<void> {
    if (this.unavailable || this.polling) return;
    this.polling = true;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "paseo-devicectl-"));
      const outputPath = join(dir, "devices.json");
      await this.runDevicectl(outputPath);
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      this.onDevicesChanged(parseDevicectlDevicesJson(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        this.unavailable = true;
        this.stop();
        this.logger.info(
          {},
          "Xcode command line tools are not installed; physical iOS detection is off",
        );
      } else {
        this.logger.warn({ err: error }, "devicectl poll failed; will retry next interval");
      }
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.polling = false;
    }
  }
}
