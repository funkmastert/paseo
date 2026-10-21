import { describe, expect, it } from "vitest";
import type { ArenaRankingRow, ArenaRankingsFile } from "../shared/arena-aliases";
import { clearsLeaderBar } from "../shared/arena-leader-rule";
import type { ArenaLeaderPolicy, ArenaPolicy } from "../shared/role-policy-schema";
import { ARENA_CREDIT, decideArenaPick, decideLeaderPick, type ArenaPickInput, type LeaderPickInput } from "./arena-model-pick";

const NOW = Date.parse("2026-10-09T12:00:00Z");

function arenaPolicy(overrides: Partial<ArenaPolicy> = {}): ArenaPolicy {
  return {
    enabled: true,
    shadow: false,
    roles: ["worker", "reviewer"],
    topTier: ["claude-opus-5-5"],
    topTierMarginCi: 0,
    maxAgeHours: 72,
    ...overrides,
  };
}

function row(overrides: Partial<ArenaRankingRow> & { ours: string }): ArenaRankingRow {
  return { arenaName: overrides.ours, effort: "high", rating: 1500, ratingLower: 1490, ratingUpper: 1510, votes: 500, ...overrides };
}

function rankings(boards: Record<string, ArenaRankingRow[]>, overrides: Partial<ArenaRankingsFile> = {}): ArenaRankingsFile {
  return { fetchedAt: NOW - 60 * 60 * 1000, publishDate: "2026-10-08", boards, unmatched: {}, failedBoards: [], ...overrides };
}

function input(overrides: Partial<ArenaPickInput> = {}): ArenaPickInput {
  return {
    isLeader: false,
    roleId: "worker",
    taskClass: "standard",
    taskClassDeclared: false,
    kind: "frontend",
    pool: ["claude-sonnet-5-5", "codex/gpt-6-sol"],
    isUsable: () => true,
    arena: arenaPolicy(),
    rankings: rankings({ "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5", rating: 1774 }), row({ ours: "codex/gpt-6-sol", rating: 1688 })] }),
    plannedEffort: "high",
    ...overrides,
  };
}

describe("decideArenaPick — fallbacks (R8)", () => {
  it("disabled: arena missing entirely", () => {
    expect(decideArenaPick(input({ arena: undefined }))).toEqual({ outcome: "fallback", reason: "disabled" });
  });

  it("disabled: arena.enabled is false", () => {
    expect(decideArenaPick(input({ arena: arenaPolicy({ enabled: false }) }))).toEqual({ outcome: "fallback", reason: "disabled" });
  });

  it("leader: refused even when arena.roles lists it", () => {
    expect(decideArenaPick(input({ isLeader: true, arena: arenaPolicy({ roles: ["worker", "leader"] }), roleId: "leader" }))).toEqual({
      outcome: "fallback",
      reason: "leader",
    });
  });

  it("role-out-of-scope: an advisor is not in arena.roles by default", () => {
    expect(decideArenaPick(input({ roleId: "advisor" }))).toEqual({ outcome: "fallback", reason: "role-out-of-scope" });
  });

  it("declared-class: a paseo.task-class label always wins", () => {
    expect(decideArenaPick(input({ taskClassDeclared: true }))).toEqual({ outcome: "fallback", reason: "declared-class" });
  });

  it("unknown-kind: no kind at all", () => {
    expect(decideArenaPick(input({ kind: undefined }))).toEqual({ outcome: "fallback", reason: "unknown-kind" });
  });

  it("unknown-kind: kind is 'other'", () => {
    expect(decideArenaPick(input({ kind: "other" }))).toEqual({ outcome: "fallback", reason: "unknown-kind" });
  });

  it("no-file: rankings missing (covers both missing and stale — the cache applies maxAgeHours before this ever runs)", () => {
    expect(decideArenaPick(input({ rankings: undefined }))).toEqual({ outcome: "fallback", reason: "no-file" });
  });

  it("no-ranked-board: the only board has one ranked usable candidate, and no board is left", () => {
    const onlyOneRanked = rankings({ "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5" })], "webdev/overall": [], "agent/overall": [] });
    expect(decideArenaPick(input({ rankings: onlyOneRanked }))).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
  });

  it("a rejected (unusable) ref does not count toward the two-candidate floor", () => {
    const result = decideArenaPick(
      input({
        isUsable: (ref) => ref !== "codex/gpt-6-sol",
        rankings: rankings({ "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5" }), row({ ours: "codex/gpt-6-sol" })] }),
      }),
    );
    expect(result).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
  });
});

describe("decideArenaPick — ordinary ranked picks", () => {
  it("a frontend standard worker: webdev ranks sonnet-5.5 above gpt-6-sol, and sonnet-5.5 is picked", () => {
    const result = decideArenaPick(input());
    expect(result).toMatchObject({ outcome: "ranked", ref: "claude-sonnet-5-5", tier: "mid", board: "webdev/webdev-react" });
    expect(result).toMatchObject({ credit: ARENA_CREDIT, publishDate: "2026-10-08" });
  });

  it("a standard worker never gets a topTier ref, even when that ref ranks first", () => {
    const result = decideArenaPick(
      input({
        pool: ["claude-opus-5-5", "claude-sonnet-5-5", "codex/gpt-6-sol"],
        rankings: rankings({
          "webdev/webdev-react": [
            row({ ours: "claude-opus-5-5", rating: 1900 }),
            row({ ours: "claude-sonnet-5-5", rating: 1700 }),
            row({ ours: "codex/gpt-6-sol", rating: 1600 }),
          ],
        }),
      }),
    );
    // Opus 5.5 (topTier) ranks first on raw score but is dropped from a standard pool before
    // ranking ever runs, so the best REMAINING candidate (sonnet-5.5) wins, not gpt-6-sol.
    expect(result).toMatchObject({ outcome: "ranked", ref: "claude-sonnet-5-5" });
  });

  it("CI overlap between two mid-tier candidates: operator order decides", () => {
    const result = decideArenaPick(
      input({
        pool: ["codex/gpt-6-sol", "claude-sonnet-5-5"],
        rankings: rankings({
          "webdev/webdev-react": [row({ ours: "codex/gpt-6-sol", rating: 1700, ratingLower: 1680, ratingUpper: 1720 }), row({ ours: "claude-sonnet-5-5", rating: 1705, ratingLower: 1685, ratingUpper: 1725 })],
        }),
      }),
    );
    // Overlapping CIs: the first-listed pool entry wins the tie.
    expect(result).toMatchObject({ outcome: "ranked", ref: "codex/gpt-6-sol" });
  });

  it("a chained CI overlap (A-B overlap, B-C overlap, A-C don't) merges into one tie-group settled by operator order (finding #7)", () => {
    // Deliberately scrambled operator order so the winner proves the group-merge rule rather
    // than coinciding with score order or pool order by accident.
    const result = decideArenaPick(
      input({
        pool: ["codex/gpt-6-luna", "claude-sonnet-5-5", "codex/gpt-6-sol"],
        rankings: rankings({
          "webdev/webdev-react": [
            row({ ours: "codex/gpt-6-luna", rating: 85, ratingLower: 70, ratingUpper: 95 }), // C
            row({ ours: "claude-sonnet-5-5", rating: 115, ratingLower: 100, ratingUpper: 120 }), // A: highest score
            row({ ours: "codex/gpt-6-sol", rating: 100, ratingLower: 90, ratingUpper: 105 }), // B: overlaps both A and C
          ],
        }),
      }),
    );
    // A and C do not directly overlap, but both overlap B, so all three merge into one group;
    // operator order within that group picks codex/gpt-6-luna (listed first), not
    // claude-sonnet-5-5 (the highest raw score).
    expect(result).toMatchObject({ outcome: "ranked", ref: "codex/gpt-6-luna" });
  });

  it("an unranked candidate sorts after ranked ones", () => {
    const result = decideArenaPick(
      input({
        pool: ["codex/gpt-5.6-terra", "claude-sonnet-5-5", "codex/gpt-6-sol"],
        rankings: rankings({ "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5", rating: 1774 }), row({ ours: "codex/gpt-6-sol", rating: 1688 })] }),
      }),
    );
    // codex/gpt-5.6-terra has no row at all, so a ranked candidate wins even though it is listed
    // first in the pool.
    expect(result).toMatchObject({ outcome: "ranked", ref: "claude-sonnet-5-5" });
  });

  it("the only board has one ranked candidate; the next board is tried and succeeds", () => {
    const result = decideArenaPick(
      input({
        rankings: rankings({
          "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5" })],
          "webdev/overall": [row({ ours: "claude-sonnet-5-5", rating: 1500 }), row({ ours: "codex/gpt-6-sol", rating: 1400 })],
        }),
      }),
    );
    expect(result).toMatchObject({ outcome: "ranked", board: "webdev/overall" });
  });

  it("the effort-proxy row is used and recorded when no row exists at our effort", () => {
    const result = decideArenaPick(
      input({
        plannedEffort: "high",
        rankings: rankings({
          "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5", effort: "xhigh" }), row({ ours: "codex/gpt-6-sol", effort: "max" })],
        }),
      }),
    );
    expect(result).toMatchObject({ outcome: "ranked", pick: { proxy: true, effort: "xhigh" } });
  });

  it("a topTier entry that is in no pool is ignored", () => {
    const result = decideArenaPick(
      input({
        arena: arenaPolicy({ topTier: ["codex/gpt-6-astra"] }), // never in this pool
      }),
    );
    expect(result).toMatchObject({ outcome: "ranked", tier: "mid" });
  });

  it("refuses to proxy a row when plannedEffort is outside EFFORT_RANK's known ids, rather than landing on an arbitrary row", () => {
    // Neither candidate has a row at "turbo" (not a real effort id), so with no reasoned
    // "nearest" to pick, both candidates are treated as unranked and the board never reaches
    // the two-candidate floor.
    const result = decideArenaPick(
      input({
        plannedEffort: "turbo",
        rankings: rankings({
          "webdev/webdev-react": [row({ ours: "claude-sonnet-5-5", effort: "xhigh" }), row({ ours: "codex/gpt-6-sol", effort: "max" })],
        }),
      }),
    );
    expect(result).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
  });
});

describe("decideArenaPick — hard class and top tier (KTD-2)", () => {
  function hardInput(overrides: Partial<ArenaPickInput> = {}): ArenaPickInput {
    return input({
      taskClass: "hard",
      kind: "coding",
      pool: ["claude-opus-5-5", "claude-sonnet-5-5"],
      plannedEffort: "xhigh",
      ...overrides,
    });
  }

  it("Opus 5.5's CI overlaps Sonnet 5.5's: the best mid-tier model is picked", () => {
    const result = decideArenaPick(
      hardInput({
        rankings: rankings({
          "agent/overall": [
            row({ ours: "claude-opus-5-5", effort: "xhigh", rating: 0.14, ratingLower: 0.12, ratingUpper: 0.16 }),
            row({ ours: "claude-sonnet-5-5", effort: "xhigh", rating: 0.12, ratingLower: 0.11, ratingUpper: 0.13 }),
          ],
        }),
      }),
    );
    expect(result).toMatchObject({ outcome: "ranked", ref: "claude-sonnet-5-5", tier: "mid" });
    expect((result as { comparedTo?: unknown }).comparedTo).toBeDefined();
  });

  it("a hard worker whose top-tier CI clears the best mid-tier: the top-tier model is picked", () => {
    const result = decideArenaPick(
      hardInput({
        rankings: rankings({
          "agent/overall": [
            row({ ours: "claude-opus-5-5", effort: "xhigh", rating: 0.2, ratingLower: 0.18, ratingUpper: 0.22 }),
            row({ ours: "claude-sonnet-5-5", effort: "xhigh", rating: 0.1, ratingLower: 0.08, ratingUpper: 0.1 }),
          ],
        }),
      }),
    );
    expect(result).toMatchObject({ outcome: "ranked", ref: "claude-opus-5-5", tier: "top" });
  });

  it("topTierMarginCi: 1 turns a narrow top-tier win into a mid-tier pick", () => {
    const narrowWinRankings = rankings({
      "agent/overall": [
        row({ ours: "claude-opus-5-5", effort: "xhigh", rating: 0.14, ratingLower: 0.121, ratingUpper: 0.16 }),
        row({ ours: "claude-sonnet-5-5", effort: "xhigh", rating: 0.12, ratingLower: 0.11, ratingUpper: 0.12 }),
      ],
    });
    const atZero = decideArenaPick(hardInput({ rankings: narrowWinRankings, arena: arenaPolicy({ topTierMarginCi: 0, topTier: ["claude-opus-5-5"] }) }));
    expect(atZero).toMatchObject({ ref: "claude-opus-5-5", tier: "top" });

    const atOne = decideArenaPick(hardInput({ rankings: narrowWinRankings, arena: arenaPolicy({ topTierMarginCi: 1, topTier: ["claude-opus-5-5"] }) }));
    expect(atOne).toMatchObject({ ref: "claude-sonnet-5-5", tier: "mid" });
  });

  it("a top-tier candidate on a proxy row that clears by less than one extra CI width loses to the best mid-tier", () => {
    const result = decideArenaPick(
      hardInput({
        plannedEffort: "xhigh",
        rankings: rankings({
          // Opus row is "high" (a proxy, since we planned xhigh); clears at margin 0 but not margin 1 (proxy).
          "agent/overall": [
            row({ ours: "claude-opus-5-5", effort: "high", rating: 0.14, ratingLower: 0.121, ratingUpper: 0.16 }),
            row({ ours: "claude-sonnet-5-5", effort: "xhigh", rating: 0.12, ratingLower: 0.11, ratingUpper: 0.12 }),
          ],
        }),
        arena: arenaPolicy({ topTierMarginCi: 0, topTier: ["claude-opus-5-5"] }),
      }),
    );
    expect(result).toMatchObject({ ref: "claude-sonnet-5-5", tier: "mid" });
  });

  it("a hard pick with no mid-tier candidate at all still picks the top-tier ref", () => {
    const result = decideArenaPick(
      hardInput({
        pool: ["claude-opus-5-5"],
        rankings: rankings({ "agent/overall": [row({ ours: "claude-opus-5-5", effort: "xhigh" })] }),
      }),
    );
    // Only one candidate: never reaches the two-candidate floor, so this falls back.
    expect(result).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
  });
});

describe("decideArenaPick — the rest reads as a would-be pick regardless of shadow", () => {
  it("returns a ranked decision even when arena.shadow is true — applying it is the caller's job", () => {
    const result = decideArenaPick(input({ arena: arenaPolicy({ shadow: true }) }));
    expect(result.outcome).toBe("ranked");
  });
});

describe("clearsLeaderBar (R6)", () => {
  const incumbent = { ratingLower: 0.18, ratingUpper: 0.22 };

  it("needs the challenger's lower bound past the incumbent's upper bound by margin widths of its own CI", () => {
    // Width 0.04: one width means a lower bound above 0.26.
    expect(clearsLeaderBar({ ratingLower: 0.27, ratingUpper: 0.31 }, incumbent, 1)).toBe(true);
    expect(clearsLeaderBar({ ratingLower: 0.25, ratingUpper: 0.29 }, incumbent, 1)).toBe(false);
  });

  it("is a plain non-overlap win at margin zero", () => {
    expect(clearsLeaderBar({ ratingLower: 0.23, ratingUpper: 0.27 }, incumbent, 0)).toBe(true);
    expect(clearsLeaderBar({ ratingLower: 0.22, ratingUpper: 0.26 }, incumbent, 0)).toBe(false);
  });
});

describe("decideLeaderPick", () => {
  const OPUS = "claude-opus-5-5";
  const SONNET = "claude-sonnet-5-5";
  const OPUS5 = "claude-opus-5";

  function leaderPolicy(overrides: Partial<ArenaLeaderPolicy> = {}): ArenaLeaderPolicy {
    return { enabled: true, shadow: true, boards: ["agent/overall", "text_style_control/hard_prompts"], marginCi: 1, streakPublishes: 3, ...overrides };
  }

  /** A row with a CI half-width of 0.02 around `rating`, at Max effort like Arena's agent board. */
  function agent(ours: string, rating: number, effort = "max"): ArenaRankingRow {
    return { arenaName: ours, ours, effort, rating, ratingLower: rating - 0.02, ratingUpper: rating + 0.02, votes: 1000 };
  }

  /** Newest first. Each publish's rows also become the file's `boards` entry for the newest. */
  function withHistory(board: string, publishes: Array<{ date: string; rows: ArenaRankingRow[] }>): ArenaRankingsFile {
    return rankings(
      { [board]: publishes[0]?.rows ?? [] },
      { leaderHistory: { [board]: publishes.map((p) => ({ publishDate: p.date, rows: p.rows })) } },
    );
  }

  /** Sonnet clears Opus by more than one width (Sonnet lower 0.30 vs Opus upper 0.22, width 0.04). */
  const sonnetClears = [agent(OPUS, 0.2), agent(SONNET, 0.32)];
  /** Sonnet leads but its CI overlaps Opus's. */
  const sonnetTies = [agent(OPUS, 0.2), agent(SONNET, 0.23)];

  function leaderInput(overrides: Partial<LeaderPickInput> = {}): LeaderPickInput {
    return {
      pool: [OPUS, SONNET],
      isUsable: () => true,
      leader: leaderPolicy(),
      rankings: withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetTies },
        { date: "2026-10-16", rows: sonnetTies },
        { date: "2026-10-14", rows: sonnetTies },
      ]),
      plannedEffort: "xhigh",
      isSuccessor: false,
      ...overrides,
    };
  }

  describe("fallbacks", () => {
    it("disabled: no leader block, or leader.enabled false", () => {
      expect(decideLeaderPick(leaderInput({ leader: undefined }))).toEqual({ outcome: "fallback", reason: "disabled" });
      expect(decideLeaderPick(leaderInput({ leader: leaderPolicy({ enabled: false }) }))).toEqual({ outcome: "fallback", reason: "disabled" });
    });

    it("successor: an import successor is never re-picked, even with a winning challenger (AE5)", () => {
      const rankingsFile = withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetClears },
        { date: "2026-10-16", rows: sonnetClears },
        { date: "2026-10-14", rows: sonnetClears },
      ]);
      expect(decideLeaderPick(leaderInput({ isSuccessor: true, rankings: rankingsFile }))).toEqual({ outcome: "fallback", reason: "successor" });
    });

    it("no-file: rankings missing or stale", () => {
      expect(decideLeaderPick(leaderInput({ rankings: undefined }))).toEqual({ outcome: "fallback", reason: "no-file" });
    });

    it("no-ranked-board: only the incumbent is ranked anywhere", () => {
      const only = withHistory("agent/overall", [{ date: "2026-10-19", rows: [agent(OPUS, 0.2)] }]);
      expect(decideLeaderPick(leaderInput({ rankings: only }))).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
    });

    it("no-ranked-board: the only ranked challenger is unusable (capped)", () => {
      expect(decideLeaderPick(leaderInput({ isUsable: (ref) => ref !== SONNET }))).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
    });

    it("no-ranked-board: an empty pool", () => {
      expect(decideLeaderPick(leaderInput({ pool: [] }))).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
    });

    it("no-ranked-board: an unknown planned effort refuses every proxy row", () => {
      expect(decideLeaderPick(leaderInput({ plannedEffort: "turbo" }))).toEqual({ outcome: "fallback", reason: "no-ranked-board" });
    });
  });

  describe("the incumbent holds", () => {
    it("today's agent/overall numbers: Opus 5.5 holds against Opus 5, streak 0/3 (AE2)", () => {
      const today = [
        { arenaName: "claude-opus-5.5-max", ours: OPUS, effort: "max", rating: 0.2035, ratingLower: 0.1779, ratingUpper: 0.2291, votes: 1562084 },
        { arenaName: "claude-opus-5-max", ours: OPUS5, effort: "max", rating: 0.0808, ratingLower: 0.0641, ratingUpper: 0.0975, votes: 3216618 },
      ];
      const decision = decideLeaderPick(
        leaderInput({ pool: [OPUS, OPUS5], rankings: withHistory("agent/overall", [{ date: "2026-10-19", rows: today }]) }),
      );
      expect(decision).toMatchObject({
        outcome: "ranked",
        ref: OPUS,
        holds: "incumbent",
        board: "agent/overall",
        publishDate: "2026-10-19",
        credit: ARENA_CREDIT,
        streak: { won: 0, needed: 3 },
        incumbent: { ref: OPUS, proxy: true },
        challenger: { ref: OPUS5, proxy: true },
      });
    });

    it("a challenger that leads with an overlapping CI never builds a streak", () => {
      expect(decideLeaderPick(leaderInput())).toMatchObject({ ref: OPUS, holds: "incumbent", streak: { won: 0, needed: 3 } });
    });

    it("non-overlapping but under one extra width: holds", () => {
      // Sonnet lower 0.25 > Opus upper 0.22, but 0.25 - 0.04 = 0.21 does not clear 0.22.
      const close = [agent(OPUS, 0.2), agent(SONNET, 0.27)];
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: close },
        { date: "2026-10-16", rows: close },
        { date: "2026-10-14", rows: close },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({ ref: OPUS, holds: "incumbent", streak: { won: 0 } });
    });

    it("cleared on the two newest of three publishes: holds at 2/3 (AE3)", () => {
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetClears },
        { date: "2026-10-16", rows: sonnetClears },
        { date: "2026-10-14", rows: sonnetTies },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({ ref: OPUS, holds: "incumbent", streak: { won: 2, needed: 3 } });
    });

    it("a break in the middle (clear, miss, clear) counts 1, not 2", () => {
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetClears },
        { date: "2026-10-16", rows: sonnetTies },
        { date: "2026-10-14", rows: sonnetClears },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({ holds: "incumbent", streak: { won: 1 } });
    });

    it("a different challenger tops each publish: the newest's challenger is fixed, so its streak is 1", () => {
      const pool = [OPUS, SONNET, OPUS5];
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: [agent(OPUS, 0.2), agent(SONNET, 0.32), agent(OPUS5, 0.1)] },
        { date: "2026-10-16", rows: [agent(OPUS, 0.2), agent(SONNET, 0.1), agent(OPUS5, 0.32)] },
        { date: "2026-10-14", rows: [agent(OPUS, 0.2), agent(SONNET, 0.1), agent(OPUS5, 0.32)] },
      ]);
      expect(decideLeaderPick(leaderInput({ pool, rankings: file }))).toMatchObject({
        ref: OPUS,
        holds: "incumbent",
        challenger: { ref: SONNET },
        streak: { won: 1 },
      });
    });

    it("fewer publishes recorded than the streak needs: the challenger cannot win yet", () => {
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetClears },
        { date: "2026-10-16", rows: sonnetClears },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({ holds: "incumbent", streak: { won: 2, needed: 3 } });
    });

    it("a file with no history ranks from today's board and counts no streak", () => {
      const file = rankings({ "agent/overall": sonnetClears });
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({
        holds: "incumbent",
        publishDate: "2026-10-08",
        streak: { won: 0 },
      });
    });

    it("calibration: Fable 5.1 led Opus 5.5 (High) 09-27 to 10-02 with overlapping CIs, and the incumbent holds", () => {
      const FABLE = "claude-fable-5-1";
      const publish = (date: string, opus: [number, number, number], fable: [number, number, number]) => ({
        date,
        rows: [
          { arenaName: "claude-opus-5.5-high", ours: OPUS, effort: "high", rating: opus[0], ratingLower: opus[1], ratingUpper: opus[2], votes: 1000 },
          { arenaName: "claude-fable-5.1-max", ours: FABLE, effort: "max", rating: fable[0], ratingLower: fable[1], ratingUpper: fable[2], votes: 1000 },
        ],
      });
      const file = withHistory("agent/overall", [
        publish("2026-10-02", [0.1382, 0.1165, 0.1599], [0.1431, 0.1274, 0.1588]),
        publish("2026-09-30", [0.1378, 0.1154, 0.1603], [0.1455, 0.1286, 0.1625]),
        publish("2026-09-28", [0.1184, 0.0989, 0.138], [0.1406, 0.1222, 0.159]),
      ]);
      expect(decideLeaderPick(leaderInput({ pool: [OPUS, FABLE], rankings: file }))).toMatchObject({
        ref: OPUS,
        holds: "incumbent",
        streak: { won: 0 },
      });
    });
  });

  describe("the challenger wins", () => {
    it("three consecutive clears: the pick is the challenger (AE4)", () => {
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetClears },
        { date: "2026-10-16", rows: sonnetClears },
        { date: "2026-10-14", rows: sonnetClears },
        { date: "2026-10-12", rows: sonnetTies },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({
        outcome: "ranked",
        ref: SONNET,
        holds: "challenger",
        streak: { won: 3, needed: 3 },
        challenger: { ref: SONNET },
        incumbent: { ref: OPUS },
      });
    });

    it("a proxy challenger against an exact-effort incumbent needs one more width", () => {
      // Opus at xhigh (exact), Sonnet only at max (proxy). Sonnet lower 0.29, width 0.04:
      // one width leaves 0.25 (clears Opus's 0.22), two widths leave 0.21 (does not).
      const rows = [agent(OPUS, 0.2, "xhigh"), agent(SONNET, 0.31, "max")];
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows },
        { date: "2026-10-16", rows },
        { date: "2026-10-14", rows },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({ holds: "incumbent", streak: { won: 0 } });
      expect(decideLeaderPick(leaderInput({ rankings: file, leader: leaderPolicy({ marginCi: 0 }) }))).toMatchObject({
        holds: "challenger",
        challenger: { proxy: true },
        incumbent: { proxy: false },
      });
    });

    it("both rows proxies: no extra width", () => {
      const file = withHistory("agent/overall", [
        { date: "2026-10-19", rows: sonnetClears },
        { date: "2026-10-16", rows: sonnetClears },
        { date: "2026-10-14", rows: sonnetClears },
      ]);
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({ holds: "challenger", incumbent: { proxy: true }, challenger: { proxy: true } });
    });

    it("streakPublishes 1 picks on a single clear", () => {
      const file = withHistory("agent/overall", [{ date: "2026-10-19", rows: sonnetClears }]);
      expect(decideLeaderPick(leaderInput({ rankings: file, leader: leaderPolicy({ streakPublishes: 1 }) }))).toMatchObject({
        ref: SONNET,
        holds: "challenger",
        streak: { won: 1, needed: 1 },
      });
    });
  });

  describe("boards", () => {
    it("falls through to hard_prompts when agent/overall does not rank the incumbent", () => {
      const text = (ours: string, rating: number): ArenaRankingRow => ({
        arenaName: ours,
        ours,
        effort: "high",
        rating,
        ratingLower: rating - 9,
        ratingUpper: rating + 9,
        votes: 5000,
      });
      const file = rankings(
        { "agent/overall": [agent(SONNET, 0.3)], "text_style_control/hard_prompts": [text(OPUS, 1533), text(SONNET, 1504)] },
        {
          leaderHistory: {
            "agent/overall": [{ publishDate: "2026-10-19", rows: [agent(SONNET, 0.3)] }],
            "text_style_control/hard_prompts": [{ publishDate: "2026-10-15", rows: [text(OPUS, 1533), text(SONNET, 1504)] }],
          },
        },
      );
      expect(decideLeaderPick(leaderInput({ rankings: file }))).toMatchObject({
        ref: OPUS,
        holds: "incumbent",
        board: "text_style_control/hard_prompts",
        publishDate: "2026-10-15",
      });
    });

    it("walks only the configured boards", () => {
      const file = withHistory("agent/overall", [{ date: "2026-10-19", rows: sonnetTies }]);
      expect(decideLeaderPick(leaderInput({ rankings: file, leader: leaderPolicy({ boards: ["text_style_control/hard_prompts"] }) }))).toEqual({
        outcome: "fallback",
        reason: "no-ranked-board",
      });
    });
  });
});
