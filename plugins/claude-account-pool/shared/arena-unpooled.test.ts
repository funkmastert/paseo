import { describe, expect, it } from "vitest";
import type { ArenaRankingsFile, ArenaTopRow } from "./arena-aliases";
import { findUnpooledLeaderChallengers } from "./arena-unpooled";
import { DEFAULT_POLICY, type RoleModelPolicy } from "./role-policy-schema";

const OPUS = "claude-opus-5-5";

/** Leader pool Opus 5.5 then Opus 5; a worker pool that includes Sonnet 5.5 and a Codex ref. */
const policy: RoleModelPolicy = {
  ...DEFAULT_POLICY,
  roles: DEFAULT_POLICY.roles.map((role) =>
    role.id === "leader"
      ? { ...role, models: [OPUS, "claude-opus-5"] }
      : role.id === "worker"
        ? { ...role, models: ["claude-sonnet-5-5", "codex/gpt-6-sol"], hardModels: ["claude-haiku-4-5-20251001"] }
        : role,
  ),
};

function top(arenaName: string, rating: number, ours?: string, halfWidth = 0.02): ArenaTopRow {
  return { arenaName, ...(ours ? { ours, effort: "max" } : {}), rating, ratingLower: rating - halfWidth, ratingUpper: rating + halfWidth, votes: 1000 };
}

/** Today's real top of `agent/overall` (2026-10-19), trimmed. */
const today = [
  { arenaName: "claude-opus-5.5-max", ours: OPUS, effort: "max", rating: 0.2035, ratingLower: 0.1779, ratingUpper: 0.2291, votes: 1562084 },
  { arenaName: "gpt-6-astra-max", ours: "codex/gpt-6-astra", effort: "max", rating: 0.1515, ratingLower: 0.1291, ratingUpper: 0.1739, votes: 1055314 },
  { arenaName: "claude-fable-5.1-max", rating: 0.1433, ratingLower: 0.1234, ratingUpper: 0.1631, votes: 1962103 },
];

function file(boardTop: ArenaTopRow[] | undefined): ArenaRankingsFile {
  return {
    fetchedAt: Date.now(),
    publishDate: "2026-10-20",
    boards: {},
    unmatched: {},
    failedBoards: [],
    ...(boardTop ? { boardTop: { "agent/overall": boardTop } } : {}),
    leaderHistory: { "agent/overall": [{ publishDate: "2026-10-19", rows: [] }] },
  };
}

describe("findUnpooledLeaderChallengers", () => {
  it("today's board: nothing clears Opus 5.5 by a width", () => {
    expect(findUnpooledLeaderChallengers({ rankings: file(today), policy })).toEqual([]);
  });

  it("names an unaliased model that clears the incumbent, with its margin in widths", () => {
    const result = findUnpooledLeaderChallengers({ rankings: file([top("claude-next-6-max", 0.35), top("x", 0.1), top("claude-opus-5.5-max", 0.2, OPUS)]), policy });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ arenaName: "claude-next-6-max", board: "agent/overall", publishDate: "2026-10-19" });
    expect(result[0].ours).toBeUndefined();
    // Lower 0.33 vs Opus upper 0.22, width 0.04: 2.75 widths.
    expect(result[0].marginWidths).toBeCloseTo(2.75, 5);
  });

  it("leaves out a model that clears the bar but is already in some pool", () => {
    const rows = [top("claude-sonnet-5.5-max", 0.35, "claude-sonnet-5-5"), top("claude-haiku-4-5", 0.36, "claude-haiku-4-5"), top("claude-opus-5.5-max", 0.2, OPUS)];
    expect(findUnpooledLeaderChallengers({ rankings: file(rows), policy })).toEqual([]);
  });

  it("includes a mapped model that is in no pool, e.g. a Codex ref nobody routes to", () => {
    const rows = [top("gpt-6-astra-max", 0.35, "codex/gpt-6-astra"), top("claude-opus-5.5-max", 0.2, OPUS)];
    expect(findUnpooledLeaderChallengers({ rankings: file(rows), policy }).map((row) => row.ours)).toEqual(["codex/gpt-6-astra"]);
  });

  it("uses arena.leader.marginCi when set: a plain non-overlap win at zero", () => {
    const rows = [top("claude-next-6-max", 0.25), top("claude-opus-5.5-max", 0.2, OPUS)];
    expect(findUnpooledLeaderChallengers({ rankings: file(rows), policy })).toEqual([]);
    const zeroMargin: RoleModelPolicy = {
      ...policy,
      arena: {
        enabled: false,
        shadow: true,
        roles: ["worker", "reviewer"],
        topTier: [],
        topTierMarginCi: 0,
        maxAgeHours: 72,
        leader: { enabled: false, shadow: true, boards: ["agent/overall"], marginCi: 0, streakPublishes: 3 },
      },
    };
    expect(findUnpooledLeaderChallengers({ rankings: file(rows), policy: zeroMargin })).toHaveLength(1);
  });

  it("still alerts when the incumbent has fallen out of the board's top rows, reading it from history", () => {
    const crowded = Array.from({ length: 10 }, (_, i) => top(`claude-next-${i}-max`, 0.5 - i * 0.01));
    const rankings: ArenaRankingsFile = {
      ...file(crowded),
      leaderHistory: {
        "agent/overall": [
          { publishDate: "2026-10-19", rows: [{ arenaName: "claude-opus-5.5-max", ours: OPUS, effort: "max", rating: 0.2, ratingLower: 0.18, ratingUpper: 0.22, votes: 1000 }] },
        ],
      },
    };
    expect(findUnpooledLeaderChallengers({ rankings, policy })).toHaveLength(10);
  });

  it("is empty when the incumbent is ranked nowhere on the board", () => {
    expect(findUnpooledLeaderChallengers({ rankings: file([top("claude-next-6-max", 0.35)]), policy })).toEqual([]);
  });

  it("is empty with no top rows, no file, or no leader pool", () => {
    expect(findUnpooledLeaderChallengers({ rankings: file(undefined), policy })).toEqual([]);
    expect(findUnpooledLeaderChallengers({ rankings: undefined, policy })).toEqual([]);
    expect(findUnpooledLeaderChallengers({ rankings: file(today), policy: DEFAULT_POLICY })).toEqual([]);
  });
});
