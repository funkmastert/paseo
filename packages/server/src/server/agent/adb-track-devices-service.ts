/**
 * Owns the daemon's one `adb track-devices -l` child — live physical-Android detection
 * (docs/device-leases.md, Physical devices). Connections change constantly, so this is a
 * standing child process, not a poll: adb blocks on the socket and streams a frame per
 * connect/disconnect.
 *
 * Restarts with backoff if the child dies (the adb server restarting kills it too — `adb
 * kill-server` from anywhere on the machine takes this down with it). Stays off, quietly, when
 * `adb` isn't installed: an ENOENT is not a crash to retry, it is the answer.
 *
 * The child's pid is written to a file so the next daemon start can kill one a crashed worker
 * left behind: an orphaned `adb track-devices` is reparented to pid 1 and lives until its next
 * write hits the closed pipe, which is the next device event — possibly days.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
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

export interface AdbTrackDevicesPidFile {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface AdbTrackDevicesServiceOptions {
  onDevicesChanged: (devices: AdbTrackedDevice[]) => void;
  logger: AdbTrackDevicesServiceLogger;
  adbPath?: string;
  spawnProcess?: AdbTrackDevicesServiceSpawn;
  /** Backoff schedule in ms, the last entry repeating. Exposed for tests. */
  restartDelaysMs?: readonly number[];
  /** Where the live child's pid is kept. No file, no orphan sweep. */
  pidFile?: AdbTrackDevicesPidFile;
  /** A process's full command line, or undefined when it isn't running. */
  readProcessCommand?: (pid: number) => Promise<string | undefined>;
  killProcess?: (pid: number) => void;
}

/** A pid file at `path`, written and removed best-effort. */
export function createAdbTrackDevicesPidFile(path: string): AdbTrackDevicesPidFile {
  return {
    read: async () => {
      try {
        return (await readFile(path, "utf8")).trim();
      } catch {
        return undefined;
      }
    },
    write: async (value) => {
      await writeFile(path, value, "utf8");
    },
    remove: async () => {
      await rm(path, { force: true });
    },
  };
}

/** `ps -o command=` for one pid. POSIX only: on Windows there is no cheap, trustworthy way to
 * confirm a pid is still ours, and killing a reused pid would be worse than one orphan. */
async function defaultReadProcessCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  return await new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}

const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class AdbTrackDevicesService {
  private readonly onDevicesChanged: (devices: AdbTrackedDevice[]) => void;
  private readonly logger: AdbTrackDevicesServiceLogger;
  private readonly adbPath: string;
  private readonly spawnProcess: AdbTrackDevicesServiceSpawn;
  private readonly restartDelaysMs: readonly number[];
  private readonly pidFile: AdbTrackDevicesPidFile | undefined;
  private readonly readProcessCommand: (pid: number) => Promise<string | undefined>;
  private readonly killProcess: (pid: number) => void;

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
    this.pidFile = options.pidFile;
    this.readProcessCommand = options.readProcessCommand ?? defaultReadProcessCommand;
    this.killProcess = options.killProcess ?? ((pid) => process.kill(pid));
  }

  /**
   * Kills the `adb track-devices` a crashed daemon left behind, when the pid file names one that
   * is still running and still is that command. Anything else at that pid is left alone.
   */
  async sweepOrphan(): Promise<void> {
    if (!this.pidFile) return;
    const recorded = Number.parseInt((await this.pidFile.read()) ?? "", 10);
    if (!Number.isInteger(recorded) || recorded <= 0 || recorded === this.child?.pid) return;
    const command = await this.readProcessCommand(recorded);
    if (!command || !/\badb\b/.test(command) || !command.includes("track-devices")) return;
    try {
      this.killProcess(recorded);
      this.logger.info({ pid: recorded }, "Killed an adb track-devices left by a previous daemon");
    } catch (error) {
      this.logger.warn(
        { err: error, pid: recorded },
        "Could not kill a leftover adb track-devices",
      );
    }
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
    const hadChild = this.child !== undefined;
    this.child?.removeAllListeners();
    this.child?.kill();
    this.child = undefined;
    if (hadChild) void this.pidFile?.remove().catch(() => undefined);
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
    if (child.pid !== undefined) {
      void this.pidFile?.write(String(child.pid)).catch((error) => {
        this.logger.warn({ err: error }, "Could not record the adb track-devices pid");
      });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      for (const payload of this.reader.push(chunk)) {
        // A frame is a healthy child: the next failure starts the backoff from the bottom.
        this.restartAttempt = 0;
        this.onDevicesChanged(parseAdbDeviceListPayload(payload));
      }
    });
    child.once("error", (error) => {
      if (this.child === child) this.child = undefined;
      this.handleSpawnFailure(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      // Nothing is known about connected phones until the next child reports. An empty list
      // starts their leases' grace period; the first frame of the restart ends it.
      this.onDevicesChanged([]);
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
    // A child can report both `error` and `exit`; one restart is enough.
    if (this.stopped || this.restartTimer) return;
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
