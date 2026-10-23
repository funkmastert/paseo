import { TOKEN_BURN_WEIGHTS } from "../agent/token-rate-tracker.js";

/**
 * Pure cost and payback math for the compaction ledger (docs/insights.md). No I/O: the service
 * supplies the `totalTokens` snapshots and request counts; this file only does the arithmetic.
 */

/**
 * A step's own weighted-token spend: the diff of `agent.totalTokens` across it. A missing start
 * counts as 0: the counter is live-only and stays undefined until the agent's first request after
 * it loads. Null when the end is missing, or when the counter went backwards (a rewind or a
 * failover successor reset it mid-step, docs/token-burn.md), since then nothing was measured.
 */
export function stepCost(
  totalTokensAtStart: number | undefined,
  totalTokensAtEnd: number | undefined,
): number | null {
  if (totalTokensAtEnd === undefined) return null;
  const diff = totalTokensAtEnd - (totalTokensAtStart ?? 0);
  return diff < 0 ? null : diff;
}

/**
 * What the compaction is estimated to have saved so far: the tokens it dropped from the context,
 * re-read from cache on every request since, at the cache-read weight (docs/token-burn.md). Null
 * when either context figure is missing — there is nothing to estimate against.
 */
export function estimatedSavedWeightedTokens(
  contextBeforeTokens: number | null,
  contextAfterTokens: number | null,
  requestsSince: number,
): number | null {
  if (contextBeforeTokens === null || contextAfterTokens === null) return null;
  const dropped = Math.max(0, contextBeforeTokens - contextAfterTokens);
  return dropped * requestsSince * TOKEN_BURN_WEIGHTS.cacheRead;
}
