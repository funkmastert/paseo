import { describe, expect, test } from "vitest";
import {
  createInitialTokenBurnMonitorState,
  evaluateTokenBurn,
  type TokenBurnMonitorConfig,
  type TokenBurnMonitorState,
} from "./token-burn-detector.js";

const CONFIG: TokenBurnMonitorConfig = {
  ratePerMinute: 50_000,
  sustainedMinutes: 3,
  totalTokens: 5_000_000,
};

function sweepRate(
  state: TokenBurnMonitorState | undefined,
  rate: number | undefined,
): ReturnType<typeof evaluateTokenBurn> {
  return evaluateTokenBurn({
    tokenRate: rate,
    totalTokens: undefined,
    config: CONFIG,
    previousState: state,
  });
}

describe("evaluateTokenBurn — rate leg", () => {
  test("below threshold never triggers", () => {
    let state: TokenBurnMonitorState | undefined;
    for (let i = 0; i < 10; i += 1) {
      const result = sweepRate(state, 10_000);
      expect(result.trigger).toBeNull();
      state = result.nextState;
    }
  });

  test("requires sustainedMinutes consecutive sweeps at or above threshold", () => {
    let state: TokenBurnMonitorState | undefined;
    let result = sweepRate(state, 60_000);
    expect(result.trigger).toBeNull();
    state = result.nextState;

    result = sweepRate(state, 60_000);
    expect(result.trigger).toBeNull();
    state = result.nextState;

    result = sweepRate(state, 60_000);
    expect(result.trigger).toBe("rate");
  });

  test("a dip before the requirement is met resets the streak (spike-class immunity)", () => {
    // A one-off spike reads high, then the very next sweep already sees a lower rate — never
    // reaches sustainedMinutes consecutive breaching sweeps.
    let state: TokenBurnMonitorState | undefined;
    const sequence = [60_000, 60_000, 10_000, 60_000, 60_000];
    let lastResult: ReturnType<typeof evaluateTokenBurn> | undefined;
    for (const rate of sequence) {
      lastResult = sweepRate(state, rate);
      state = lastResult.nextState;
    }
    expect(lastResult?.trigger).toBeNull();
    // Only 2 consecutive at the end (indices 3,4), one short of sustainedMinutes=3.
    expect(state?.consecutiveAboveRate).toBe(2);
  });

  test("undefined rate is treated as no data, never breaches, and doesn't crash", () => {
    let state: TokenBurnMonitorState | undefined;
    for (let i = 0; i < 5; i += 1) {
      const result = sweepRate(state, undefined);
      expect(result.trigger).toBeNull();
      state = result.nextState;
    }
    expect(state?.consecutiveAboveRate).toBe(0);
  });

  test("fires once, then re-arms only after a below-threshold run of the same length", () => {
    let state: TokenBurnMonitorState | undefined;
    // Reach the first fire.
    for (let i = 0; i < CONFIG.sustainedMinutes; i += 1) {
      state = sweepRate(state, 60_000).nextState;
    }
    expect(state?.rateFired).toBe(true);

    // Still above threshold: does not fire again (already fired, not yet re-armed).
    let result = sweepRate(state, 60_000);
    expect(result.trigger).toBeNull();
    state = result.nextState;

    // One below-threshold sweep isn't enough to re-arm.
    result = sweepRate(state, 10_000);
    expect(result.trigger).toBeNull();
    expect(result.nextState.rateFired).toBe(true);
    state = result.nextState;

    // A full sustainedMinutes-length below-threshold run re-arms it.
    for (let i = 1; i < CONFIG.sustainedMinutes; i += 1) {
      state = sweepRate(state, 10_000).nextState;
    }
    expect(state?.rateFired).toBe(false);

    // Now a fresh sustained run above threshold fires again.
    for (let i = 0; i < CONFIG.sustainedMinutes - 1; i += 1) {
      state = sweepRate(state, 60_000).nextState;
    }
    result = sweepRate(state, 60_000);
    expect(result.trigger).toBe("rate");
  });
});

describe("evaluateTokenBurn — total leg", () => {
  test("fires when cumulative total crosses the configured threshold", () => {
    const result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: 5_000_001,
      config: CONFIG,
      previousState: undefined,
    });
    expect(result.trigger).toBe("total");
    expect(result.nextState.nextTotalThreshold).toBe(10_000_000);
  });

  test("does not fire below the threshold", () => {
    const result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: 4_999_999,
      config: CONFIG,
      previousState: undefined,
    });
    expect(result.trigger).toBeNull();
  });

  test("ratchets to the next multiple and only re-fires past it", () => {
    let result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: 5_000_000,
      config: CONFIG,
      previousState: undefined,
    });
    expect(result.trigger).toBe("total");
    let state = result.nextState;

    // Same multiple again: no re-fire until the next one.
    result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: 5_500_000,
      config: CONFIG,
      previousState: state,
    });
    expect(result.trigger).toBeNull();
    state = result.nextState;

    result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: 10_000_000,
      config: CONFIG,
      previousState: state,
    });
    expect(result.trigger).toBe("total");
    expect(result.nextState.nextTotalThreshold).toBe(15_000_000);
  });

  test("a single large jump across several multiples only fires once and advances past all of them", () => {
    const result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: 23_000_000,
      config: CONFIG,
      previousState: undefined,
    });
    expect(result.trigger).toBe("total");
    expect(result.nextState.nextTotalThreshold).toBe(25_000_000);
  });

  test("undefined totalTokens never breaches the total leg", () => {
    const result = evaluateTokenBurn({
      tokenRate: undefined,
      totalTokens: undefined,
      config: CONFIG,
      previousState: undefined,
    });
    expect(result.trigger).toBeNull();
  });
});

describe("evaluateTokenBurn — both legs together", () => {
  test("rate takes priority when both legs cross in the same sweep; total reports on the next sweep", () => {
    let state = createInitialTokenBurnMonitorState(CONFIG);
    for (let i = 0; i < CONFIG.sustainedMinutes - 1; i += 1) {
      state = evaluateTokenBurn({
        tokenRate: 60_000,
        totalTokens: 1,
        config: CONFIG,
        previousState: state,
      }).nextState;
    }
    const result = evaluateTokenBurn({
      tokenRate: 60_000,
      totalTokens: 5_000_001,
      config: CONFIG,
      previousState: state,
    });
    expect(result.trigger).toBe("rate");
    // Total's ratchet wasn't advanced — it still owes a report, delivered on a later sweep.
    expect(result.nextState.nextTotalThreshold).toBe(5_000_000);

    const next = evaluateTokenBurn({
      tokenRate: 10_000,
      totalTokens: 5_000_001,
      config: CONFIG,
      previousState: result.nextState,
    });
    expect(next.trigger).toBe("total");
  });
});
