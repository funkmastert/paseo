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

/**
 * One of a leader board's top rows, matched or not (docs/arena-ranking.md,
 * "Leaders"). An unaliased model has no `ours` or `effort`: it is kept so the
 * unpooled-challenger alert can name a model nobody has added to a pool yet.
 */
export const ArenaTopRowSchema = z.object({
  arenaName: z.string(),
  ours: z.string().optional(),
  effort: z.string().optional(),
  rating: z.number(),
  ratingLower: z.number(),
  ratingUpper: z.number(),
  votes: z.number(),
});

export type ArenaTopRow = z.infer<typeof ArenaTopRowSchema>;

/** One publish of a leader board: the board's own `leaderboard_publish_date` and its matched rows. */
export const ArenaPublishSchema = z.object({
  publishDate: z.string(),
  rows: z.array(ArenaRankingRowSchema),
});

export type ArenaPublish = z.infer<typeof ArenaPublishSchema>;

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
  /**
   * Board ids whose fetch failed and are therefore absent from `boards`
   * entirely — distinct from a board that fetched successfully but is
   * legitimately small or empty. Default empty for a file written before
   * this field existed. Lets a degraded day be audited from the file
   * itself, not only from a `daemon.log` line that may have rotated out.
   */
  failedBoards: z.array(z.string()).default([]),
  /**
   * Per leader board (`LEADER_BOARD_IDS`), its recent publishes, newest first,
   * deduped on the board's own publish date (not `publishDate` above, which is
   * the fetch date). The leader pick's streak reads this. Absent in a file
   * written before leader picks existed.
   */
  leaderHistory: z.record(z.string(), z.array(ArenaPublishSchema)).optional(),
  /** Per leader board, its top rows from the latest fetch, matched or not. */
  boardTop: z.record(z.string(), z.array(ArenaTopRowSchema)).optional(),
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

/**
 * The boards a leader pick may rank on (docs/arena-ranking.md, "Leaders"). The
 * daily job keeps per-publish history and the top rows, matched or not, for
 * these alone, so `arena.leader.boards` may name only these: a board without
 * history could never let a challenger build a streak.
 */
export const LEADER_BOARD_IDS = ["agent/overall", "text_style_control/hard_prompts"] as const;
export type LeaderBoardId = (typeof LEADER_BOARD_IDS)[number];

/** How many distinct publishes of history the daily job keeps per leader board (`arena-rankings.ts`). */
export const LEADER_HISTORY_MAX_PUBLISHES = 10;

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
