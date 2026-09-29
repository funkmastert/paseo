import { describe, expect, test } from "vitest";

import {
  evaluateMemoryBrake,
  MEMORY_BRAKE_RELEASE_SWEEPS,
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

/** Runs the brake over a series of sweeps, the way the monitor keeps its state between them. */
function run(samples: ReadonlyArray<SystemMemorySample | undefined>) {
  let state: MemoryBrakeState | undefined;
  const held: boolean[] = [];
  const transitions: string[] = [];
  const critical: boolean[] = [];
  for (const sample of samples) {
    const result = evaluateMemoryBrake(sample, state);
    state = result.next;
    held.push(result.next.held);
    transitions.push(result.transition);
    critical.push(result.critical);
  }
  return { held, transitions, critical, state };
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
