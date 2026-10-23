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

/**
 * `w(m)`, each model's price against Claude Opus 5.5. List input prices $4, $5, $2, $2 and $1 a
 * million, output five times input for each, so one weight per model matches the fleet's
 * weighting. Any other model has no weight, and a figure that needs one is null.
 *
 * Shared with the account-pool classifier plugin (`plugins/claude-account-pool/server/classifier.ts`),
 * which cannot depend on `@getpaseo/server`: the spawn-hint clamp (docs/jev.md, Feature 2) prices a
 * JEV-proposed model against the no-JEV one using this same table, so the two never disagree about
 * what counts as "pricier."
 */
export const JEV_PRICE_WEIGHTS: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 1,
  "claude-opus-5": 1.25,
  "claude-sonnet-5-5": 0.5,
  "claude-sonnet-5": 0.5,
  "claude-haiku-4-5": 0.25,
};

/** `claude/claude-haiku-4-5-20251001[1m]` and `us.anthropic.claude-opus-5-5-v1:0` both name a weight. */
export function normalizeSavingsModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") return null;
  let id = model.trim().toLowerCase();
  if (id.length === 0) return null;
  id = id.replace(/\[1m\]$/, "");
  id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
  id = id.replace(/-v\d+:\d+$/, "");
  id = id.replace(/-\d{8}$/, "");
  return id;
}

export function priceWeight(model: string | null | undefined): number | null {
  const id = normalizeSavingsModel(model);
  return id === null ? null : (JEV_PRICE_WEIGHTS[id] ?? null);
}
