/**
 * How much work an account can still absorb, as one comparable number.
 *
 * The pool used to place on a fixed priority order, which is why a barely-used backup account
 * sat idle while the two accounts ahead of it walked into their caps: priority never changes,
 * so nothing ever moved load to where the budget was. Ranking by headroom instead makes the
 * quiet account the preferred target while it is quiet, and demotes it as it fills up, without
 * anyone editing config.
 *
 * Health decides *whether* an account may be used; this decides *which* of the ones that may.
 * Scoring never overrides a cap.
 */
import { relevantWindows, type HealthTracker } from "./health";

/** Just the reads scoring needs, so callers can pass a full HealthTracker or a stub. */
export type HeadroomHealth = Pick<HealthTracker, "describeWindow" | "windowIds">;

/**
 * How far ahead a reset is worth anything. A window that comes back inside this horizon is
 * worth more than its free percentage alone, scaled by how soon; one that comes back later is
 * worth exactly what is left in it today.
 *
 * A day, because that is the span a placement decision actually covers: a subagent spawned now
 * finishes, or doesn't, well inside it. Stretch the horizon and a weekly window resetting on
 * Friday starts pulling work onto an account that cannot run it this afternoon.
 */
export const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * An account with no usage reading at all scores as if it were empty.
 *
 * Optimistic on purpose, and the same convention the Fable budget gate already uses: a missing
 * usage poll must not silently demote every account. It is also what keeps this change inert
 * where there is no usage data — with no readings every candidate scores 100, every comparison
 * ties, and the tie-break is the pool priority order that ran before.
 */
export const NEUTRAL_SCORE = 100;

/**
 * Score differences below one point are noise, not signal. Scores are quantized to integer
 * points before comparison so ranking is a total order (an epsilon comparison inside a sort is
 * not transitive) and so two accounts a fraction of a percent apart keep a stable, explainable
 * order rather than swapping on every usage poll.
 */
function bucket(score: number): number {
  return Math.round(score);
}

export interface ScoreOptions {
  /** Defaults to DEFAULT_HORIZON_MS. */
  horizonMs?: number;
}

/**
 * What one window is worth: what is free in it now, plus what the reset gives back, discounted
 * by the wait.
 *
 * The discount is what makes "20% left, resets in an hour" beat "30% left, resets on Friday" —
 * the first is about to be a whole fresh window and the second is all there is until the
 * weekend. Without it, ranking on remaining percent alone sends work to the account that looks
 * fuller today and is stuck there for days.
 */
export function windowScore(
  freePct: number,
  resetsAt: Date | undefined,
  nowMs: number,
  horizonMs: number,
): number {
  const free = Math.max(0, Math.min(100, freePct));
  const resetMs = resetsAt?.getTime();
  if (resetMs === undefined || !Number.isFinite(resetMs)) {
    return free;
  }
  const waitMs = resetMs - nowMs;
  if (waitMs >= horizonMs) {
    return free;
  }
  // A reset already due counts in full: the window is one poll away from being empty again.
  const nearness = waitMs <= 0 ? 1 : 1 - waitMs / horizonMs;
  return free + (100 - free) * nearness;
}

/**
 * One account's usable headroom for a spawn of `modelId`, as the score of its tightest window.
 *
 * The minimum rather than an average, because a window is a wall: 95% free on the session
 * window buys nothing when the weekly window has 2% left. Windows with no reading are skipped
 * rather than guessed at, and an account with no readings at all scores NEUTRAL_SCORE.
 */
export function scoreAccount(
  health: HeadroomHealth,
  providerId: string,
  modelId: string,
  nowMs: number,
  options: ScoreOptions = {},
): number {
  const horizonMs = options.horizonMs ?? DEFAULT_HORIZON_MS;
  // Every window the health check would enforce, plus anything else observed for this account:
  // a per-model weekly window for a model we aren't spawning still bounds nothing, but an
  // account-wide or surface-scoped window nobody enumerated does, and missing it is how a
  // "best" candidate turns out to be capped.
  const windows = new Set([...relevantWindows(modelId), ...health.windowIds(providerId)]);

  let lowest: number | null = null;
  for (const window of windows) {
    const state = health.describeWindow(providerId, window);
    if (state?.utilizationPct === undefined) {
      continue;
    }
    const score = windowScore(100 - state.utilizationPct, state.resetsAt, nowMs, horizonMs);
    if (lowest === null || score < lowest) {
      lowest = score;
    }
  }
  return lowest ?? NEUTRAL_SCORE;
}

export interface RankableCandidate {
  providerId: string;
  /** The operator's configured order, used only to break a scoring tie. */
  priority: number;
}

/**
 * Candidates best-headroom first, ties broken by the operator's priority order and then by
 * provider id.
 *
 * Deterministic all the way down so the same pool and the same usage readings always place the
 * same way — a placement that varies run to run is impossible to explain to the person whose
 * budget it spent.
 */
export function rankByHeadroom<T extends RankableCandidate>(
  candidates: readonly T[],
  health: HeadroomHealth,
  modelId: string,
  nowMs: number,
  options: ScoreOptions = {},
): T[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: bucket(scoreAccount(health, candidate.providerId, modelId, nowMs, options)),
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.priority - b.candidate.priority ||
      a.candidate.providerId.localeCompare(b.candidate.providerId),
  );
  return scored.map((entry) => entry.candidate);
}
