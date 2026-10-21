/**
 * The leader pick's switching bar (R6, docs/arena-ranking.md "Leaders"), shared
 * by the pick itself (`server/arena-model-pick.ts`'s `decideLeaderPick`) and
 * the unpooled-challenger alert (`shared/arena-unpooled.ts`), so the alert can
 * never name a model the pick would not move to.
 */

/** The confidence interval of one leaderboard row. */
export interface CiBounds {
  ratingLower: number;
  ratingUpper: number;
}

/**
 * Whether `challenger` clears `incumbent`: its lower bound must sit above the
 * incumbent's upper bound by `marginWidths` widths of the challenger's own CI.
 * Zero widths is a plain non-overlap win. A degenerate or inverted CI never
 * clears: a negative width would turn the margin into a head start, so a
 * malformed row must not count toward a streak.
 */
export function clearsLeaderBar(challenger: CiBounds, incumbent: CiBounds, marginWidths: number): boolean {
  const width = challenger.ratingUpper - challenger.ratingLower;
  if (!(width > 0)) {
    return false;
  }
  return challenger.ratingLower - marginWidths * width > incumbent.ratingUpper;
}

/** How far the challenger's lower bound sits past the incumbent's upper bound, in challenger CI widths. Negative when they overlap. */
export function marginInWidths(challenger: CiBounds, incumbent: CiBounds): number {
  const width = challenger.ratingUpper - challenger.ratingLower;
  return width > 0 ? (challenger.ratingLower - incumbent.ratingUpper) / width : 0;
}
