import { normalizeClaudeRuntimeModelId } from "../agent/providers/claude/model-manifest.js";

/**
 * API-equivalent cost for one row of token usage (docs/token-usage.md, "Cost"). A static,
 * hand-reviewed price table — never a live price feed, same posture as `TOKEN_BURN_WEIGHTS` in
 * `../agent/token-rate-tracker.ts`.
 *
 * Sources, both fetched 2026-10-22:
 * - Anthropic: platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI: developers.openai.com/api/docs/pricing
 *
 * Two assumptions, documented here and in docs/token-usage.md because the stored hourly buckets
 * cannot resolve them:
 * - Claude cache writes are priced at the 5-minute rate (1.25x base input), never the 1-hour rate
 *   (2x): `cache_creation_input_tokens` is summed into one `cacheWrite` bucket with no 5m/1h split
 *   (transcript-parsers.ts), and Claude Code's own cache breakpoints default to the 5-minute TTL.
 * - Claude Haiku 5.5 is priced at its <=100K-token-prompt tier, never its >100K tier: the buckets
 *   have no per-request prompt-length dimension to split on. This undercounts cost on long-prompt
 *   Haiku 5.5 calls.
 */

interface ModelPriceUsdPerMTok {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Anthropic, keyed by the canonical manifest id `normalizeClaudeRuntimeModelId` resolves to. */
const CLAUDE_PRICES_PER_MTOK: Partial<Record<string, ModelPriceUsdPerMTok>> = {
  "claude-fable-5-1": { input: 10.0, cacheWrite: 12.5, cacheRead: 0.25, output: 50.0 },
  "claude-mythos-5-1": { input: 10.0, cacheWrite: 12.5, cacheRead: 0.25, output: 50.0 },
  "claude-fable-5": { input: 10.0, cacheWrite: 12.5, cacheRead: 1.0, output: 50.0 },
  "claude-opus-5-5": { input: 4.0, cacheWrite: 5.0, cacheRead: 0.2, output: 20.0 },
  "claude-opus-5": { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  "claude-sonnet-5-5": { input: 2.0, cacheWrite: 2.5, cacheRead: 0.1, output: 10.0 },
  "claude-sonnet-5": { input: 2.0, cacheWrite: 2.5, cacheRead: 0.2, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  "claude-haiku-4-5": { input: 1.0, cacheWrite: 1.25, cacheRead: 0.1, output: 5.0 },
};

/**
 * OpenAI/Codex, keyed by the exact model string from the transcript. No normalization: Codex
 * model ids carry no date suffix or alias form in the transcripts (docs/token-usage.md).
 * Cache write is priced the same as fresh input — OpenAI's prompt caching has no write charge,
 * only a discounted read — which is inert today since Codex's `cache_write_input_tokens` is
 * "always 0 so far" (docs/token-usage.md), but correct if that ever changes.
 */
const CODEX_PRICES_PER_MTOK: Partial<Record<string, ModelPriceUsdPerMTok>> = {
  "gpt-5": { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10.0 },
  "gpt-5-mini": { input: 0.25, cacheWrite: 0.25, cacheRead: 0.025, output: 2.0 },
  "gpt-5-nano": { input: 0.05, cacheWrite: 0.05, cacheRead: 0.005, output: 0.4 },
  "gpt-5.1": { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10.0 },
  "gpt-5.2": { input: 1.75, cacheWrite: 1.75, cacheRead: 0.175, output: 14.0 },
  "gpt-5.3-codex": { input: 1.75, cacheWrite: 1.75, cacheRead: 0.175, output: 14.0 },
  "gpt-5.4": { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, cacheWrite: 0.75, cacheRead: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 1.25 },
  "gpt-5.5": { input: 5.0, cacheWrite: 5.0, cacheRead: 0.5, output: 30.0 },
  o3: { input: 2.0, cacheWrite: 2.0, cacheRead: 0.5, output: 8.0 },
  "o3-mini": { input: 1.1, cacheWrite: 1.1, cacheRead: 0.55, output: 4.4 },
  "o4-mini": { input: 1.1, cacheWrite: 1.1, cacheRead: 0.275, output: 4.4 },
};

function lookupPrice(provider: string, model: string): ModelPriceUsdPerMTok | null {
  if (provider === "claude") {
    const canonical = normalizeClaudeRuntimeModelId(model);
    return (canonical ? CLAUDE_PRICES_PER_MTOK[canonical] : undefined) ?? null;
  }
  if (provider === "codex") {
    return CODEX_PRICES_PER_MTOK[model] ?? null;
  }
  return null;
}

export interface TokenUsageCostInput {
  provider: string;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * API-equivalent cost in USD for one row's token counts. `null` when the model has no listed
 * price — never guessed.
 */
export function priceTokenUsage(usage: TokenUsageCostInput): number | null {
  const price = lookupPrice(usage.provider, usage.model);
  if (!price) return null;
  return (
    (price.input * usage.input +
      price.cacheWrite * usage.cacheWrite +
      price.cacheRead * usage.cacheRead +
      price.output * usage.output) /
    1_000_000
  );
}
