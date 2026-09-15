import { describe, expect, test } from "vitest";
import {
  createInitialSustainedBreachState,
  evaluateSustainedBreach,
  type SustainedBreachState,
} from "./sustained-breach-detector.js";

const THRESHOLD = 100;
const SUSTAINED_SWEEPS = 3;

function sweep(
  state: SustainedBreachState | undefined,
  value: number | undefined,
): ReturnType<typeof evaluateSustainedBreach> {
  return evaluateSustainedBreach({
    value,
    threshold: THRESHOLD,
    sustainedSweeps: SUSTAINED_SWEEPS,
    previousState: state,
  });
}

describe("evaluateSustainedBreach", () => {
  test("below threshold never triggers", () => {
    let state: SustainedBreachState | undefined;
    for (let i = 0; i < 10; i += 1) {
      const result = sweep(state, 10);
      expect(result.triggered).toBe(false);
      state = result.nextState;
    }
  });

  test("requires sustainedSweeps consecutive sweeps at or above threshold", () => {
    let state: SustainedBreachState | undefined;
    let result = sweep(state, 200);
    expect(result.triggered).toBe(false);
    state = result.nextState;

    result = sweep(state, 200);
    expect(result.triggered).toBe(false);
    state = result.nextState;

    result = sweep(state, 200);
    expect(result.triggered).toBe(true);
  });

  test("a dip before the requirement is met resets the streak", () => {
    let state: SustainedBreachState | undefined;
    const sequence = [200, 200, 10, 200, 200];
    let lastResult: ReturnType<typeof evaluateSustainedBreach> | undefined;
    for (const value of sequence) {
      lastResult = sweep(state, value);
      state = lastResult.nextState;
    }
    expect(lastResult?.triggered).toBe(false);
    expect(state?.consecutiveAboveThreshold).toBe(2);
  });

  test("undefined value is treated as no data, never triggers, and doesn't crash", () => {
    let state: SustainedBreachState | undefined;
    for (let i = 0; i < 5; i += 1) {
      const result = sweep(state, undefined);
      expect(result.triggered).toBe(false);
      state = result.nextState;
    }
    expect(state?.consecutiveAboveThreshold).toBe(0);
  });

  test("fires once, then re-arms only after a below-threshold run of the same length", () => {
    let state: SustainedBreachState | undefined = createInitialSustainedBreachState();
    for (let i = 0; i < SUSTAINED_SWEEPS; i += 1) {
      state = sweep(state, 200).nextState;
    }
    expect(state.fired).toBe(true);

    let result = sweep(state, 200);
    expect(result.triggered).toBe(false);
    state = result.nextState;

    result = sweep(state, 10);
    expect(result.triggered).toBe(false);
    expect(result.nextState.fired).toBe(true);
    state = result.nextState;

    for (let i = 1; i < SUSTAINED_SWEEPS; i += 1) {
      state = sweep(state, 10).nextState;
    }
    expect(state.fired).toBe(false);

    for (let i = 0; i < SUSTAINED_SWEEPS - 1; i += 1) {
      state = sweep(state, 200).nextState;
    }
    result = sweep(state, 200);
    expect(result.triggered).toBe(true);
  });

  test("no signal re-arms a fired leg the same as a below-threshold reading", () => {
    let state: SustainedBreachState | undefined = createInitialSustainedBreachState();
    for (let i = 0; i < SUSTAINED_SWEEPS; i += 1) {
      state = sweep(state, 200).nextState;
    }
    expect(state.fired).toBe(true);

    for (let i = 0; i < SUSTAINED_SWEEPS; i += 1) {
      state = sweep(state, undefined).nextState;
    }
    expect(state.fired).toBe(false);
  });
});
