import { Worker } from "node:worker_threads";

/**
 * The watchdog thread. It exists to be running when the main thread is not: it ticks on its own
 * event loop, keeps the heartbeat file current, and publishes the one fact the main thread
 * cannot see for itself, which is whether the whole process was paused.
 *
 * The worker is deliberately dumb. It measures its own tick gap and writes what it sees; every
 * decision lives in `stall-tracker.ts`, where it can be tested without threads. Its source is an
 * inline string run with `eval: true` so it resolves the same under tsx, the tsc build and the
 * packaged desktop app, none of which agree on where a sibling worker file would live.
 */

/** Slots in the shared `BigInt64Array`. Main and worker read and write these with Atomics. */
export const SharedSlot = {
  /** Wall ms of the main thread's last tick. Written by main. */
  MainTick: 0,
  /** Wall ms of the watchdog's last tick. Written by the watchdog. */
  WatchdogTick: 1,
  /** Cumulative ms the watchdog saw the whole process paused. */
  PausedTotal: 2,
  /** How many pauses that was. */
  PauseCount: 3,
} as const;

const SHARED_SLOTS = 4;

export interface WatchdogWorkerData {
  sharedBuffer: SharedArrayBuffer;
  filePath: string;
  pid: number;
  startedAt: string;
  tickMs: number;
  slowStallMs: number;
  wedgeMs: number;
  suspendMs: number;
  heartbeatMs: number;
  dryRun: boolean;
}

export type WatchdogInboundMessage =
  | { type: "summary"; summary: unknown }
  | { type: "stop"; stoppedAt: string };

const WATCHDOG_SOURCE = String.raw`
  const fs = require("node:fs");
  const { parentPort, workerData } = require("node:worker_threads");
  const data = workerData;
  const shared = new BigInt64Array(data.sharedBuffer);
  const MAIN_TICK = 0, WATCHDOG_TICK = 1, PAUSED_TOTAL = 2, PAUSE_COUNT = 3;

  let lastTick = Date.now();
  let lastMainTick = -1;
  let pausedSinceMainTick = 0;
  let lastWrite = 0;
  let summary = null;
  let stoppedAt;
  Atomics.store(shared, WATCHDOG_TICK, BigInt(lastTick));

  function write(now, mainTick, mainBlockedMs) {
    const body = JSON.stringify({
      schema: "paseo.daemon-vitals/v1",
      pid: data.pid,
      startedAt: data.startedAt,
      updatedAtMs: now,
      stoppedAt,
      mainTickAtMs: mainTick,
      mainBlockedMs,
      thresholds: {
        tickMs: data.tickMs,
        slowStallMs: data.slowStallMs,
        wedgeMs: data.wedgeMs,
        suspendMs: data.suspendMs,
      },
      dryRun: data.dryRun,
      summary,
    });
    const temp = data.filePath + "." + data.pid + ".tmp";
    try {
      fs.writeFileSync(temp, body);
      fs.renameSync(temp, data.filePath);
    } catch {
      // A heartbeat that cannot be written is retried a second later; it never stops the thread.
    }
    lastWrite = now;
  }

  function tick() {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    const mainTick = Number(Atomics.load(shared, MAIN_TICK));
    if (mainTick !== lastMainTick) {
      lastMainTick = mainTick;
      pausedSinceMainTick = 0;
    }
    // This thread was silent for far longer than its own tick: every thread in the process was
    // stopped, because nothing blocks this one but the OS. That is a suspension, whatever the
    // main thread was doing.
    const silent = gap - data.tickMs;
    if (silent >= data.suspendMs) {
      pausedSinceMainTick += silent;
      Atomics.add(shared, PAUSED_TOTAL, BigInt(silent));
      Atomics.add(shared, PAUSE_COUNT, 1n);
    }
    Atomics.store(shared, WATCHDOG_TICK, BigInt(now));
    if (now - lastWrite >= data.heartbeatMs) {
      write(now, mainTick, Math.max(0, now - mainTick - pausedSinceMainTick));
    }
  }

  const timer = setInterval(tick, data.tickMs);
  parentPort.on("message", (message) => {
    if (message.type === "summary") {
      summary = message.summary;
    } else if (message.type === "stop") {
      stoppedAt = message.stoppedAt;
      clearInterval(timer);
      write(Date.now(), Number(Atomics.load(shared, MAIN_TICK)), 0);
      process.exit(0);
    }
  });
  tick();
`;

export interface Watchdog {
  /** Marks the main thread alive. Cheap; called every tick. */
  markMainTick(wallMs: number): void;
  readWatchdogTickWallMs(): number;
  readPausedTotalMs(): number;
  sendSummary(summary: unknown): void;
  /** Writes a final heartbeat marked stopped, then ends the thread. */
  stop(stoppedAt: string): Promise<void>;
}

export interface StartWatchdogOptions {
  data: Omit<WatchdogWorkerData, "sharedBuffer">;
  onError: (error: Error) => void;
}

export function startWatchdog(options: StartWatchdogOptions): Watchdog {
  const sharedBuffer = new SharedArrayBuffer(SHARED_SLOTS * BigInt64Array.BYTES_PER_ELEMENT);
  const shared = new BigInt64Array(sharedBuffer);
  const now = Date.now();
  Atomics.store(shared, SharedSlot.MainTick, BigInt(now));
  Atomics.store(shared, SharedSlot.WatchdogTick, BigInt(now));

  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    workerData: { ...options.data, sharedBuffer } satisfies WatchdogWorkerData,
  });
  // The monitor must never keep the daemon alive, and a dead watchdog must never kill it.
  worker.unref();
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    worker.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  worker.on("error", options.onError);

  const post = (message: WatchdogInboundMessage): void => {
    if (exited) return;
    // A worker_threads port has no origin; the rule is written for window.postMessage.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage(message);
  };

  return {
    markMainTick(wallMs) {
      Atomics.store(shared, SharedSlot.MainTick, BigInt(Math.round(wallMs)));
    },
    readWatchdogTickWallMs() {
      return Number(Atomics.load(shared, SharedSlot.WatchdogTick));
    },
    readPausedTotalMs() {
      return Number(Atomics.load(shared, SharedSlot.PausedTotal));
    },
    sendSummary(summary) {
      post({ type: "summary", summary });
    },
    async stop(stoppedAt) {
      if (exited) return;
      post({ type: "stop", stoppedAt });
      // Bounded: a stuck watchdog must not hold up daemon shutdown.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref());
      await Promise.race([exitPromise, timeout]);
      if (!exited) await worker.terminate();
    },
  };
}
