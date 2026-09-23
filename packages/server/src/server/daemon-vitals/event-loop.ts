import { mkdirSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  DEFAULT_STALL_THRESHOLDS,
  StallTracker,
  type StallEpisode,
  type StallThresholds,
} from "./stall-tracker.js";
import type { SlowOpRecorder } from "./slow-ops.js";
import { daemonVitalsPath, type DaemonVitalsEpisode } from "./vitals-file.js";
import { startWatchdog, type Watchdog } from "./watchdog-worker.js";

/**
 * Event-loop wedge detector.
 *
 * A daemon can hold its pid and its port while its event loop is blocked, and then nothing that
 * runs on that loop can say so: every agent stops, and the websocket, the push sender and the
 * health endpoint all go quiet together. Two threads make that visible. The main thread ticks
 * and classifies each late tick (`stall-tracker.ts`); the watchdog thread keeps the heartbeat
 * file current while the main thread is stuck, so `paseo daemon status` can say "wedged for 41s"
 * during the wedge rather than only afterwards. Anything that has to be sent is sent on the
 * first tick after recovery, because nothing can be sent before it.
 */

const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_SUMMARY_MS = 30_000;
const MAX_EPISODES = 10;
const NS_PER_MS = 1_000_000;

interface EventLoopLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface EventLoopMonitorOptions {
  paseoHome: string;
  thresholds?: Partial<StallThresholds>;
  dryRun: boolean;
  logger: EventLoopLogger;
  slowOps?: SlowOpRecorder | null;
  /** Called once per wedge, on the first tick after the loop recovers. */
  onWedgeRecovered?: (episode: StallEpisode) => void;
  heartbeatMs?: number;
  summaryMs?: number;
}

export interface EventLoopSnapshot {
  /** False when the watchdog thread could not start or has died; nothing is being classified. */
  available: boolean;
  counts: { wedges: number; stalls: number; suspensions: number };
  lag: { p50Ms: number; p99Ms: number; maxMs: number } | null;
  episodes: DaemonVitalsEpisode[];
}

export class EventLoopMonitor {
  private readonly options: EventLoopMonitorOptions;
  private readonly thresholds: StallThresholds;
  private readonly tracker: StallTracker;
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  private watchdog: Watchdog | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private available = false;
  private readonly counts = { wedges: 0, stalls: 0, suspensions: 0 };
  private episodes: DaemonVitalsEpisode[] = [];
  private lag: EventLoopSnapshot["lag"] = null;

  constructor(options: EventLoopMonitorOptions) {
    this.options = options;
    this.thresholds = { ...DEFAULT_STALL_THRESHOLDS, ...options.thresholds };
    this.tracker = new StallTracker(this.thresholds);
  }

  start(): boolean {
    if (this.watchdog) return this.available;
    const filePath = daemonVitalsPath(this.options.paseoHome);
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      this.watchdog = startWatchdog({
        data: {
          filePath,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          ...this.thresholds,
          heartbeatMs: this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
          dryRun: this.options.dryRun,
        },
        onError: (error) => {
          this.available = false;
          this.options.logger.warn({ err: error }, "Daemon vitals watchdog thread failed");
        },
      });
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "Daemon vitals watchdog thread could not start; wedge detection is off",
      );
      return false;
    }
    this.available = true;
    this.histogram.enable();
    this.tick();
    const tickTimer = setInterval(() => this.tick(), this.thresholds.tickMs);
    tickTimer.unref();
    this.tickTimer = tickTimer;
    const summaryTimer = setInterval(
      () => this.publishSummary(true),
      this.options.summaryMs ?? DEFAULT_SUMMARY_MS,
    );
    summaryTimer.unref();
    this.summaryTimer = summaryTimer;
    this.publishSummary(false);
    return true;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.tickTimer = null;
    this.summaryTimer = null;
    this.histogram.disable();
    const watchdog = this.watchdog;
    this.watchdog = null;
    this.available = false;
    if (watchdog) {
      watchdog.sendSummary(this.buildSummary());
      await watchdog.stop(new Date().toISOString());
    }
  }

  snapshot(): EventLoopSnapshot {
    return {
      available: this.available,
      counts: { ...this.counts },
      lag: this.lag,
      episodes: [...this.episodes],
    };
  }

  private tick(): void {
    const watchdog = this.watchdog;
    if (!watchdog || !this.available) return;
    const wallMs = Date.now();
    const cpu = process.cpuUsage();
    const episode = this.tracker.onTick({
      wallMs,
      monoMs: Number(process.hrtime.bigint()) / NS_PER_MS,
      cpuMs: (cpu.user + cpu.system) / 1000,
      watchdogTickWallMs: watchdog.readWatchdogTickWallMs(),
      watchdogPausedTotalMs: watchdog.readPausedTotalMs(),
    });
    watchdog.markMainTick(wallMs);
    if (episode) this.handleEpisode(episode);
  }

  private handleEpisode(episode: StallEpisode): void {
    const fields = {
      startedAt: new Date(episode.startedAtMs).toISOString(),
      blockedMs: Math.round(episode.blockedMs),
      suspendedMs: Math.round(episode.suspendedMs),
      sleptMs: Math.round(episode.sleptMs),
      cpuRatio: Math.round(episode.cpuRatio * 100) / 100,
      cause: episode.cause,
      dryRun: this.options.dryRun,
    };
    this.episodes = [
      ...this.episodes.slice(-(MAX_EPISODES - 1)),
      {
        kind: episode.kind,
        startedAt: fields.startedAt,
        endedAt: new Date(episode.endedAtMs).toISOString(),
        blockedMs: fields.blockedMs,
        suspendedMs: fields.suspendedMs,
        cpuRatio: fields.cpuRatio,
        cause: episode.cause,
      },
    ];

    if (episode.kind === "suspension") {
      this.counts.suspensions += 1;
      // The loop looked late because the process was not running. That gap must not leak into
      // the lag percentiles, which would report a 60 s worst case for a closed lid.
      this.histogram.reset();
      this.options.logger.info(
        fields,
        "Daemon process was suspended; not counted as an event-loop stall",
      );
    } else if (episode.kind === "stall") {
      this.counts.stalls += 1;
      this.options.slowOps?.record("event-loop:stall", episode.blockedMs, fields);
      this.options.logger.info(fields, "Event loop stalled");
    } else {
      this.counts.wedges += 1;
      this.options.slowOps?.record("event-loop:wedge", episode.blockedMs, fields);
      this.options.logger.warn(fields, "Event loop was wedged and has recovered");
      this.options.onWedgeRecovered?.(episode);
    }
    this.publishSummary(episode.kind === "suspension");
  }

  private publishSummary(resetHistogram: boolean): void {
    if (this.histogram.count > 0) {
      this.lag = {
        p50Ms: toMs(this.histogram.percentile(50)),
        p99Ms: toMs(this.histogram.percentile(99)),
        maxMs: toMs(this.histogram.max),
      };
    }
    if (resetHistogram) this.histogram.reset();
    this.watchdog?.sendSummary(this.buildSummary());
  }

  private buildSummary(): Omit<EventLoopSnapshot, "available"> {
    return {
      lag: this.lag,
      counts: { ...this.counts },
      episodes: this.episodes,
    };
  }
}

function toMs(nanoseconds: number): number {
  return Math.round(nanoseconds / 1e5) / 10;
}
