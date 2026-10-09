/**
 * LMArena model name to local model reference mapping.
 * Arena names are lowercase with dots for version separators and reasoning/effort suffixes.
 * We map to `provider/model` refs and the effort level Arena ranks them at.
 *
 * Unmatched rows are dropped and counted per board, never guessed (KTD-10).
 */

import { z } from "zod";

/** A mapping from Arena model name to our ref and the effort it ranks at. */
export interface ArenaAlias {
  /** The exact Arena name, e.g. "claude-opus-5.5-high". */
  arenaName: string;
  /** Our ref, e.g. "claude-opus-5-5" or "codex/gpt-6-sol". */
  ref: string;
  /** The effort level Arena ranks this model at, e.g. "high", "xhigh", "max". */
  effort: string;
}

/** All known mappings from Arena to our refs. */
const ARENA_ALIASES: readonly ArenaAlias[] = [
  // Claude models
  { arenaName: "claude-opus-5.5-high", ref: "claude-opus-5-5", effort: "high" },
  { arenaName: "claude-opus-5.5-max", ref: "claude-opus-5-5", effort: "max" },
  { arenaName: "claude-opus-5-high", ref: "claude-opus-5", effort: "high" },
  { arenaName: "claude-opus-5-max", ref: "claude-opus-5", effort: "max" },
  { arenaName: "claude-sonnet-5.5-xhigh", ref: "claude-sonnet-5-5", effort: "xhigh" },
  { arenaName: "claude-sonnet-5.5-high", ref: "claude-sonnet-5-5", effort: "high" },
  { arenaName: "claude-sonnet-5.5-max", ref: "claude-sonnet-5-5", effort: "max" },
  { arenaName: "claude-sonnet-5-high", ref: "claude-sonnet-5", effort: "high" },
  { arenaName: "claude-sonnet-5-max", ref: "claude-sonnet-5", effort: "max" },
  { arenaName: "claude-haiku-4-5-20251001", ref: "claude-haiku-4-5", effort: "high" },
  { arenaName: "claude-haiku-4-5-20251001-low", ref: "claude-haiku-4-5", effort: "low" },

  // OpenAI/Codex models
  { arenaName: "gpt-6.1-sol-max", ref: "codex/gpt-6.1-sol", effort: "max" },
  { arenaName: "gpt-6.1-sol-xhigh", ref: "codex/gpt-6.1-sol", effort: "xhigh" },
  { arenaName: "gpt-6-astra-max", ref: "codex/gpt-6-astra", effort: "max" },
  { arenaName: "gpt-6-astra-xhigh", ref: "codex/gpt-6-astra", effort: "xhigh" },
  { arenaName: "gpt-6-sol-max", ref: "codex/gpt-6-sol", effort: "max" },
  { arenaName: "gpt-6-sol-xhigh", ref: "codex/gpt-6-sol", effort: "xhigh" },
  { arenaName: "gpt-6-luna-max", ref: "codex/gpt-6-luna", effort: "max" },
  { arenaName: "gpt-6-luna-xhigh", ref: "codex/gpt-6-luna", effort: "xhigh" },
  { arenaName: "gpt-5.6-sol-xhigh", ref: "codex/gpt-5.6-sol", effort: "xhigh" },
  { arenaName: "gpt-5.6-sol-high", ref: "codex/gpt-5.6-sol", effort: "high" },
  { arenaName: "gpt-5.6-terra-xhigh", ref: "codex/gpt-5.6-terra", effort: "xhigh" },
  { arenaName: "gpt-5.6-terra-high", ref: "codex/gpt-5.6-terra", effort: "high" },
  { arenaName: "gpt-5.6-luna-xhigh", ref: "codex/gpt-5.6-luna", effort: "xhigh" },
  { arenaName: "gpt-5.6-luna-high", ref: "codex/gpt-5.6-luna", effort: "high" },
];

/** Look up an Arena model name in the alias table. */
export function arenaAliasFor(arenaName: string): ArenaAlias | undefined {
  return ARENA_ALIASES.find((alias) => alias.arenaName === arenaName);
}

/**
 * The shape of rows from the LMArena leaderboard, after normalization.
 * Agent board has `score` and `score_ci_*`; text boards have `rating` and `rating_*`.
 */
export const ArenaRankingRowSchema = z.object({
  /** The Arena model name. */
  arenaName: z.string(),
  /** Our ref, from the alias table. */
  ours: z.string(),
  /** The effort level this row ranks. */
  effort: z.string(),
  /** Bradley-Terry rating (text) or IPS score (agent). */
  rating: z.number(),
  /** Lower confidence bound. */
  ratingLower: z.number(),
  /** Upper confidence bound. */
  ratingUpper: z.number(),
  /** Vote or observation count. */
  votes: z.number(),
});

export type ArenaRankingRow = z.infer<typeof ArenaRankingRowSchema>;

/** The full rankings file persisted to disk. */
export const ArenaRankingsFileSchema = z.object({
  /** When the file was written. */
  fetchedAt: z.number().int(),
  /** The leaderboard publish date. */
  publishDate: z.string(),
  /** Boards keyed by `kind` as defined in KTD-11. */
  boards: z.record(
    z.string(), // board name, e.g. "agent-overall" or "webdev-webdev-react"
    z.array(ArenaRankingRowSchema),
  ),
  /** Count of unmatched rows per board. */
  unmatched: z.record(z.string(), z.number()),
});

export type ArenaRankingsFile = z.infer<typeof ArenaRankingsFileSchema>;

/** The kinds of work JEV can label a child with (KTD-12). "other" never ranks (KTD-11). */
export const WORK_KINDS = ["coding", "frontend", "research", "review", "writing", "ops", "other"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** The subset of `WorkKind` that KTD-11 gives a board preference list. */
export type RankedWorkKind = Exclude<WorkKind, "other">;

/**
 * KTD-11's table: each kind of work lists its boards in preference order.
 * A board id is `{HF config}/{category}`. The classifier (U8) walks this list
 * and uses the first board that ranks at least two usable candidates, never
 * mixing scores across boards. "other" / unknown kinds have no boards:
 * today's order applies (R8).
 */
export const KIND_BOARD_PREFERENCE: Record<RankedWorkKind, readonly string[]> = {
  coding: ["agent/overall", "text_style_control/coding"],
  frontend: ["webdev/webdev-react", "webdev/overall", "agent/overall"],
  research: ["text_style_control/expert", "text_style_control/hard_prompts"],
  review: ["text_style_control/hard_prompts", "text_style_control/instruction_following"],
  writing: ["text_style_control/creative_writing", "text_style_control/instruction_following"],
  ops: ["agent_bash_recovery_steps/overall", "agent/overall"],
};

/** Every distinct board id referenced by `KIND_BOARD_PREFERENCE`, fetched once each. */
export function allBoardIds(): readonly string[] {
  const ids = new Set<string>();
  for (const boards of Object.values(KIND_BOARD_PREFERENCE)) {
    for (const id of boards) {
      ids.add(id);
    }
  }
  return [...ids];
}
