/**
 * The exchange rate behind JEV's unit, Opus-equivalent weighted tokens (docs/jev.md, "Savings"):
 * Claude Opus 5.5's list input price, $4 per million. Every feature's savings are already priced
 * into that unit, so one rate turns any of them into dollars, and $0.0001 of JEV is 25 tokens.
 * Shared by the daemon's formulas and the app's dashboard, so the two never disagree.
 */
export const OPUS_55_INPUT_USD_PER_TOKEN = 4 / 1_000_000;

export function usdToOpusTokens(usd: number): number {
  return usd / OPUS_55_INPUT_USD_PER_TOKEN;
}

/** What Opus-equivalent tokens would cost at Opus 5.5 API list prices. A comparison, not a bill. */
export function opusTokensToUsd(tokens: number): number {
  return tokens * OPUS_55_INPUT_USD_PER_TOKEN;
}
