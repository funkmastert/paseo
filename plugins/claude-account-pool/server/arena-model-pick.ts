/**
 * The pure ranking core behind U8's "worker model pick" diagram (KTD-1,
 * KTD-2, KTD-11, KTD-13): given a role's already-approved pool and the day's
 * LMArena rankings, decides whether a ranked reorder applies, or today's
 * order stands. Called from classifier.ts's `decideModel`; no I/O, no clock
 * read beyond the `nowMs` argument — `classifyAgent` stays pure by handing
 * this world data alone.
 */

import {
  KIND_BOARD_PREFERENCE,
  type ArenaRankingRow,
  type ArenaRankingsFile,
  type WorkKind,
} from "../shared/arena-aliases";
import type { ArenaPolicy, TaskClassId } from "../shared/role-policy-schema";

/** Carried on every ranked decision (CC-BY-4.0). */
export const ARENA_CREDIT = "LMArena leaderboard dataset (CC-BY-4.0)";

/** A proxy row (not at our planned effort) costs one extra CI width on top of `topTierMarginCi` (KTD-11). */
const PROXY_EXTRA_MARGIN = 1;

/**
 * Arena's own effort vocabulary happens to match our thinking-level ids, but
 * this table is kept local rather than imported from `shared/thinking-levels.ts`:
 * that file is PR A's (Codex thinking clamps), and this module must build and
 * behave identically whether or not PR A has landed.
 */
const EFFORT_RANK: Readonly<Record<string, number>> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 };

/** Why ranking fell back to today's pool order (R8). Always a reason — never silent. */
export type ArenaFallbackReason =
  | "disabled"
  | "role-out-of-scope"
  | "leader"
  | "declared-class"
  | "unknown-kind"
  /** Covers both "no file" and "stale" (R8) — collapsed before this module ever sees them; see `ArenaPickInput.rankings`. */
  | "no-file"
  | "no-ranked-board";

/** The row data a decision was made from, for the decision log and the `paseo.arena-pick` label. */
export interface ArenaScoreSnapshot {
  ref: string;
  rating: number;
  ratingLower: number;
  ratingUpper: number;
  votes: number;
  effort: string;
  /** This row is not at our planned effort — a nearest-effort stand-in (KTD-11). */
  proxy: boolean;
}

export type ArenaPickDecision =
  | { outcome: "fallback"; reason: ArenaFallbackReason }
  | {
      outcome: "ranked";
      ref: string;
      /** Whether the winning ref is one of `arena.topTier`. */
      tier: "top" | "mid";
      board: string;
      publishDate: string;
      credit: string;
      pick: ArenaScoreSnapshot;
      /**
       * Present only when a top-tier candidate led the board on a hard task
       * and was evaluated against the best mid-tier candidate — whichever of
       * the two did not win, so the margin check is auditable either way.
       */
      comparedTo?: ArenaScoreSnapshot;
    };

export interface ArenaPickInput {
  /** The resolved role is the leader: refused unconditionally (KTD-1), whatever `arena.roles` says. */
  isLeader: boolean;
  /** The resolved role's policy id, e.g. `"worker"`. */
  roleId: string;
  /** Undefined means "no class resolved" — treated as `standard`, as `classModels` already does. */
  taskClass: TaskClassId | undefined;
  /** Whether a `paseo.task-class` label decided the class: a declared label always wins (KTD-12). */
  taskClassDeclared: boolean;
  /** The kind of work (KTD-12): a JEV answer, the reviewer default, or undefined when unknown. */
  kind: WorkKind | undefined;
  /** `classModels(role, taskClass)`, in operator order — ranking may only reorder this pool, never add to it. */
  pool: readonly string[];
  /** The same usability bar `selectModel` applies (`role-availability.ts`'s `isModelRefUsable`). */
  isUsable: (ref: string) => boolean;
  arena: ArenaPolicy | undefined;
  /**
   * Undefined covers both "no file" and "stale" (R8): the cache that feeds
   * `ClassifierWorld.arenaRanking` already applies `arena.maxAgeHours` via
   * `loadArenaRankings` (U6), so by the time this reaches the pure
   * classifier the two are indistinguishable, and deliberately so — this
   * function never reads a clock (`classifyAgent` stays pure, no `nowMs`).
   */
  rankings: ArenaRankingsFile | undefined;
  /** `policy.thinking.byTaskClass[taskClass ?? "standard"]`: the effort this spawn actually plans to run at. */
  plannedEffort: string;
}

function fallback(reason: ArenaFallbackReason): ArenaPickDecision {
  return { outcome: "fallback", reason };
}

/**
 * Moves `ref` to the front of `pool`, keeping every other entry in its
 * relative order — the only shape of "reorder" ranking is allowed to do
 * (KTD-13: it reorders an already-approved pool, never adds to it). `ref`
 * absent from `pool` leaves it unchanged, which should not happen since the
 * caller always picks `ref` out of this same pool.
 */
export function moveRefToFront(pool: readonly string[], ref: string): string[] {
  return pool.includes(ref) ? [ref, ...pool.filter((entry) => entry !== ref)] : [...pool];
}

/** The nearest-effort row for one ref on a board: an exact match to `plannedEffort`, else the closest by `EFFORT_RANK`. */
function bestRowFor(
  ref: string,
  rows: readonly ArenaRankingRow[],
  plannedEffort: string,
): { row: ArenaRankingRow; proxy: boolean } | undefined {
  const candidates = rows.filter((row) => row.ours === ref);
  if (candidates.length === 0) {
    return undefined;
  }
  const exact = candidates.find((row) => row.effort === plannedEffort);
  if (exact) {
    return { row: exact, proxy: false };
  }
  const plannedRank = EFFORT_RANK[plannedEffort];
  // An operator-configured effort id outside EFFORT_RANK's known ids (thinking.byTaskClass is
  // validated only by a free-form regex, not this closed set) gives no reasoned "nearest" to pick:
  // refuse to proxy rather than silently landing on candidates[0] by construction.
  if (plannedRank === undefined) {
    return undefined;
  }
  let best: ArenaRankingRow | undefined;
  let bestDistance = Infinity;
  for (const row of candidates) {
    const rank = EFFORT_RANK[row.effort];
    const distance = rank === undefined ? Infinity : Math.abs(rank - plannedRank);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  // Every candidate row has an unrecognized effort id too: same "no reasoned nearest" refusal.
  return best ? { row: best, proxy: true } : undefined;
}

interface RankedCandidate {
  ref: string;
  poolIndex: number;
  row?: ArenaRankingRow;
  proxy: boolean;
}

/** Two rows whose confidence intervals overlap are a tie, settled by operator order (KTD-11). */
function ciOverlaps(a: ArenaRankingRow, b: ArenaRankingRow): boolean {
  return !(a.ratingLower > b.ratingUpper || b.ratingLower > a.ratingUpper);
}

/**
 * Ranked candidates by score (CI-overlap ties broken by operator order), then
 * unranked ones in operator order.
 *
 * CI overlap is not transitive — A can overlap B and B can overlap C while A
 * and C don't — so a pairwise comparator handed to `Array.sort` is not a
 * total order, and the result for 3+ candidates would depend on the engine's
 * sort algorithm rather than a well-defined rule. Sorting purely by score
 * first (always transitive) and then merging each run of adjacent,
 * CI-overlapping candidates into one tie-group — settled internally by
 * operator order — is transitive by construction. A chain (A-B and B-C
 * overlap, A-C doesn't) merges into one group rather than three isolated
 * pairs: the alternative, requiring every pair in a group to overlap
 * directly, has no well-defined answer either once a chain like that exists.
 */
function orderCandidates(candidates: readonly RankedCandidate[]): RankedCandidate[] {
  const unranked = candidates.filter((c) => c.row === undefined);
  unranked.sort((a, b) => a.poolIndex - b.poolIndex);

  const byScore = candidates
    .filter((c): c is RankedCandidate & { row: ArenaRankingRow } => c.row !== undefined)
    .sort((a, b) => b.row.rating - a.row.rating);

  const ordered: Array<RankedCandidate & { row: ArenaRankingRow }> = [];
  let groupStart = 0;
  for (let i = 1; i <= byScore.length; i++) {
    const extendsGroup = i < byScore.length && ciOverlaps(byScore[i - 1].row, byScore[i].row);
    if (extendsGroup) {
      continue;
    }
    const group = byScore.slice(groupStart, i).sort((a, b) => a.poolIndex - b.poolIndex);
    ordered.push(...group);
    groupStart = i;
  }
  return [...ordered, ...unranked];
}

function toSnapshot(candidate: RankedCandidate & { row: ArenaRankingRow }): ArenaScoreSnapshot {
  const { row } = candidate;
  return {
    ref: candidate.ref,
    rating: row.rating,
    ratingLower: row.ratingLower,
    ratingUpper: row.ratingUpper,
    votes: row.votes,
    effort: row.effort,
    proxy: candidate.proxy,
  };
}

/**
 * The pure core of the "Worker model pick" diagram. Returns `fallback` for
 * every doubt R8 names (disabled, leader, out-of-scope role, declared class,
 * unknown kind, no/stale file, no board with two-plus ranked candidates), and
 * `ranked` otherwise — leaving the caller to decide whether `arena.shadow`
 * means recording the pick without applying it.
 */
export function decideArenaPick(input: ArenaPickInput): ArenaPickDecision {
  if (!input.arena || !input.arena.enabled) {
    return fallback("disabled");
  }
  if (input.isLeader) {
    return fallback("leader");
  }
  if (!input.arena.roles.includes(input.roleId)) {
    return fallback("role-out-of-scope");
  }
  if (input.taskClassDeclared) {
    return fallback("declared-class");
  }
  if (input.kind === undefined || input.kind === "other") {
    return fallback("unknown-kind");
  }
  if (!input.rankings) {
    return fallback("no-file");
  }

  const taskClass = input.taskClass ?? "standard";
  const arena = input.arena;
  const isTopTierRef = (ref: string) => arena.topTier.includes(ref);

  let candidatePool = input.pool.filter((ref) => input.isUsable(ref));
  if (taskClass !== "hard") {
    candidatePool = candidatePool.filter((ref) => !isTopTierRef(ref));
  }

  const boardIds = KIND_BOARD_PREFERENCE[input.kind];
  for (const boardId of boardIds) {
    const rows = input.rankings.boards[boardId] ?? [];
    const candidates: RankedCandidate[] = candidatePool.map((ref, poolIndex) => {
      const best = bestRowFor(ref, rows, input.plannedEffort);
      return { ref, poolIndex, row: best?.row, proxy: best?.proxy ?? false };
    });
    if (candidates.filter((c) => c.row !== undefined).length < 2) {
      continue;
    }

    const ordered = orderCandidates(candidates);
    const top = ordered[0] as RankedCandidate & { row: ArenaRankingRow };

    if (!isTopTierRef(top.ref) || taskClass !== "hard") {
      return {
        outcome: "ranked",
        ref: top.ref,
        tier: isTopTierRef(top.ref) ? "top" : "mid",
        board: boardId,
        publishDate: input.rankings.publishDate,
        credit: ARENA_CREDIT,
        pick: toSnapshot(top),
      };
    }

    // The top pick is top-tier on a hard task: it wins only by clearing the best mid-tier
    // candidate's CI upper bound by `topTierMarginCi` extra widths, plus one more for a proxy row.
    const bestMidTier = ordered.find(
      (c): c is RankedCandidate & { row: ArenaRankingRow } => !isTopTierRef(c.ref) && c.row !== undefined,
    );
    if (!bestMidTier) {
      return {
        outcome: "ranked",
        ref: top.ref,
        tier: "top",
        board: boardId,
        publishDate: input.rankings.publishDate,
        credit: ARENA_CREDIT,
        pick: toSnapshot(top),
      };
    }
    const ciWidth = top.row.ratingUpper - top.row.ratingLower;
    const margin = arena.topTierMarginCi + (top.proxy ? PROXY_EXTRA_MARGIN : 0);
    const clears = top.row.ratingLower - margin * ciWidth > bestMidTier.row.ratingUpper;
    const winner = clears ? top : bestMidTier;
    const other = clears ? bestMidTier : top;
    return {
      outcome: "ranked",
      ref: winner.ref,
      tier: clears ? "top" : "mid",
      board: boardId,
      publishDate: input.rankings.publishDate,
      credit: ARENA_CREDIT,
      pick: toSnapshot(winner),
      comparedTo: toSnapshot(other),
    };
  }

  return fallback("no-ranked-board");
}
