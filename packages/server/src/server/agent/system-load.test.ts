import type os from "node:os";
import { describe, expect, test } from "vitest";
import { createSystemLoadSampler, type LoadOps } from "./system-load.js";

const GIBIBYTE = 1024 ** 3;

function cpu(times: { user: number; sys: number; idle: number }): os.CpuInfo {
  return { model: "x", speed: 3000, times: { ...times, nice: 0, irq: 0 } };
}

function createOps(
  overrides: Partial<LoadOps> = {},
): LoadOps & { setCpus(next: os.CpuInfo[]): void } {
  let cpus = [cpu({ user: 0, sys: 0, idle: 0 }), cpu({ user: 0, sys: 0, idle: 0 })];
  return {
    loadavg: () => [34.5, 20.25, 9.75],
    cpus: () => cpus,
    freemem: () => 2 * GIBIBYTE,
    totalmem: () => 64 * GIBIBYTE,
    setCpus(next) {
      cpus = next;
    },
    ...overrides,
  };
}

describe("createSystemLoadSampler", () => {
  test("reads the load average on macOS and Linux, with free memory beside it", () => {
    const sampler = createSystemLoadSampler({ platform: "darwin", ops: createOps() });

    expect(sampler.sample()).toEqual({
      load: { kind: "loadavg", cores: 2, load1: 34.5, load5: 20.25, load15: 9.75 },
      freeMemoryBytes: 2 * GIBIBYTE,
      totalMemoryBytes: 64 * GIBIBYTE,
    });
  });

  test("on Windows, derives busy fraction from CPU time between samples", () => {
    const ops = createOps({ loadavg: () => [0, 0, 0] });
    const sampler = createSystemLoadSampler({ platform: "win32", ops });

    // The first sample has nothing to diff against: no reading, never a zero.
    expect(sampler.sample().load).toBeUndefined();

    // Core 0: 900 busy of 1000. Core 1: 700 busy of 1000. 1600 of 2000 is 80% busy.
    ops.setCpus([cpu({ user: 800, sys: 100, idle: 100 }), cpu({ user: 600, sys: 100, idle: 300 })]);
    expect(sampler.sample().load).toEqual({
      kind: "cpu-busy",
      cores: 2,
      busyFraction: 0.8,
      load1: 1.6,
    });
  });

  test("on Windows, a counter that did not move gives no reading rather than dividing by zero", () => {
    const ops = createOps({ loadavg: () => [0, 0, 0] });
    const sampler = createSystemLoadSampler({ platform: "win32", ops });
    sampler.sample();

    expect(sampler.sample().load).toBeUndefined();
  });

  test("reports no load when os reports no CPUs, as some containers do", () => {
    const sampler = createSystemLoadSampler({
      platform: "linux",
      ops: createOps({ cpus: () => [] }),
    });

    expect(sampler.sample().load).toBeUndefined();
  });
});
