/**
 * How much budget a pool account has left, as one comparable number, computed from the same
 * `ProviderUsage` rows the failover sweep already reads. Pure — the caller passes the rows and
 * `nowMs`. See docs/account-failover.md.
 *
 * Failover used to take the lowest-priority-number worker that wasn't dead. Priority never
 * changes, so a rescue landed on whichever account the operator numbered first regardless of
 * what was left in it, and the quiet account stayed quiet until everything ahead of it capped.
 * Ranking by headroom sends the agent where the budget actually is.
 */
import type { ProviderUsage } from "@getpaseo/protocol/messages";

/**
 * How far ahead a reset is worth anything. A day: the span a rescue actually has to cover, so a
 * window resetting on Friday does not pull an agent onto an account that cannot run it today.
 */
const HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * An account with no usable reading scores as empty. Optimistic on purpose, and it is what
 * keeps this inert where usage is unreadable: every candidate ties and the tie-break is the
 * configured priority order, which is what ran before.
 */
export const NEUTRAL_HEADROOM = 100;

/**
 * What one window is worth: what is free now, plus what the reset gives back, discounted by the
 * wait. The discount is why "20% left, resets in an hour" beats "30% left, resets on Friday" —
 * the first is about to be a whole fresh window, the second is all there is until the weekend.
 */
function windowScore(freePct: number, resetsAtMs: number | null, nowMs: number): number {
  const free = Math.max(0, Math.min(100, freePct));
  if (resetsAtMs === null) return free;
  const waitMs = resetsAtMs - nowMs;
  if (waitMs >= HORIZON_MS) return free;
  const nearness = waitMs <= 0 ? 1 : 1 - waitMs / HORIZON_MS;
  return free + (100 - free) * nearness;
}

function parseResetMs(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  const parsed = Date.parse(resetsAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Per-provider headroom, best-first comparable. The tightest window wins, because a window is a
 * wall: 95% free on the session window buys nothing when the weekly window has 2% left.
 *
 * Quantized to whole points so ranking is a total order and two accounts a fraction apart keep
 * a stable order rather than swapping every time the usage cache refreshes.
 */
export function headroomByProvider(
  usage: readonly ProviderUsage[] | null,
  nowMs: number,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const provider of usage ?? []) {
    let lowest: number | null = null;
    for (const window of provider.windows) {
      if (typeof window.usedPct !== "number") continue;
      const score = windowScore(100 - window.usedPct, parseResetMs(window.resetsAt), nowMs);
      if (lowest === null || score < lowest) lowest = score;
    }
    if (lowest !== null) scores.set(provider.providerId, Math.round(lowest));
  }
  return scores;
}
