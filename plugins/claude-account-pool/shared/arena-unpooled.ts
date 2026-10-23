/**
 * The unpooled-challenger alert (docs/arena-ranking.md, "Leaders"): models
 * that beat the leader pool's incumbent on the first leader board by the
 * leader pick's own bar, but sit in no role's pool, so the pick can never run
 * them. Ranking never adds a model to a pool; this tells the operator one may
 * be worth adding. Pure.
 */

import { z } from "zod";
import { LEADER_BOARD_IDS, type ArenaRankingsFile } from "./arena-aliases";
import { clearsLeaderBar, marginInWidths, type CiBounds } from "./arena-leader-rule";
import { DEFAULT_LEADER_MARGIN_CI, LEADER_ROLE_ID, sameModelRef, type RoleModelPolicy } from "./role-policy-schema";

export const UnpooledChallengerSchema = z.object({
  arenaName: z.string(),
  /** Our ref when the alias table maps it; absent for a model nobody has mapped yet. */
  ours: z.string().optional(),
  rating: z.number(),
  ratingLower: z.number(),
  ratingUpper: z.number(),
  /** How far its lower bound sits past the incumbent's upper bound, in its own CI widths. */
  marginWidths: z.number(),
  board: z.string(),
  /** The board's own publish date, when the file has history for it. */
  publishDate: z.string().optional(),
  /** Arena's display name, when the rankings file carries one. */
  displayName: z.string().optional(),
  /** The leader pool's first entry, the model this one ranks above. */
  incumbentRef: z.string().optional(),
  /** The incumbent's Arena display name, when its top row carries one. */
  incumbentName: z.string().optional(),
});

export type UnpooledChallenger = z.infer<typeof UnpooledChallengerSchema>;

export interface UnpooledChallengerInput {
  rankings: ArenaRankingsFile | undefined;
  policy: Pick<RoleModelPolicy, "roles" | "arena">;
}

interface IncumbentRow extends CiBounds {
  rating: number;
  displayName?: string;
}

/** The incumbent's best row on the board: from the newest publish's matched rows, else the top rows. */
function incumbentRow(input: UnpooledChallengerInput, board: string, incumbentRef: string): IncumbentRow | undefined {
  const matched = input.rankings?.leaderHistory?.[board]?.[0]?.rows ?? [];
  const top = input.rankings?.boardTop?.[board] ?? [];
  let best: IncumbentRow | undefined;
  for (const row of [...matched, ...top]) {
    if (row.ours !== undefined && sameModelRef(row.ours, incumbentRef) && (best === undefined || row.rating > best.rating)) {
      best = row;
    }
  }
  // History rows carry no display name; take it from the incumbent's top row when there is one.
  const displayName = top.find((row) => row.ours !== undefined && sameModelRef(row.ours, incumbentRef) && row.displayName)?.displayName;
  return best && displayName ? { ...best, displayName } : best;
}

/** What a person calls each leader board. */
const BOARD_LABELS: Readonly<Record<string, string>> = {
  "agent/overall": "the agent board",
  "text_style_control/hard_prompts": "the hard-prompts board",
};

/** Arena's display name without its effort suffix: "GPT-7 (Max)" reads as "GPT-7". */
function plainName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "");
}

/**
 * The dashboard's one-line alert for a challenger: "GPT-7 ranks above Claude
 * Opus 5.5 on the agent board and is in no pool." Falls back to the canonical
 * Arena name and our ref for a rankings file written before display names.
 */
export function unpooledChallengerMessage(challenger: UnpooledChallenger): string {
  const name = plainName(challenger.displayName ?? challenger.arenaName);
  const incumbent = plainName(challenger.incumbentName ?? challenger.incumbentRef ?? "the leader's model");
  const board = BOARD_LABELS[challenger.board] ?? challenger.board;
  return `${name} ranks above ${incumbent} on ${board} and is in no pool.`;
}

/**
 * Rows above the incumbent on `arena.leader.boards[0]` (default `agent/overall`)
 * that clear `clearsLeaderBar` by the leader margin and match no pool entry in
 * any role. No streak and no proxy width: an unaliased row has no known effort,
 * and this is an alert, not a pick. The incumbent is the leader role's first
 * pool entry, compared on its best row. It is looked up in the newest
 * publish's full matched rows, so a crowd of ten better models can't push it
 * out of the capped top rows and silence the alert.
 */
export function findUnpooledLeaderChallengers(input: UnpooledChallengerInput): UnpooledChallenger[] {
  const leader = input.policy.arena?.leader;
  const board = leader?.boards[0] ?? LEADER_BOARD_IDS[0];
  const rows = input.rankings?.boardTop?.[board];
  const incumbentRef = input.policy.roles.find((role) => role.id === LEADER_ROLE_ID)?.models[0];
  if (!rows || incumbentRef === undefined) {
    return [];
  }
  const incumbent = incumbentRow(input, board, incumbentRef);
  if (!incumbent) {
    return [];
  }

  const pooled = input.policy.roles.flatMap((role) => [...role.models, ...role.mechanicalModels, ...role.hardModels]);
  const inSomePool = (ours: string) => pooled.some((ref) => sameModelRef(ref, ours));
  const margin = leader?.marginCi ?? DEFAULT_LEADER_MARGIN_CI;
  const publishDate = input.rankings?.leaderHistory?.[board]?.[0]?.publishDate;

  return rows
    .filter((row) => row.rating > incumbent.rating && clearsLeaderBar(row, incumbent, margin))
    .filter((row) => row.ours === undefined || !inSomePool(row.ours))
    .sort((a, b) => b.rating - a.rating)
    .map((row) => ({
      arenaName: row.arenaName,
      ...(row.ours !== undefined ? { ours: row.ours } : {}),
      rating: row.rating,
      ratingLower: row.ratingLower,
      ratingUpper: row.ratingUpper,
      marginWidths: marginInWidths(row, incumbent),
      board,
      ...(publishDate !== undefined ? { publishDate } : {}),
      ...(row.displayName !== undefined ? { displayName: row.displayName } : {}),
      incumbentRef,
      ...(incumbent.displayName !== undefined ? { incumbentName: incumbent.displayName } : {}),
    }));
}
