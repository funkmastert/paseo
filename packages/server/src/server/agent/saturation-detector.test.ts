import { describe, expect, test } from "vitest";
import {
  evaluateSaturation,
  type SaturationConfig,
  type SaturationEvaluation,
  type SaturationState,
} from "./saturation-detector.js";
import type { SystemLoadReading } from "./system-load.js";

const CONFIG: SaturationConfig = {
  enabled: true,
  loadPerCore: 2,
  busyFraction: 0.9,
  sustainedMinutes: 3,
};

function loadavg(load1: number, cores = 16): SystemLoadReading {
  return { kind: "loadavg", cores, load1, load5: load1, load15: load1 };
}

function run(readings: Array<SystemLoadReading | undefined>): SaturationEvaluation[] {
  let state: SaturationState | undefined;
  return readings.map((load, index) => {
    const result = evaluateSaturation({
      load,
      config: CONFIG,
      previousState: state,
      nowMs: index * 60_000,
    });
    state = result.nextState;
    return result;
  });
}

describe("evaluateSaturation", () => {
  test("opens after sustainedMinutes sweeps at 2x cores and records the peak", () => {
    const results = run([loadavg(33), loadavg(40), loadavg(32), loadavg(38)]);

    expect(results.map((result) => result.transition)).toEqual([
      "quiet",
      "quiet",
      "opened",
      "held",
    ]);
    expect(results[2]?.episode).toEqual({ openedAtMs: 120_000, peakLoad1: 32, peakAtMs: 120_000 });
    expect(results[3]?.episode?.peakLoad1).toBe(38);
  });

  test("a load under 2x cores is not saturation, however long it lasts", () => {
    const results = run([loadavg(31), loadavg(31), loadavg(31), loadavg(31)]);

    expect(results.every((result) => result.transition === "quiet")).toBe(true);
  });

  test("clears only after the same number of sweeps back under, and reports what closed", () => {
    const results = run([
      loadavg(40),
      loadavg(40),
      loadavg(40),
      loadavg(10),
      loadavg(40),
      loadavg(10),
      loadavg(10),
      loadavg(10),
    ]);

    expect(results.map((result) => result.transition)).toEqual([
      "quiet",
      "quiet",
      "opened",
      "held",
      "held",
      "held",
      "held",
      "cleared",
    ]);
    expect(results[7]?.episode).toMatchObject({ openedAtMs: 120_000, peakLoad1: 40 });
    expect(results[7]?.nextState.episode).toBeUndefined();
  });

  test("a sweep with no reading holds an open episode instead of counting toward clearing it", () => {
    const results = run([loadavg(40), loadavg(40), loadavg(40), undefined, undefined, undefined]);

    expect(results.slice(3).map((result) => result.transition)).toEqual(["held", "held", "held"]);
  });

  test("on Windows, compares the busy share against busyFraction", () => {
    const busy = (busyFraction: number): SystemLoadReading => ({
      kind: "cpu-busy",
      cores: 16,
      busyFraction,
      load1: busyFraction * 16,
    });

    expect(run([busy(0.95), busy(0.95), busy(0.95)])[2]?.transition).toBe("opened");
    expect(run([busy(0.85), busy(0.85), busy(0.85)])[2]?.transition).toBe("quiet");
  });
});
