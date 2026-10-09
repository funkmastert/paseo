/**
 * The disk brake (docs/resource-monitor.md, "The disk brake"): holds new child turns while free
 * disk is low or falling fast, and lets go once it has recovered past the low line with a
 * margin and stopped falling. It never acts on a running process. Pure: the monitor keeps the
 * state between sweeps and owns the hold.
 *
 * Built after 2026-10-08, when an iOS and an Android build ran together for an hour, free disk
 * fell to 32 GB on a 926 GB volume and the machine had to be forced off. Swap tripped the memory
 * brake once for five minutes; nothing read the disk. The fall is the early signal: at 13:19 the
 * machine still had 32 GB, well above any low line, and was losing about 25 GB every 15 minutes.
 */

import { advanceHoldClock } from "./brake-hold-clock.js";
import { formatGigabytes, GIBIBYTE } from "./gigabytes.js";

/**
 * After this long held with the disk not falling and not critical, the monitor lets one queued
 * child through per sweep. A low disk that sits still is not getting worse, and a hold that never
 * lets go would stall every child turn until someone frees space. Same as the memory brake's.
 */
export const DISK_HOLD_TRICKLE_AFTER_MS = 30 * 60_000;
/** Less than this lost within the fall window counts as not falling, for the trickle. */
export const DISK_TRICKLE_MAX_FALL_BYTES = GIBIBYTE;

export interface DiskBrakeConfig {
  /** Free space under this holds: `agents.remediation.disk.lowFreeGB`. */
  lowFreeBytes: number;
  /** Free space under this is critical: `diskSweeper.minFreeGB`. Holds, and never trickles. */
  criticalFreeBytes: number;
  /** A hold on low free space lets go only at `lowFreeBytes` plus this. */
  releaseMarginBytes: number;
  /** Losing this much within `fallWindowMs` holds, however much is free. */
  fallBytes: number;
  fallWindowMs: number;
}

export interface DiskReading {
  atMs: number;
  freeBytes: number;
}

export interface DiskBrakeState {
  held: boolean;
  /** Readings inside the fall window, oldest first. */
  history: DiskReading[];
  /** When the hold started; undefined while not held. */
  heldSinceMs?: number;
  /**
   * While held: the hold's start, or the last sweep since that was critical, had fallen by
   * `DISK_TRICKLE_MAX_FALL_BYTES` within the window or had no reading, whichever is later.
   */
  settledSinceMs?: number;
}

export type DiskCondition = "critical" | "low" | "falling";

export interface DiskBrakeResult {
  next: DiskBrakeState;
  transition: "held" | "released" | "none";
  /** This sweep's reading; undefined when free space could not be read. */
  freeBytes: number | undefined;
  /** The highest reading in the window minus this one; 0 with no reading. */
  fallBytes: number;
  /** What is true this sweep, worst first. */
  conditions: DiskCondition[];
  /** Why it holds, or why it let go; empty when nothing changed. */
  detail: string;
  /** How long the hold has lasted; 0 when not held. */
  heldForMs: number;
  /** Held, and settled for `DISK_HOLD_TRICKLE_AFTER_MS`: one queued child may go this sweep. */
  trickle: boolean;
}

function describeConditions(input: {
  conditions: readonly DiskCondition[];
  freeBytes: number;
  fallBytes: number;
  config: DiskBrakeConfig;
}): string {
  const { config, freeBytes } = input;
  const free = `${formatGigabytes(freeBytes)} free`;
  const window = Math.round(config.fallWindowMs / 60_000);
  const parts: string[] = [];
  if (input.conditions.includes("critical")) {
    parts.push(
      `disk critical: ${free}, under the ${formatGigabytes(config.criticalFreeBytes)} floor`,
    );
  } else if (input.conditions.includes("low")) {
    parts.push(`disk low: ${free}, under the ${formatGigabytes(config.lowFreeBytes)} line`);
  }
  if (input.conditions.includes("falling")) {
    parts.push(
      `disk falling fast: fell ${formatGigabytes(input.fallBytes)} in the last ${window} min, ${free}`,
    );
  }
  return parts.join("; ");
}

export function evaluateDiskBrake(input: {
  freeBytes: number | undefined;
  previous: DiskBrakeState | undefined;
  config: DiskBrakeConfig;
  nowMs: number;
}): DiskBrakeResult {
  const { config, nowMs, freeBytes } = input;
  const prior = input.previous ?? { held: false, history: [] };
  const recent = prior.history.filter((reading) => nowMs - reading.atMs <= config.fallWindowMs);
  if (freeBytes === undefined) {
    // No reading: statfs failed. A hold stays, and the trickle needs unbroken readings.
    return withHoldClock({
      result: {
        next: { held: prior.held, history: recent },
        transition: "none",
        freeBytes: undefined,
        fallBytes: 0,
        conditions: [],
        detail: "",
      },
      prior,
      nowMs,
      settled: false,
    });
  }

  const history = [...recent, { atMs: nowMs, freeBytes }];
  const peak = Math.max(...history.map((reading) => reading.freeBytes));
  const fallBytes = peak - freeBytes;
  const conditions: DiskCondition[] = [];
  if (freeBytes < config.criticalFreeBytes) conditions.push("critical");
  if (freeBytes < config.lowFreeBytes) conditions.push("low");
  if (fallBytes >= config.fallBytes) conditions.push("falling");
  const settled = !conditions.includes("critical") && fallBytes < DISK_TRICKLE_MAX_FALL_BYTES;
  const base = { freeBytes, fallBytes, conditions };

  if (conditions.length > 0) {
    return withHoldClock({
      result: {
        ...base,
        next: { held: true, history },
        transition: prior.held ? "none" : "held",
        detail: prior.held ? "" : describeConditions({ conditions, freeBytes, fallBytes, config }),
      },
      prior,
      nowMs,
      settled,
    });
  }

  // Hysteresis: released only past the low line plus the margin, and with the fall in the window
  // under half the hold line, so a disk hovering at either line does not flap the hold.
  const recovered =
    freeBytes >= config.lowFreeBytes + config.releaseMarginBytes &&
    fallBytes < config.fallBytes / 2;
  if (!prior.held || !recovered) {
    return withHoldClock({
      result: { ...base, next: { held: prior.held, history }, transition: "none", detail: "" },
      prior,
      nowMs,
      settled,
    });
  }
  const window = Math.round(config.fallWindowMs / 60_000);
  return withHoldClock({
    result: {
      ...base,
      next: { held: false, history },
      transition: "released",
      detail:
        `disk recovered: ${formatGigabytes(freeBytes)} free, fell ` +
        `${formatGigabytes(fallBytes)} in the last ${window} min`,
    },
    prior,
    nowMs,
    settled,
  });
}

/**
 * Carries the hold's start and its settled clock into the next state, and reads the long-hold
 * facts off them, as the memory brake does.
 */
function withHoldClock(input: {
  result: Omit<DiskBrakeResult, "heldForMs" | "trickle">;
  prior: DiskBrakeState;
  nowMs: number;
  settled: boolean;
}): DiskBrakeResult {
  const { result, prior, nowMs, settled } = input;
  const clock = advanceHoldClock({
    next: result.next,
    prior,
    nowMs,
    settled,
    trickleAfterMs: DISK_HOLD_TRICKLE_AFTER_MS,
  });
  return { ...result, ...clock };
}
