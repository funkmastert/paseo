import type { AgentTokenRate } from "@getpaseo/protocol/agent-types";

/**
 * Relative token-burn severity for a row's trailing-window rate versus its currently visible
 * siblings. There is no "default"/calm variant — a sibling with nothing to report (idle, no
 * resolvable rate, too small a pool) is simply absent from `deriveTokenBurnTones`'s result map;
 * see docs/plans/2026-09-12-005-feat-token-burn-indicator-plan.md.
 */
export type TokenBurnTone = "warning" | "danger";

export interface TokenBurnSibling {
  id: string;
  recentTokenRate?: AgentTokenRate;
}

/** 2x the server's 5-minute tracker window — a rate this old reflects a daemon that's stopped pushing updates, not current burn. */
export const TOKEN_BURN_STALENESS_MS = 10 * 60 * 1000;

/** Below this, an agent isn't "burning" in any meaningful sense — never a badge, however it compares to peers. */
export const TOKEN_BURN_RATE_FLOOR_TOKENS_PER_MINUTE = 1_500;

/** A pool smaller than this can't support a meaningful "relative to peers" read. */
export const TOKEN_BURN_MIN_POOL_SIZE = 3;

export const TOKEN_BURN_DANGER_ENTER_RATIO = 3.0;
export const TOKEN_BURN_DANGER_EXIT_RATIO = 2.25;
export const TOKEN_BURN_WARNING_ENTER_RATIO = 1.75;
export const TOKEN_BURN_WARNING_EXIT_RATIO = 1.4;

/**
 * The current tokens/min number, or undefined when there's nothing current to report — no rate
 * at all, or one old enough that the daemon has plainly stopped refreshing it. Absence, never a
 * fabricated zero.
 */
export function resolveTokenRate(
  rate: AgentTokenRate | undefined,
  nowMs: number,
): number | undefined {
  if (!rate) return undefined;
  if (nowMs - rate.asOfMs > TOKEN_BURN_STALENESS_MS) return undefined;
  return rate.tokensPerMinute;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Hysteresis so a rate hovering near a ratio boundary doesn't flicker between tones every render:
 * entering a tier only needs to cross its enter threshold (from any prior state — a sharp spike
 * shows immediately), but *staying* in a tier only needs to stay above its lower exit threshold.
 */
function classifyRatio(
  ratio: number,
  previousTone: TokenBurnTone | undefined,
): TokenBurnTone | undefined {
  if (ratio >= TOKEN_BURN_DANGER_ENTER_RATIO) return "danger";
  if (previousTone === "danger" && ratio >= TOKEN_BURN_DANGER_EXIT_RATIO) return "danger";
  if (ratio >= TOKEN_BURN_WARNING_ENTER_RATIO) return "warning";
  if (previousTone === "warning" && ratio >= TOKEN_BURN_WARNING_EXIT_RATIO) return "warning";
  return undefined;
}

/**
 * Derives each visible sibling's token-burn tone relative to the group, for the list owner to
 * compute once per render (`useMemo` + a ref carrying `previousTones` across renders — see
 * orchestration-panel.tsx/track.tsx). Only siblings with a resolvable, above-floor rate are ever
 * candidates; the returned map has no entry at all for anyone else, including a pool too small to
 * compare meaningfully (a lone agent, or fewer than three above-floor siblings) — that's "nothing
 * to show", not "calm".
 */
export function deriveTokenBurnTones(
  siblings: readonly TokenBurnSibling[],
  previousTones: ReadonlyMap<string, TokenBurnTone>,
  nowMs: number,
): ReadonlyMap<string, TokenBurnTone> {
  const resolved = siblings.map((sibling) => ({
    id: sibling.id,
    rate: resolveTokenRate(sibling.recentTokenRate, nowMs),
  }));

  const pool = resolved.filter(
    (entry): entry is { id: string; rate: number } =>
      entry.rate !== undefined && entry.rate > TOKEN_BURN_RATE_FLOOR_TOKENS_PER_MINUTE,
  );

  const tones = new Map<string, TokenBurnTone>();
  if (pool.length < TOKEN_BURN_MIN_POOL_SIZE) {
    return tones;
  }

  const medianRate = median(pool.map((entry) => entry.rate));
  if (!(medianRate > 0)) {
    return tones;
  }

  for (const entry of pool) {
    const tone = classifyRatio(entry.rate / medianRate, previousTones.get(entry.id));
    if (tone !== undefined) {
      tones.set(entry.id, tone);
    }
  }

  return tones;
}
