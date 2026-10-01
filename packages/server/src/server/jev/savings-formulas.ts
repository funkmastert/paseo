/**
 * The one place facts become Opus-equivalent weighted tokens (docs/jev.md, "Formulas"). Call sites
 * report facts; the savings module prices them here, so a correction reprices every feature alike.
 */

/**
 * Characters per token for what a read or a tool result loads: the fleet's calibrated median for
 * tool results (p10 2.10, p90 2.62, n = 1,463). Every feature's `T` uses it, so no two features
 * count the same text differently.
 */
export const JEV_CHARS_PER_TOKEN = 2.35;

/** `T` in the formulas: the tokens `characters` of text load into an agent's context. */
export function estimateContextTokens(characters: number): number {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  return Math.round(characters / JEV_CHARS_PER_TOKEN);
}
