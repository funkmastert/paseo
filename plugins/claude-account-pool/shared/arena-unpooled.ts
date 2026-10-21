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
});

export type UnpooledChallenger = z.infer<typeof UnpooledChallengerSchema>;

export interface UnpooledChallengerInput {
  rankings: ArenaRankingsFile | undefined;
  policy: Pick<RoleModelPolicy, "roles" | "arena">;
}

/** The incumbent's best row on the board: from the newest publish's matched rows, else the top rows. */
function incumbentRow(input: UnpooledChallengerInput, board: string, incumbentRef: string): (CiBounds & { rating: number }) | undefined {
  const matched = input.rankings?.leaderHistory?.[board]?.[0]?.rows ?? [];
  const top = input.rankings?.boardTop?.[board] ?? [];
  let best: (CiBounds & { rating: number }) | undefined;
  for (const row of [...matched, ...top]) {
    if (row.ours !== undefined && sameModelRef(row.ours, incumbentRef) && (best === undefined || row.rating > best.rating)) {
      best = row;
    }
  }
  return best;
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
    }));
}
