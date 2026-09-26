/**
 * Tells "the process was suspended" apart from "the event loop was blocked".
 *
 * Both look identical from the main thread: a timer that should have fired every `tickMs`
 * fires 40 s late. macOS suspends the whole daemon process (sleep, App Nap, the user closing a
 * lid), so a detector that reads that gap as a wedge false-alarms on every resume and gets
 * muted within a day.
 *
 * Three independent signals separate the two, and any one of them is enough to call a gap a
 * suspension:
 *
 * 1. The watchdog thread went quiet too. A blocked main thread leaves the watchdog running; a
 *    suspended process stops every thread. This is the primary signal, and the only one that
 *    still works when the blocked main thread is asleep in a synchronous syscall, where it
 *    burns no CPU and looks exactly like a suspension to a CPU-time check.
 * 2. The monotonic clock advanced less than the wall clock. macOS and Linux stop the monotonic
 *    clock across system sleep.
 * 3. (Reported, not decisive.) Process CPU time over the gap. A suspended process consumes none;
 *    a wedge in JS consumes a core. It labels a wedge `busy` or `blocked` and corroborates a
 *    suspension, but a thread parked in `execFileSync` also consumes none, so it cannot
 *    separate the two on its own.
 *
 * Pure so every branch is testable without real time or real threads. The threads live in
 * `watchdog-worker.ts`.
 */

export interface StallThresholds {
  /** How often the main thread ticks. A gap is measured against this. */
  tickMs: number;
  /** Main-thread block, net of suspension, worth recording at all. */
  slowStallMs: number;
  /** Main-thread block, net of suspension, that is a wedge (the daemon is unusable). */
  wedgeMs: number;
  /** Silence from the watchdog thread that means the whole process was paused. */
  suspendMs: number;
}

export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  tickMs: 250,
  slowStallMs: 500,
  wedgeMs: 5_000,
  suspendMs: 2_000,
};

export interface TickSample {
  /** Wall clock (Date.now) when the main thread ticked. */
  wallMs: number;
  /** Monotonic clock in ms. Stops across system sleep on macOS and Linux. */
  monoMs: number;
  /** Process CPU time (user + system) in ms, all threads. */
  cpuMs: number;
  /** Wall clock of the watchdog thread's most recent tick. */
  watchdogTickWallMs: number;
  /** Cumulative ms the watchdog thread has seen the whole process paused. */
  watchdogPausedTotalMs: number;
}

export type StallKind = "wedge" | "stall" | "suspension";

/** `busy`: the process burned CPU through the block. `blocked`: it sat in a syscall or wait. */
export type StallCause = "busy" | "blocked";

export interface StallEpisode {
  kind: StallKind;
  /** Wall clock of the last tick before the gap. */
  startedAtMs: number;
  /** Wall clock of the first tick after it. */
  endedAtMs: number;
  /** Wall time the gap ran past the expected tick. */
  lateMs: number;
  /** The part of `lateMs` the main thread was actually blocked. Zero for a pure suspension. */
  blockedMs: number;
  /** The part of `lateMs` the whole process was paused (sleep, SIGSTOP, App Nap). */
  suspendedMs: number;
  /** System sleep seen only through the wall/monotonic disagreement. */
  sleptMs: number;
  /** CPU seconds per wall second over the gap, net of suspension. About 1 is one busy core. */
  cpuRatio: number;
  cause: StallCause;
}

/** At or above this a block is `busy`; below it the process was waiting, not computing. */
export const BUSY_CPU_RATIO = 0.5;

export function classifyGap(input: {
  thresholds: StallThresholds;
  wallGapMs: number;
  monoGapMs: number;
  cpuDeltaMs: number;
  /** Watchdog pause published for this interval. */
  watchdogPausedMs: number;
  /** How long the watchdog thread has been silent as of this tick. */
  watchdogSilentMs: number;
}): Omit<StallEpisode, "startedAtMs" | "endedAtMs"> | null {
  const { thresholds } = input;
  const lateMs = Math.max(0, input.wallGapMs - thresholds.tickMs);
  if (lateMs < Math.min(thresholds.slowStallMs, thresholds.suspendMs)) return null;

  const sleptMs = Math.max(0, input.wallGapMs - input.monoGapMs);
  // Silence only counts once it is long enough to mean a paused process rather than a busy
  // machine, the same bar the watchdog applies before it publishes a pause.
  const watchdogSilentMs =
    input.watchdogSilentMs >= thresholds.suspendMs ? input.watchdogSilentMs : 0;
  const suspendedRaw = Math.max(input.watchdogPausedMs, watchdogSilentMs, sleptMs);
  const suspendedMs = Math.min(lateMs, suspendedRaw);
  const blockedMs = lateMs - suspendedMs;
  const awakeMs = Math.max(1, input.wallGapMs - suspendedMs);
  const cpuRatio = Math.max(0, input.cpuDeltaMs) / awakeMs;
  const cause: StallCause = cpuRatio >= BUSY_CPU_RATIO ? "busy" : "blocked";

  if (blockedMs >= thresholds.wedgeMs) {
    return { kind: "wedge", lateMs, blockedMs, suspendedMs, sleptMs, cpuRatio, cause };
  }
  if (blockedMs >= thresholds.slowStallMs) {
    return { kind: "stall", lateMs, blockedMs, suspendedMs, sleptMs, cpuRatio, cause };
  }
  if (suspendedMs >= thresholds.suspendMs) {
    return { kind: "suspension", lateMs, blockedMs, suspendedMs, sleptMs, cpuRatio, cause };
  }
  return null;
}

/**
 * Carries the previous tick between samples so the caller only hands over the current one.
 * Returns an episode when the interval that just ended was a stall, a wedge or a suspension.
 */
export class StallTracker {
  private previous: TickSample | null = null;
  private pausedAccountedMs = 0;

  constructor(private readonly thresholds: StallThresholds) {}

  onTick(sample: TickSample): StallEpisode | null {
    const previous = this.previous;
    this.previous = sample;
    // A pause the watchdog publishes after this tick (it can lose the race on resume) is consumed
    // by a later, on-time tick and ignored; only a pause inside a late interval means anything.
    const pausedDelta = Math.max(0, sample.watchdogPausedTotalMs - this.pausedAccountedMs);
    this.pausedAccountedMs = sample.watchdogPausedTotalMs;
    if (!previous) return null;

    const episode = classifyGap({
      thresholds: this.thresholds,
      wallGapMs: sample.wallMs - previous.wallMs,
      monoGapMs: sample.monoMs - previous.monoMs,
      cpuDeltaMs: sample.cpuMs - previous.cpuMs,
      watchdogPausedMs: pausedDelta,
      watchdogSilentMs: sample.wallMs - sample.watchdogTickWallMs,
    });
    if (!episode) return null;
    return { ...episode, startedAtMs: previous.wallMs, endedAtMs: sample.wallMs };
  }
}
