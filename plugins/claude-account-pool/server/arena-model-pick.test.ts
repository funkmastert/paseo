import { describe, expect, it } from "vitest";
import type { ArenaRankingRow, ArenaRankingsFile } from "../shared/arena-aliases";
import type { ArenaPolicy } from "../shared/role-policy-schema";
import { ARENA_CREDIT, decideArenaPick, type ArenaPickInput } from "./arena-model-pick";

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
