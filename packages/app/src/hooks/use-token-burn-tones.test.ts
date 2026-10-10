// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTokenBurnTones } from "./use-token-burn-tones";
import { TOKEN_BURN_STALENESS_MS, type TokenBurnSibling } from "@/utils/token-burn-tone-model";

const START_MS = 1_800_000_000_000;

function burningFleet(asOfMs: number): TokenBurnSibling[] {
  return [
    { id: "hot", recentTokenRate: { tokensPerMinute: 90_000, asOfMs } },
    { id: "calm-a", recentTokenRate: { tokensPerMinute: 9_000, asOfMs } },
    { id: "calm-b", recentTokenRate: { tokensPerMinute: 9_000, asOfMs } },
  ];
}

describe("useTokenBurnTones", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires a tone once the rate ages past the staleness window, with no new rows", () => {
    // The rows never change: this is a fleet that went quiet, so no agent update ever arrives.
    const siblings = burningFleet(START_MS);
    const { result } = renderHook(() => useTokenBurnTones(siblings));

    expect(result.current.get("hot")).toBe("danger");

    act(() => {
      vi.advanceTimersByTime(TOKEN_BURN_STALENESS_MS + 60_000);
    });

    expect(result.current.size).toBe(0);
  });

  it("keeps the map identity across a tick that expires nothing", () => {
    const siblings = burningFleet(START_MS);
    const { result } = renderHook(() => useTokenBurnTones(siblings));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(120_000);
    });

    expect(result.current).toBe(first);
  });

  it("runs no timer when there is no tone that could expire", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const setTimeout = vi.spyOn(globalThis, "setTimeout");
    const siblings: TokenBurnSibling[] = [
      { id: "a", recentTokenRate: { tokensPerMinute: 9_000, asOfMs: START_MS } },
      { id: "b", recentTokenRate: { tokensPerMinute: 9_000, asOfMs: START_MS } },
      { id: "c", recentTokenRate: { tokensPerMinute: 9_000, asOfMs: START_MS } },
    ];

    const { result } = renderHook(() => useTokenBurnTones(siblings));

    expect(result.current.size).toBe(0);
    expect(setInterval).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
