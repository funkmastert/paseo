import { TOKEN_BURN_WEIGHTS } from "../agent/token-rate-tracker.js";

/**
 * Pure cost and payback math for the compaction ledger (docs/insights.md). No I/O: the service
 * supplies the `totalTokens` snapshots and request counts; this file only does the arithmetic.
 */

/** A step's own weighted-token spend: the diff of `agent.totalTokens` across it. Null when either
 * snapshot is missing — e.g. the daemon restarted mid-step and the start snapshot never landed. */
export function stepCost(
  totalTokensAtStart: number | undefined,
  totalTokensAtEnd: number | undefined,
): number | null {
  if (totalTokensAtStart === undefined || totalTokensAtEnd === undefined) return null;
  return Math.max(0, totalTokensAtEnd - totalTokensAtStart);
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
