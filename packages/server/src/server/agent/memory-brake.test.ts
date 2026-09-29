import { describe, expect, test } from "vitest";

import {
  evaluateMemoryBrake,
  MEMORY_BRAKE_RELEASE_SWEEPS,
  MEMORY_HOLD_TRICKLE_AFTER_MS,
  type MemoryBrakeState,
} from "./memory-brake.js";
import type { SystemMemorySample } from "./process-sampler.js";

const GIBIBYTE = 1024 ** 3;
const MIBIBYTE = 1024 ** 2;

function memory(
  memoryPressureLevel: number | undefined,
  swapUsedGiB: number,
  swapTotalGiB = 44,
): SystemMemorySample {
  return {
    totalPhysicalBytes: 64 * GIBIBYTE,
    swapTotalBytes: swapTotalGiB * GIBIBYTE,
    swapUsedBytes: swapUsedGiB * GIBIBYTE,
    ...(memoryPressureLevel !== undefined ? { memoryPressureLevel } : {}),
  };
}

const SWEEP_MS = 60_000;

/**
 * Runs the brake over a series of sweeps a minute apart, the way the monitor keeps its state
 * between them.
 */
function run(samples: ReadonlyArray<SystemMemorySample | undefined>) {
  let state: MemoryBrakeState | undefined;
  const held: boolean[] = [];
  const transitions: string[] = [];
  const critical: boolean[] = [];
  const heldForMinutes: number[] = [];
  const trickle: boolean[] = [];
  let nowMs = 1_000_000;
  for (const sample of samples) {
    const result = evaluateMemoryBrake(sample, state, nowMs);
    state = result.next;
    held.push(result.next.held);
    transitions.push(result.transition);
    critical.push(result.critical);
    heldForMinutes.push(result.heldForMs / 60_000);
    trickle.push(result.trickle);
    nowMs += SWEEP_MS;
  }
  return { held, transitions, critical, heldForMinutes, trickle, state };
}

const TRICKLE_SWEEPS = MEMORY_HOLD_TRICKLE_AFTER_MS / SWEEP_MS;

function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => value);
}

describe("evaluateMemoryBrake", () => {
  test("pressure 2 (warn) holds on the sweep it is seen", () => {
    const { held, transitions } = run([memory(1, 0), memory(2, 0)]);
    expect(held).toEqual([false, true]);
    expect(transitions).toEqual(["none", "held"]);
  });

  test("pressure 4 (critical) holds and says it is critical", () => {
    const { held, critical } = run([memory(4, 0)]);
    expect(held).toEqual([true]);
    expect(critical).toEqual([true]);
  });

  test(`releases only after ${MEMORY_BRAKE_RELEASE_SWEEPS} sweeps in a row at pressure 1 with swap steady`, () => {
    const calm = Array.from({ length: MEMORY_BRAKE_RELEASE_SWEEPS }, () => memory(1, 20));
    const { held, transitions } = run([memory(2, 20), ...calm]);
    expect(held).toEqual([true, true, true, true, true, false]);
    expect(transitions.at(-1)).toBe("released");
  });

  test("one sweep back at pressure 2 starts the calm run over", () => {
    const { held } = run([
      memory(2, 20),
      memory(1, 20),
      memory(1, 20),
      memory(1, 20),
      memory(2, 20),
      ...Array.from({ length: MEMORY_BRAKE_RELEASE_SWEEPS - 1 }, () => memory(1, 20)),
    ]);
    expect(held.every(Boolean)).toBe(true);
  });

  test("swap growing 1 GiB in one sweep holds, even at pressure 1", () => {
    const { held, transitions } = run([memory(1, 10), memory(1, 11)]);
    expect(held).toEqual([false, true]);
    expect(transitions).toEqual(["none", "held"]);
  });

  test("high swap that is not growing never holds: macOS swap is sticky", () => {
    // 09-28 05:23Z: 42.7 GB of 44 GB still in swap an hour after the storm, and not growing.
    const { held } = run(Array.from({ length: 10 }, () => memory(1, 42.7)));
    expect(held.some(Boolean)).toBe(false);
  });

  test("swap creeping up below the steady line still counts as calm", () => {
    const creeping = Array.from({ length: MEMORY_BRAKE_RELEASE_SWEEPS }, (_, index) => ({
      ...memory(1, 20),
      swapUsedBytes: 20 * GIBIBYTE + (index + 1) * 64 * MIBIBYTE,
    }));
    const { held } = run([memory(2, 20), ...creeping]);
    expect(held.at(-1)).toBe(false);
  });

  test("swap growing between the steady line and the hold line neither holds nor releases", () => {
    const growing = Array.from({ length: MEMORY_BRAKE_RELEASE_SWEEPS + 2 }, (_, index) => ({
      ...memory(1, 20),
      swapUsedBytes: 20 * GIBIBYTE + (index + 1) * 512 * MIBIBYTE,
    }));
    expect(run([memory(1, 20), ...growing]).held.some(Boolean)).toBe(false);
    expect(run([memory(2, 20), ...growing]).held.every(Boolean)).toBe(true);
  });

  test("no pressure reading (Linux, Windows, a failed sysctl) never holds", () => {
    const { held } = run([memory(undefined, 1), memory(undefined, 30), undefined]);
    expect(held.some(Boolean)).toBe(false);
  });

  test("a sweep with no reading keeps a hold and breaks the calm run", () => {
    const { held } = run([
      memory(2, 20),
      memory(1, 20),
      memory(1, 20),
      undefined,
      ...Array.from({ length: MEMORY_BRAKE_RELEASE_SWEEPS - 1 }, () => memory(1, 20)),
    ]);
    expect(held.every(Boolean)).toBe(true);
  });
});

describe("a long hold", () => {
  test("says how long it has held, from the sweep it started", () => {
    const { heldForMinutes } = run([memory(1, 0), memory(2, 0), memory(2, 0), memory(2, 0)]);
    expect(heldForMinutes).toEqual([0, 0, 1, 2]);
  });

  test(`at warn with swap not growing, trickles once it has held ${TRICKLE_SWEEPS} minutes`, () => {
    const { trickle, held } = run(repeat(memory(2, 5), TRICKLE_SWEEPS + 3));
    expect(held.every(Boolean)).toBe(true);
    expect(trickle.slice(0, TRICKLE_SWEEPS)).toEqual(repeat(false, TRICKLE_SWEEPS));
    expect(trickle.slice(TRICKLE_SWEEPS)).toEqual([true, true, true]);
  });

  test("swap growing a gibibyte, or pressure turning critical, starts the wait over", () => {
    for (const bad of [memory(2, 7), memory(4, 5)]) {
      const { trickle } = run([
        ...repeat(memory(2, 5), TRICKLE_SWEEPS + 1),
        bad,
        ...repeat({ ...bad, memoryPressureLevel: 2 }, TRICKLE_SWEEPS),
      ]);
      expect(trickle[TRICKLE_SWEEPS]).toBe(true);
      // The bad sweep and the half hour after it are a full hold again.
      expect(trickle.slice(TRICKLE_SWEEPS + 1, 2 * TRICKLE_SWEEPS + 1).some(Boolean)).toBe(false);
      expect(trickle.at(-1)).toBe(true);
    }
  });

  test("a sweep with no reading never trickles and starts the wait over", () => {
    const { trickle } = run([
      ...repeat(memory(2, 5), TRICKLE_SWEEPS + 1),
      undefined,
      ...repeat(memory(2, 5), 2),
    ]);
    expect(trickle.slice(TRICKLE_SWEEPS)).toEqual([true, false, false, false]);
  });

  test("nothing trickles, and nothing has held, while the brake is off", () => {
    const { trickle, heldForMinutes } = run(repeat(memory(1, 5), TRICKLE_SWEEPS + 2));
    expect(trickle.some(Boolean)).toBe(false);
    expect(heldForMinutes.every((minutes) => minutes === 0)).toBe(true);
  });

  test("a release ends the hold's clock, and the next hold starts a new one", () => {
    const { heldForMinutes } = run([
      memory(2, 5),
      memory(2, 5),
      ...repeat(memory(1, 5), MEMORY_BRAKE_RELEASE_SWEEPS),
      memory(2, 5),
    ]);
    expect(heldForMinutes.at(-2)).toBe(0);
    expect(heldForMinutes.at(-1)).toBe(0);
  });
});
