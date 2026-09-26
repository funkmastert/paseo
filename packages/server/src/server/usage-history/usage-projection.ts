/**
 * Pure arithmetic for "at this rate the window caps in N hours". No I/O and no clock reads: the
 * caller passes `nowMs`, and the same inputs always give the same projection.
 *
 * The rules are about not lying. A projection that is wrong in the confident direction is worse
 * than none, because it is what someone acts on:
 *
 * - **Never extrapolate past a reset.** A window that resets before it would cap never caps. The
 *   cap time is reported only when it lands before `resetsAt`; otherwise the projection says where
 *   the window will stand at the reset.
 * - **Only the current cycle is evidence.** Samples from before the last reset (or before a
 *   `usedPct` drop) describe a different window that happened to have the same id.
 * - **Say "not enough data yet" rather than fit two points.** Fewer than `minSamples` readings, or
 *   a span shorter than `minSpanMinutes`, is `unknown` with the rule that stopped it.
 * - **A stale reading is not evidence about now.** The usage cache serves one snapshot for five
 *   minutes; a newest sample much older than that means the fetch stopped, so extrapolating from it
 *   would invent a "now".
 *
 * The rate is a least-squares slope over the trailing lookback, not the difference of the two ends:
 * `usedPct` is quantised to whole points and each reading can be up to five minutes old, so two
 * endpoints carry most of that error where a fit over a dozen readings averages it out.
 *
 * See docs/usage-history.md. Budget pacing (docs/budget-pacing.md) reads the same rows to advise
 * leaders; this module only produces facts and never acts on them.
 */

export interface WindowSample {
  /** When the provider snapshot was fetched (its own `fetchedAt`), not when a sweep read it. */
  atMs: number;
  usedPct: number;
  /** The window's reset time as reported with this sample, or null when it reported none. */
  resetsAtMs: number | null;
}

export type UnknownReason =
  | "insufficient_samples"
  | "short_span"
  | "no_reset_time"
  | "reset_passed"
  | "stale";

export type WindowProjection =
  | {
      status: "unknown";
      reason: UnknownReason;
      samples: number;
      spanMinutes: number;
    }
  | {
      status: "capped";
      samples: number;
      spanMinutes: number;
    }
  | {
      status: "projected";
      samples: number;
      spanMinutes: number;
      ratePctPerHour: number;
      /** Where the window stands at its reset, capped at 100. */
      projectedPctAtReset: number;
      /** Set only when the window reaches 100% before `resetsAt`. */
      capsAtMs: number | null;
      minutesToCap: number | null;
      confidence: "low" | "ok";
    };

export interface ProjectionConfig {
  /** Fewer readings than this is `unknown`. Three, not two: two points always fit a line. */
  minSamples: number;
  /** A shorter span than this is `unknown`. */
  minSpanMinutes: number;
  /** A newest reading older than this is `unknown`. Three times the five-minute usage cache. */
  staleAfterMinutes: number;
  /** How far back the fit reaches for a session-length window. */
  lookbackMinutes: number;
  /** How far back it reaches for a weekly window, whose pace is bursty within a day. */
  weeklyLookbackMinutes: number;
  /** Below this span the fit is flagged low-confidence rather than refused. */
  okSpanMinutes: number;
  /** Below this much total movement the fit is flagged low-confidence: it is quantisation noise. */
  okMovementPct: number;
  /** A slope under this is "not filling"; no cap is projected from it. Points per hour. */
  flatPctPerHour: number;
}

export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  minSamples: 3,
  minSpanMinutes: 15,
  staleAfterMinutes: 15,
  lookbackMinutes: 60,
  weeklyLookbackMinutes: 6 * 60,
  okSpanMinutes: 30,
  okMovementPct: 2,
  flatPctPerHour: 0.01,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/**
 * `resets_at` carries sub-second noise that changes on every fetch (docs/token-burn.md,
 * "Account pressure"), so two readings of one cycle differ by up to a second. Two minutes of slack
 * separates that noise from a real reset without merging a five-hour cycle into the next.
 */
const SAME_CYCLE_TOLERANCE_MS = 2 * MINUTE_MS;

export function lookbackMinutesFor(windowId: string, config: ProjectionConfig): number {
  return windowId.startsWith("weekly") ? config.weeklyLookbackMinutes : config.lookbackMinutes;
}

/**
 * The trailing run of samples that belong to the newest sample's cycle: same reset time, and no
 * `usedPct` drop. A drop inside one reset time is a reset the provider did not re-stamp, and the
 * samples before it are a full window ago.
 */
export function currentCycleSamples(samples: readonly WindowSample[]): WindowSample[] {
  const newest = samples[samples.length - 1];
  if (!newest) return [];
  let startIndex = samples.length - 1;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index];
    const next = samples[index + 1];
    if (!sample || !next) break;
    if (sample.usedPct > next.usedPct) break;
    if (!sameCycle(sample.resetsAtMs, newest.resetsAtMs)) break;
    startIndex = index;
  }
  return samples.slice(startIndex);
}

function sameCycle(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= SAME_CYCLE_TOLERANCE_MS;
}

function slopePctPerMs(samples: readonly WindowSample[]): number {
  const count = samples.length;
  const originMs = samples[0]?.atMs ?? 0;
  let sumX = 0;
  let sumY = 0;
  for (const sample of samples) {
    sumX += sample.atMs - originMs;
    sumY += sample.usedPct;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let covariance = 0;
  let variance = 0;
  for (const sample of samples) {
    const dx = sample.atMs - originMs - meanX;
    covariance += dx * (sample.usedPct - meanY);
    variance += dx * dx;
  }
  return variance === 0 ? 0 : covariance / variance;
}

export function projectWindow(input: {
  windowId: string;
  /** Oldest first, as stored. */
  samples: readonly WindowSample[];
  nowMs: number;
  config?: Partial<ProjectionConfig>;
}): WindowProjection {
  const config = { ...DEFAULT_PROJECTION_CONFIG, ...input.config };
  const cycle = currentCycleSamples(input.samples);
  const newest = cycle[cycle.length - 1];
  const cycleSpanMinutes = newest ? (newest.atMs - (cycle[0]?.atMs ?? newest.atMs)) / MINUTE_MS : 0;
  const unknown = (reason: UnknownReason): WindowProjection => ({
    status: "unknown",
    reason,
    samples: cycle.length,
    spanMinutes: cycleSpanMinutes,
  });
  if (!newest) return unknown("insufficient_samples");

  if (newest.usedPct >= 100) {
    return { status: "capped", samples: cycle.length, spanMinutes: cycleSpanMinutes };
  }
  if (newest.resetsAtMs === null) return unknown("no_reset_time");
  if (newest.resetsAtMs <= input.nowMs) return unknown("reset_passed");
  if (input.nowMs - newest.atMs > config.staleAfterMinutes * MINUTE_MS) return unknown("stale");

  const lookbackStartMs = newest.atMs - lookbackMinutesFor(input.windowId, config) * MINUTE_MS;
  const fitted = cycle.filter((sample) => sample.atMs >= lookbackStartMs);
  if (fitted.length < config.minSamples) return unknown("insufficient_samples");
  const spanMinutes = (newest.atMs - (fitted[0]?.atMs ?? newest.atMs)) / MINUTE_MS;
  if (spanMinutes < config.minSpanMinutes) return unknown("short_span");

  const movementPct = newest.usedPct - (fitted[0]?.usedPct ?? newest.usedPct);
  const confidence: "low" | "ok" =
    spanMinutes >= config.okSpanMinutes && movementPct >= config.okMovementPct ? "ok" : "low";
  // A fit through readings that never fall cannot go negative in practice, but a noisy pair of
  // quantised readings can tilt it below zero. Nothing should advise on an account gaining
  // capacity back, so a negative slope reads as flat (docs/budget-pacing.md makes the same call).
  const ratePctPerHour = Math.max(0, slopePctPerMs(fitted) * HOUR_MS);
  const minutesToReset = (newest.resetsAtMs - input.nowMs) / MINUTE_MS;
  const rawAtReset =
    newest.usedPct + ratePctPerHour * ((newest.resetsAtMs - newest.atMs) / HOUR_MS);
  const projectedPctAtReset = Math.min(100, rawAtReset);

  const base = {
    status: "projected" as const,
    samples: fitted.length,
    spanMinutes,
    ratePctPerHour,
    projectedPctAtReset,
    confidence,
  };
  if (ratePctPerHour < config.flatPctPerHour) {
    return { ...base, capsAtMs: null, minutesToCap: null };
  }
  // From the newest reading, not from `now`: the reading is what the rate was measured against.
  const capsAtMs = newest.atMs + ((100 - newest.usedPct) / ratePctPerHour) * HOUR_MS;
  if (capsAtMs >= newest.resetsAtMs) {
    return { ...base, capsAtMs: null, minutesToCap: null };
  }
  return {
    ...base,
    capsAtMs,
    minutesToCap: Math.max(0, Math.min(minutesToReset, (capsAtMs - input.nowMs) / MINUTE_MS)),
  };
}
