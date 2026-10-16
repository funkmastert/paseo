/**
 * The hold clock the memory brake and the disk brake share (docs/resource-monitor.md): how long a
 * hold has lasted, and whether it has been settled long enough to let one queued child through
 * this sweep. Each brake decides what a settled sweep is; the clock rules are here once.
 */

export interface HoldClockState {
  held: boolean;
  /** When the hold started; undefined while not held. */
  heldSinceMs?: number;
  /** While held: the hold's start, or the last unsettled sweep since, whichever is later. */
  settledSinceMs?: number;
}

export interface HoldClockReading<S extends HoldClockState> {
  next: S;
  /** How long the hold has lasted; 0 when not held. */
  heldForMs: number;
  /** Held, and settled for `trickleAfterMs`: one queued child may go this sweep. */
  trickle: boolean;
}

/** Carries the hold's start and its settled clock into `next`, and reads the long-hold facts. */
export function advanceHoldClock<S extends HoldClockState>(input: {
  next: S;
  prior: HoldClockState;
  nowMs: number;
  /** This sweep may count toward a trickle, by the brake's own test. */
  settled: boolean;
  trickleAfterMs: number;
}): HoldClockReading<S> {
  const { next, prior, nowMs, settled } = input;
  if (!next.held) return { next, heldForMs: 0, trickle: false };
  const heldSinceMs = prior.held ? (prior.heldSinceMs ?? nowMs) : nowMs;
  const settledSinceMs = prior.held && settled ? (prior.settledSinceMs ?? nowMs) : nowMs;
  return {
    next: { ...next, heldSinceMs, settledSinceMs },
    heldForMs: nowMs - heldSinceMs,
    trickle: settled && nowMs - settledSinceMs >= input.trickleAfterMs,
  };
}
