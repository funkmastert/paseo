import { describe, expect, it } from "vitest";
import type { AgentTokenRate } from "@getpaseo/protocol/agent-types";
import {
  deriveTokenBurnTones,
  resolveTokenRate,
  TOKEN_BURN_STALENESS_MS,
  type TokenBurnSibling,
  type TokenBurnTone,
} from "./token-burn-tone-model";

const NOW_MS = 1_700_000_000_000;

function rate(tokensPerMinute: number, asOfMs: number = NOW_MS): AgentTokenRate {
  return { tokensPerMinute, asOfMs };
}

const EMPTY_PREVIOUS: ReadonlyMap<string, TokenBurnTone> = new Map();

describe("resolveTokenRate", () => {
  it("is undefined when there's no rate at all", () => {
    expect(resolveTokenRate(undefined, NOW_MS)).toBeUndefined();
  });

  it("returns the tokens/min figure when the rate is current", () => {
    expect(resolveTokenRate(rate(2_000, NOW_MS - 1_000), NOW_MS)).toBe(2_000);
  });

  it("is undefined once the rate is older than the staleness window", () => {
    const stale = rate(2_000, NOW_MS - TOKEN_BURN_STALENESS_MS - 1);
    expect(resolveTokenRate(stale, NOW_MS)).toBeUndefined();
  });

  it("is still defined right at the staleness boundary", () => {
    const boundary = rate(2_000, NOW_MS - TOKEN_BURN_STALENESS_MS);
    expect(resolveTokenRate(boundary, NOW_MS)).toBe(2_000);
  });
});

describe("deriveTokenBurnTones", () => {
  it("gives a lone agent no tone regardless of its rate", () => {
    const siblings: TokenBurnSibling[] = [{ id: "a", recentTokenRate: rate(50_000) }];
    expect(deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS).size).toBe(0);
  });

  it("gives an all-idle group no tones", () => {
    const siblings: TokenBurnSibling[] = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS).size).toBe(0);
  });

  it("flags an agent burning at ~3x the median of >=3 above-floor siblings as danger", () => {
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "d", recentTokenRate: rate(6_001) },
    ];
    const tones = deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS);
    expect(tones.get("d")).toBe("danger");
    expect(tones.has("a")).toBe(false);
  });

  it("never tones a group whose rates all sit below the absolute floor, even at the same ratio", () => {
    // Same ~3x ratio as the danger case above, but every value is below the 1,500 tok/min floor.
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(100) },
      { id: "b", recentTokenRate: rate(100) },
      { id: "c", recentTokenRate: rate(100) },
      { id: "d", recentTokenRate: rate(305) },
    ];
    expect(deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS).size).toBe(0);
  });

  it("excludes a stale sibling's rate from the pool without it skewing the median", () => {
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      // Would drag the median down (and thus make "d" look even more extreme) if it counted.
      { id: "stale", recentTokenRate: rate(1, NOW_MS - TOKEN_BURN_STALENESS_MS - 1) },
      { id: "d", recentTokenRate: rate(6_001) },
    ];
    const tones = deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS);
    expect(tones.has("stale")).toBe(false);
    expect(tones.get("d")).toBe("danger");
  });

  it("excludes a sibling with no recentTokenRate at all, without it skewing the median", () => {
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "missing" },
      { id: "d", recentTokenRate: rate(6_001) },
    ];
    const tones = deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS);
    expect(tones.has("missing")).toBe(false);
    expect(tones.get("d")).toBe("danger");
  });

  it("holds an agent in danger while its ratio has dropped but not below the exit threshold", () => {
    // median 2,000; "d" at 2.5x — below the 3.0x enter bar but above the 2.25x exit bar.
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "d", recentTokenRate: rate(5_000) },
    ];
    const previous: ReadonlyMap<string, TokenBurnTone> = new Map([["d", "danger"]]);
    expect(deriveTokenBurnTones(siblings, previous, NOW_MS).get("d")).toBe("danger");
  });

  it("drops a formerly-danger agent to warning once its ratio falls under the danger exit threshold", () => {
    // median 2,000; "d" at 2.0x — below the 2.25x danger exit bar but above the 1.75x warning enter bar.
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "d", recentTokenRate: rate(4_000) },
    ];
    const previous: ReadonlyMap<string, TokenBurnTone> = new Map([["d", "danger"]]);
    expect(deriveTokenBurnTones(siblings, previous, NOW_MS).get("d")).toBe("warning");
  });

  it("holds an agent in warning while its ratio has dropped but not below the warning exit threshold", () => {
    // median 2,000; "d" at 1.5x — below the 1.75x warning enter bar but above the 1.4x exit bar.
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "d", recentTokenRate: rate(3_000) },
    ];
    const previous: ReadonlyMap<string, TokenBurnTone> = new Map([["d", "warning"]]);
    expect(deriveTokenBurnTones(siblings, previous, NOW_MS).get("d")).toBe("warning");
  });

  it("drops a formerly-warning agent out of the map once its ratio falls under the warning exit threshold", () => {
    // median 2,000; "d" at 1.2x — below the 1.4x warning exit bar.
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "d", recentTokenRate: rate(2_400) },
    ];
    const previous: ReadonlyMap<string, TokenBurnTone> = new Map([["d", "warning"]]);
    expect(deriveTokenBurnTones(siblings, previous, NOW_MS).has("d")).toBe(false);
  });

  it('only ever produces "warning" or "danger" entries — badges never render for anything else', () => {
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: rate(2_000) },
      { id: "b", recentTokenRate: rate(2_000) },
      { id: "c", recentTokenRate: rate(2_000) },
      { id: "d", recentTokenRate: rate(6_001) },
      { id: "e", recentTokenRate: rate(3_600) },
      { id: "f", recentTokenRate: rate(2_100) },
    ];
    const tones = deriveTokenBurnTones(siblings, EMPTY_PREVIOUS, NOW_MS);
    for (const tone of tones.values()) {
      expect(["warning", "danger"]).toContain(tone);
    }
    // "f" is close enough to the median to earn no badge at all — absent, not a third "default" tone.
    expect(tones.has("f")).toBe(false);
  });
});
