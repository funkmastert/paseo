import { canonicalModelId } from "../agent/model-divergence.js";

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
 * - A model billed by average prompt length (Claude Haiku 5.5's <=100K/>100K split, and the
 *   fork's newer Codex models' <=272K/>272K split) is priced by this row's *average* prompt
 *   length — `(input + cacheWrite + cacheRead) / responses` — not its actual per-request prompt
 *   length, which the stored hourly buckets don't carry. A row whose requests straddle the
 *   threshold is priced as if every request in it ran at the average.
 */

interface ModelPriceUsdPerMTok {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** A higher tier that applies once a row's average per-request prompt length crosses a line. */
interface LongPromptPriceTier {
  /** Average `(input + cacheWrite + cacheRead) / responses` above which `price` applies. */
  aboveAvgPromptTokens: number;
  price: ModelPriceUsdPerMTok;
}

interface ModelPrice {
  base: ModelPriceUsdPerMTok;
  longPrompt?: LongPromptPriceTier;
}

/**
 * Anthropic, keyed by `canonicalModelId`'s output. Deliberately not the Claude Code model
 * manifest's own id list (`normalizeClaudeRuntimeModelId`, which only resolves ids the manifest
 * advertises): Claude Haiku 5.5 prices correctly below even though the manifest
 * (`model-manifest.ts`) doesn't carry it yet.
 */
const CLAUDE_PRICES_PER_MTOK: Partial<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { base: { input: 10.0, cacheWrite: 12.5, cacheRead: 0.25, output: 50.0 } },
  "claude-mythos-5-1": { base: { input: 10.0, cacheWrite: 12.5, cacheRead: 0.25, output: 50.0 } },
  "claude-fable-5": { base: { input: 10.0, cacheWrite: 12.5, cacheRead: 1.0, output: 50.0 } },
  "claude-opus-5-5": { base: { input: 4.0, cacheWrite: 5.0, cacheRead: 0.2, output: 20.0 } },
  "claude-opus-5": { base: { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 } },
  "claude-opus-4-8": { base: { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 } },
  "claude-opus-4-7": { base: { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 } },
  "claude-opus-4-6": { base: { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 } },
  // Cache reads $0.20/MTok, the same as Sonnet 5 — confirmed against the claude-api skill's
  // pricing table (previously $0.10 here, an unverified copy-down from Opus 5.5's ratio).
  "claude-sonnet-5-5": { base: { input: 2.0, cacheWrite: 2.5, cacheRead: 0.2, output: 10.0 } },
  "claude-sonnet-5": { base: { input: 2.0, cacheWrite: 2.5, cacheRead: 0.2, output: 10.0 } },
  "claude-sonnet-4-6": { base: { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 } },
  "claude-haiku-5-5": {
    base: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    longPrompt: {
      aboveAvgPromptTokens: 100_000,
      price: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
    },
  },
  "claude-haiku-4-5": { base: { input: 1.0, cacheWrite: 1.25, cacheRead: 0.1, output: 5.0 } },
};

/**
 * OpenAI/Codex, keyed by the exact model string from the transcript. No normalization: Codex
 * model ids carry no date suffix or alias form in the transcripts (docs/token-usage.md).
 * Cache write is priced the same as fresh input — OpenAI's prompt caching has no write charge,
 * only a discounted read — which is inert today since Codex's `cache_write_input_tokens` is
 * "always 0 so far" (docs/token-usage.md), but correct if that ever changes.
 *
 * `gpt-5-codex`, `gpt-5.1-codex` and `gpt-5.1-codex-max` are not on OpenAI's current pricing page
 * (checked 2026-10-22) and stay out of this table — unpriced, never guessed. Only the models
 * below that ship a confirmed >272K-token tier carry a `longPrompt` entry; the rest of this
 * table's models may have one too, not yet sourced.
 */
/** OpenAI's standard-vs-long-context split for the fork's newer Codex models below. */
const OPENAI_LONG_PROMPT_THRESHOLD_TOKENS = 272_000;

const CODEX_PRICES_PER_MTOK: Partial<Record<string, ModelPrice>> = {
  "gpt-5": { base: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10.0 } },
  "gpt-5-mini": { base: { input: 0.25, cacheWrite: 0.25, cacheRead: 0.025, output: 2.0 } },
  "gpt-5-nano": { base: { input: 0.05, cacheWrite: 0.05, cacheRead: 0.005, output: 0.4 } },
  "gpt-5.1": { base: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10.0 } },
  "gpt-5.2": { base: { input: 1.75, cacheWrite: 1.75, cacheRead: 0.175, output: 14.0 } },
  "gpt-5.3-codex": { base: { input: 1.75, cacheWrite: 1.75, cacheRead: 0.175, output: 14.0 } },
  "gpt-5.4": { base: { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15.0 } },
  "gpt-5.4-mini": { base: { input: 0.75, cacheWrite: 0.75, cacheRead: 0.075, output: 4.5 } },
  "gpt-5.4-nano": { base: { input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 1.25 } },
  "gpt-5.5": { base: { input: 5.0, cacheWrite: 5.0, cacheRead: 0.5, output: 30.0 } },
  o3: { base: { input: 2.0, cacheWrite: 2.0, cacheRead: 0.5, output: 8.0 } },
  "o3-mini": { base: { input: 1.1, cacheWrite: 1.1, cacheRead: 0.55, output: 4.4 } },
  "o4-mini": { base: { input: 1.1, cacheWrite: 1.1, cacheRead: 0.275, output: 4.4 } },
  "gpt-6-astra": {
    base: { input: 10.0, cacheWrite: 10.0, cacheRead: 1.0, output: 50.0 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 20.0, cacheWrite: 20.0, cacheRead: 2.0, output: 75.0 },
    },
  },
  "gpt-6.1-sol": {
    base: { input: 2.0, cacheWrite: 2.0, cacheRead: 0.1, output: 10.0 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 4.0, cacheWrite: 4.0, cacheRead: 0.2, output: 15.0 },
    },
  },
  "gpt-6-sol": {
    base: { input: 2.0, cacheWrite: 2.0, cacheRead: 0.2, output: 10.0 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 4.0, cacheWrite: 4.0, cacheRead: 0.4, output: 15.0 },
    },
  },
  "gpt-6-luna": {
    base: { input: 0.1, cacheWrite: 0.1, cacheRead: 0.01, output: 0.5 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 0.75 },
    },
  },
  "gpt-5.6-sol": {
    base: { input: 4.0, cacheWrite: 4.0, cacheRead: 0.4, output: 20.0 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 8.0, cacheWrite: 8.0, cacheRead: 0.8, output: 30.0 },
    },
  },
  "gpt-5.6-terra": {
    base: { input: 2.0, cacheWrite: 2.0, cacheRead: 0.2, output: 12.0 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 4.0, cacheWrite: 4.0, cacheRead: 0.4, output: 18.0 },
    },
  },
  "gpt-5.6-luna": {
    base: { input: 0.2, cacheWrite: 0.2, cacheRead: 0.02, output: 1.2 },
    longPrompt: {
      aboveAvgPromptTokens: OPENAI_LONG_PROMPT_THRESHOLD_TOKENS,
      price: { input: 0.4, cacheWrite: 0.4, cacheRead: 0.04, output: 1.8 },
    },
  },
};

/**
 * `canonicalModelId` (`../agent/model-divergence.ts`) already solves this exact problem for the
 * same reason: strip a `[1m]`/context-window suffix and a dated-snapshot suffix so a model prices
 * the same regardless of which variant a transcript reports — without routing through the
 * manifest-dependent `normalizeClaudeRuntimeModelId`, which can't resolve a model (Claude Haiku
 * 5.5) that predates the manifest listing it. A `[1m]` id prices at its base model's rate — this
 * table has no separate 1M-context rate to apply instead.
 */
function lookupPrice(provider: string, model: string): ModelPrice | null {
  if (provider === "claude") {
    const canonical = canonicalModelId(model);
    return canonical ? (CLAUDE_PRICES_PER_MTOK[canonical] ?? null) : null;
  }
  if (provider === "codex") {
    return CODEX_PRICES_PER_MTOK[model] ?? null;
  }
  return null;
}

/** Picks `entry.longPrompt`'s rate when the row's average prompt length crosses its line. */
function resolvePriceTier(entry: ModelPrice, usage: TokenUsageCostInput): ModelPriceUsdPerMTok {
  if (!entry.longPrompt || !usage.responses) return entry.base;
  const avgPromptTokens = (usage.input + usage.cacheWrite + usage.cacheRead) / usage.responses;
  return avgPromptTokens > entry.longPrompt.aboveAvgPromptTokens
    ? entry.longPrompt.price
    : entry.base;
}

export interface TokenUsageCostInput {
  provider: string;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Omit to price at the base/short-prompt tier regardless of a model's long-prompt tier. */
  responses?: number;
}

/**
 * API-equivalent cost in USD for one row's token counts. `null` when the model has no listed
 * price — never guessed.
 */
export function priceTokenUsage(usage: TokenUsageCostInput): number | null {
  const entry = lookupPrice(usage.provider, usage.model);
  if (!entry) return null;
  const price = resolvePriceTier(entry, usage);
  return (
    (price.input * usage.input +
      price.cacheWrite * usage.cacheWrite +
      price.cacheRead * usage.cacheRead +
      price.output * usage.output) /
    1_000_000
  );
}
