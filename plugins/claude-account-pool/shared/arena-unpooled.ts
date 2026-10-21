/**
 * The unpooled-challenger alert (docs/arena-ranking.md, "Leaders"): models
 * that beat the leader pool's incumbent on the first leader board by the
 * leader pick's own bar, but sit in no role's pool, so the pick can never run
 * them. Ranking never adds a model to a pool; this tells the operator one may
 * be worth adding. Pure.
 */

import { LEADER_BOARD_IDS, type ArenaRankingsFile, type ArenaTopRow } from "./arena-aliases";
import { clearsLeaderBar, marginInWidths } from "./arena-leader-rule";
import { sameModel } from "./model-identity";
import { LEADER_ROLE_ID, modelRefFamily, splitModelRef, type RoleModelPolicy } from "./role-policy-schema";

/** The leader pick's default margin, used when the policy has no `arena.leader` block. */
const DEFAULT_LEADER_MARGIN_CI = 1;

export interface UnpooledChallenger {
  arenaName: string;
  /** Our ref when the alias table maps it; absent for a model nobody has mapped yet. */
  ours?: string;
  rating: number;
  ratingLower: number;
  ratingUpper: number;
  /** How far its lower bound sits past the incumbent's upper bound, in its own CI widths. */
  marginWidths: number;
  board: string;
  /** The board's own publish date, when the file has history for it. */
  publishDate?: string;
}

function samePoolRef(a: string, b: string): boolean {
  const left = splitModelRef(a);
  const right = splitModelRef(b);
  return left !== null && right !== null && modelRefFamily(left) === modelRefFamily(right) && sameModel(left.model, right.model);
}

/**
 * Rows above the incumbent on `arena.leader.boards[0]` (default `agent/overall`)
 * that clear `clearsLeaderBar` by the leader margin and match no pool entry in
 * any role. No streak and no proxy width: an unaliased row has no known effort,
 * and this is an alert, not a pick. The incumbent is the leader role's first
 * pool entry, compared on its best row on the board.
 */
export function findUnpooledLeaderChallengers(input: {
  rankings: ArenaRankingsFile | undefined;
  policy: Pick<RoleModelPolicy, "roles" | "arena">;
}): UnpooledChallenger[] {
  const leader = input.policy.arena?.leader;
  const board = leader?.boards[0] ?? LEADER_BOARD_IDS[0];
  const rows = input.rankings?.boardTop?.[board];
  const incumbentRef = input.policy.roles.find((role) => role.id === LEADER_ROLE_ID)?.models[0];
  if (!rows || incumbentRef === undefined) {
    return [];
  }
  const incumbentRows = rows.filter((row) => row.ours !== undefined && samePoolRef(row.ours, incumbentRef));
  const incumbent = incumbentRows.reduce<ArenaTopRow | undefined>(
    (best, row) => (best === undefined || row.rating > best.rating ? row : best),
    undefined,
  );
  if (!incumbent) {
    return [];
  }

  const pooled = input.policy.roles.flatMap((role) => [...role.models, ...role.mechanicalModels, ...role.hardModels]);
  const inSomePool = (ours: string) => pooled.some((ref) => samePoolRef(ref, ours));
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
