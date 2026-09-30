/**
 * Owns the daemon's one `adb track-devices -l` child — live physical-Android detection
 * (docs/device-leases.md, Physical devices). Connections change constantly, so this is a
 * standing child process, not a poll: adb blocks on the socket and streams a frame per
 * connect/disconnect.
 *
 * Restarts with backoff if the child dies (the adb server restarting kills it too — `adb
 * kill-server` from anywhere on the machine takes this down with it). Stays off, quietly, when
 * `adb` isn't installed: an ENOENT is not a crash to retry, it is the answer.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  AdbTrackDevicesFrameReader,
  parseAdbDeviceListPayload,
  type AdbTrackedDevice,
} from "./device-adb-track.js";

export interface AdbTrackDevicesServiceLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface AdbTrackDevicesServiceSpawn {
  (command: string, args: readonly string[]): ChildProcessWithoutNullStreams;
}

export interface AdbTrackDevicesServiceOptions {
  onDevicesChanged: (devices: AdbTrackedDevice[]) => void;
  logger: AdbTrackDevicesServiceLogger;
  adbPath?: string;
  spawnProcess?: AdbTrackDevicesServiceSpawn;
  /** Backoff schedule in ms, the last entry repeating. Exposed for tests. */
  restartDelaysMs?: readonly number[];
}

const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class AdbTrackDevicesService {
  private readonly onDevicesChanged: (devices: AdbTrackedDevice[]) => void;
  private readonly logger: AdbTrackDevicesServiceLogger;
  private readonly adbPath: string;
  private readonly spawnProcess: AdbTrackDevicesServiceSpawn;
  private readonly restartDelaysMs: readonly number[];

  private child: ChildProcessWithoutNullStreams | undefined;
  private reader = new AdbTrackDevicesFrameReader();
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  /** Set once an ENOENT is seen, so a later `stop`/`start` cycle doesn't keep retrying a binary
   * that was never there — but a fresh `start()` call (adb installed since) tries again. */
  private unavailable = false;

  constructor(options: AdbTrackDevicesServiceOptions) {
    this.onDevicesChanged = options.onDevicesChanged;
    this.logger = options.logger;
    this.adbPath = options.adbPath ?? "adb";
    this.spawnProcess =
      options.spawnProcess ?? ((command, args) => spawn(command, args as string[]));
    this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unavailable = false;
    this.restartAttempt = 0;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.child?.removeAllListeners();
    this.child?.kill();
    this.child = undefined;
  }

  get isRunning(): boolean {
    return this.child !== undefined;
  }

  private spawnChild(): void {
    if (this.stopped || this.unavailable) return;
    this.reader = new AdbTrackDevicesFrameReader();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.adbPath, ["track-devices", "-l"]);
    } catch (error) {
      this.handleSpawnFailure(error);
      return;
    }
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => {
      for (const payload of this.reader.push(chunk)) {
        this.onDevicesChanged(parseAdbDeviceListPayload(payload));
      }
    });
    child.once("error", (error) => {
      this.child = undefined;
      this.handleSpawnFailure(error);
    });
    child.once("exit", (code, signal) => {
      this.child = undefined;
      if (this.stopped) return;
      this.logger.warn({ code, signal }, "adb track-devices exited; restarting");
      this.scheduleRestart();
    });
  }

  private handleSpawnFailure(error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      this.unavailable = true;
      this.logger.info({}, "adb is not installed; physical Android detection is off");
      return;
    }
    this.logger.warn({ err: error }, "Failed to start adb track-devices; restarting");
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay =
      this.restartDelaysMs[Math.min(this.restartAttempt, this.restartDelaysMs.length - 1)] ??
      DEFAULT_RESTART_DELAYS_MS.at(-1);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.spawnChild();
    }, delay);
    this.restartTimer.unref?.();
  }
}
