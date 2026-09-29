import type { SystemMemorySample } from "./process-sampler.js";

/**
 * The memory brake (docs/resource-monitor.md, "Holding child admission"): holds new child turns
 * while macOS reports memory pressure or swap is growing fast, and lets go only after a run of
 * calm sweeps. It never acts on a running process. Pure: the monitor keeps the state between
 * sweeps and owns the hold.
 *
 * Absolute swap used is deliberately not a signal. macOS swap is sticky: on 2026-09-28 it still
 * held 42.7 of 44 GB at 05:23Z, an hour after the jetsam storm ended, so a hold on it would have
 * re-armed every sweep until a reboot.
 *
 * The thresholds are fixed until agents.resourceMonitor grows a memory block.
 */

const GIBIBYTE = 1024 ** 3;

/** `kern.memorystatus_vm_pressure_level` values. */
export const MEMORY_PRESSURE_NORMAL = 1;
export const MEMORY_PRESSURE_WARN = 2;
export const MEMORY_PRESSURE_CRITICAL = 4;
/** Swap that grew this much since the last sweep is the machine paging out right now. */
export const MEMORY_BRAKE_SWAP_GROWTH_BYTES = GIBIBYTE;
/**
 * Growth under this per sweep counts as steady: swap on a calm Mac drifts by tens of MB. Between
 * this and the growth line the brake neither holds nor counts toward a release.
 */
export const MEMORY_BRAKE_SWAP_STEADY_BYTES = 128 * 1024 ** 2;
/**
 * Calm sweeps in a row (60s apart) before the hold lets go. Pressure falls back to normal as soon
 * as the compressor finds room, and a new child turn takes minutes to reach its peak (installs,
 * Gradle, test browsers), so a single calm reading proves little. Five is five minutes of normal
 * pressure with swap steady, longer than the CPU rung's three-sweep clear.
 */
export const MEMORY_BRAKE_RELEASE_SWEEPS = 5;
/**
 * A hold this old is worth telling a person about. Warn can last hours on a 64 GB Mac: on 09-28
 * the compressor held about 32 GB until a reboot, and pressure stayed off normal all that time.
 */
export const MEMORY_HOLD_NOTICE_MS = 15 * 60_000;
/**
 * After this long held with pressure no worse than warn, swap not growing past the hold line and
 * a reading every sweep, the monitor lets one queued child through per sweep. A hold that never
 * lets go stalls every child turn for as long as warn lasts, while one new turn a minute is
 * something the brake sees the effect of before the next.
 */
export const MEMORY_HOLD_TRICKLE_AFTER_MS = 30 * 60_000;

export interface MemoryBrakeState {
  held: boolean;
  /** Consecutive calm sweeps while held. */
  calmSweeps: number;
  /** Swap used at the last sweep that read it, to measure growth. */
  lastSwapUsedBytes: number | undefined;
  /** When the hold started; undefined while not held. */
  heldSinceMs?: number;
  /**
   * While held: the hold's start, or the last sweep since that was critical, grew swap by the
   * hold line or had no reading, whichever is later. The trickle waits on it.
   */
  settledSinceMs?: number;
}

export interface MemoryBrakeResult {
  next: MemoryBrakeState;
  transition: "held" | "released" | "none";
  /** The kernel says critical this sweep. */
  critical: boolean;
  /** Why it holds, or why it let go; empty when nothing changed. */
  detail: string;
  /** How long the hold has lasted; 0 when not held. */
  heldForMs: number;
  /** Held, and settled for `MEMORY_HOLD_TRICKLE_AFTER_MS`: one queued child may go this sweep. */
  trickle: boolean;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / GIBIBYTE).toFixed(1)} GB`;
}

export function describePressure(level: number): string {
  if (level >= MEMORY_PRESSURE_CRITICAL) return "critical";
  if (level >= MEMORY_PRESSURE_WARN) return "warn";
  return "normal";
}

export function evaluateMemoryBrake(
  sample: SystemMemorySample | undefined,
  previous: MemoryBrakeState | undefined,
  nowMs: number,
): MemoryBrakeResult {
  const prior = previous ?? { held: false, calmSweeps: 0, lastSwapUsedBytes: undefined };
  const lastSwapUsedBytes = sample?.swapUsedBytes ?? prior.lastSwapUsedBytes;
  const pressure = sample?.memoryPressureLevel;
  if (!sample || pressure === undefined) {
    // No reading: not macOS, or sysctl failed. A hold stays, and a calm run needs unbroken readings.
    return withHoldClock(
      {
        next: { held: prior.held, calmSweeps: 0, lastSwapUsedBytes },
        transition: "none",
        critical: false,
        detail: "",
      },
      prior,
      nowMs,
      false,
    );
  }

  const growth =
    prior.lastSwapUsedBytes === undefined ? 0 : sample.swapUsedBytes - prior.lastSwapUsedBytes;
  const critical = pressure >= MEMORY_PRESSURE_CRITICAL;
  const settled = !critical && growth < MEMORY_BRAKE_SWAP_GROWTH_BYTES;
  const swap = `swap ${formatGigabytes(sample.swapUsedBytes)} of ${formatGigabytes(sample.swapTotalBytes)}`;

  if (pressure >= MEMORY_PRESSURE_WARN || growth >= MEMORY_BRAKE_SWAP_GROWTH_BYTES) {
    const why =
      pressure >= MEMORY_PRESSURE_WARN
        ? `memory pressure ${describePressure(pressure)} (${pressure}), ${swap}`
        : `swap grew ${formatGigabytes(growth)} since the last sweep, ${swap}`;
    return withHoldClock(
      {
        next: { held: true, calmSweeps: 0, lastSwapUsedBytes },
        transition: prior.held ? "none" : "held",
        critical,
        detail: prior.held ? "" : why,
      },
      prior,
      nowMs,
      settled,
    );
  }

  const calm = growth < MEMORY_BRAKE_SWAP_STEADY_BYTES;
  if (!prior.held || !calm) {
    return withHoldClock(
      {
        next: { held: prior.held, calmSweeps: 0, lastSwapUsedBytes },
        transition: "none",
        critical,
        detail: "",
      },
      prior,
      nowMs,
      settled,
    );
  }
  const calmSweeps = prior.calmSweeps + 1;
  if (calmSweeps < MEMORY_BRAKE_RELEASE_SWEEPS) {
    return withHoldClock(
      {
        next: { held: true, calmSweeps, lastSwapUsedBytes },
        transition: "none",
        critical,
        detail: "",
      },
      prior,
      nowMs,
      settled,
    );
  }
  return withHoldClock(
    {
      next: { held: false, calmSweeps: 0, lastSwapUsedBytes },
      transition: "released",
      critical,
      detail: `memory pressure normal and swap steady for ${calmSweeps} sweeps, ${swap}`,
    },
    prior,
    nowMs,
    settled,
  );
}

/**
 * Carries the hold's start and its settled clock into the next state, and reads the long-hold
 * facts off them. `settled` is this sweep: a reading, not critical, swap under the hold line.
 */
function withHoldClock(
  result: Omit<MemoryBrakeResult, "heldForMs" | "trickle">,
  prior: MemoryBrakeState,
  nowMs: number,
  settled: boolean,
): MemoryBrakeResult {
  if (!result.next.held) return { ...result, heldForMs: 0, trickle: false };
  const heldSinceMs = prior.held ? (prior.heldSinceMs ?? nowMs) : nowMs;
  const settledSinceMs = prior.held && settled ? (prior.settledSinceMs ?? nowMs) : nowMs;
  return {
    ...result,
    next: { ...result.next, heldSinceMs, settledSinceMs },
    heldForMs: nowMs - heldSinceMs,
    trickle: settled && nowMs - settledSinceMs >= MEMORY_HOLD_TRICKLE_AFTER_MS,
  };
}
