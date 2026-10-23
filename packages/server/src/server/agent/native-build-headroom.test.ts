import { describe, expect, test } from "vitest";
import {
  BURST_READING_MAX_AGE_MS,
  BURST_SETTLE_MS,
  BURST_SWAP_GROWTH_BYTES,
  type BurstHeadroomInput,
  type BuildGateMachineReading,
  deriveBuildGateDefaults,
  describeDiskReserve,
  diskReserveBytes,
  evaluateBurstHeadroom,
  recordSwapUse,
  resolveBurstConfig,
} from "./native-build-headroom.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MINUTE = 60_000;
const NOW = 10_000_000;

describe("deriveBuildGateDefaults", () => {
  test.each([
    // cores, GiB, floor, ceiling
    [16, 64, 3, 5],
    [12, 36, 1, 2],
    [8, 16, 1, 1],
    [8, 32, 1, 2],
    [10, 48, 2, 3],
    [24, 128, 4, 7],
    [2, 4, 1, 1],
  ])(
    "%i cores and %i GiB give a floor of %i and a ceiling of %i",
    (cpuCount, gib, floor, ceiling) => {
      expect(deriveBuildGateDefaults({ cpuCount, memoryBytes: gib * GIB })).toEqual({
        maxConcurrent: floor,
        burstMaxConcurrent: ceiling,
      });
    },
  );

  test("a machine that reports nothing gets the smallest floor", () => {
    expect(deriveBuildGateDefaults({ cpuCount: 0, memoryBytes: 0 })).toEqual({
      maxConcurrent: 1,
      burstMaxConcurrent: 1,
    });
  });
});

describe("resolveBurstConfig", () => {
  const defaults = { maxConcurrent: 3, burstMaxConcurrent: 5 };

  test("fills every key from the hardware defaults", () => {
    expect(resolveBurstConfig(undefined, defaults, 3)).toEqual({
      enabled: true,
      maxConcurrent: 5,
      perBuildMemoryBytes: 8 * GIB,
      perBuildDiskBytes: 15 * GIB,
      maxLoadPerCore: 1.5,
      maxBusyFraction: 0.75,
    });
  });

  test("a configured floor above the ceiling raises the ceiling to the floor, which turns burst into nothing", () => {
    expect(resolveBurstConfig({ maxConcurrent: 2 }, defaults, 6).maxConcurrent).toBe(6);
  });

  test("a floor configured at the derived floor gets the derived ceiling, as the legacy { maxConcurrent: 3 } does", () => {
    expect(resolveBurstConfig(undefined, defaults, 3).maxConcurrent).toBe(5);
  });

  test("a floor configured under the derived one turns burst off, not up to the derived ceiling", () => {
    expect(resolveBurstConfig(undefined, defaults, 1).maxConcurrent).toBe(1);
    expect(resolveBurstConfig(undefined, defaults, 2).maxConcurrent).toBe(2);
  });

  test("a floor configured above the derived one gets at most the derived ceiling, or none", () => {
    expect(resolveBurstConfig(undefined, defaults, 4).maxConcurrent).toBe(5);
    expect(resolveBurstConfig(undefined, defaults, 8).maxConcurrent).toBe(8);
  });

  test("a ceiling that is configured is kept even when the floor is under the derived one", () => {
    expect(resolveBurstConfig({ maxConcurrent: 4 }, defaults, 1).maxConcurrent).toBe(4);
  });

  test("configured values win", () => {
    expect(
      resolveBurstConfig(
        {
          enabled: false,
          maxConcurrent: 4,
          perBuildMemoryGB: 6,
          perBuildDiskGB: 10,
          maxLoadPerCore: 0.8,
          maxBusyFraction: 0.5,
        },
        defaults,
        3,
      ),
    ).toEqual({
      enabled: false,
      maxConcurrent: 4,
      perBuildMemoryBytes: 6 * GIB,
      perBuildDiskBytes: 10 * GIB,
      maxLoadPerCore: 0.8,
      maxBusyFraction: 0.5,
    });
  });
});

function reading(overrides: Partial<BuildGateMachineReading> = {}): BuildGateMachineReading {
  return {
    takenAtMs: NOW - 30_000,
    systemMemory: {
      totalPhysicalBytes: 64 * GIB,
      swapTotalBytes: 20 * GIB,
      swapUsedBytes: 4 * GIB,
      availableBytes: 30 * GIB,
      memoryPressureLevel: 1,
    },
    systemLoad: {
      load: { kind: "loadavg", cores: 16, load1: 6, load5: 6, load15: 6 },
      freeMemoryBytes: 2 * GIB,
      totalMemoryBytes: 64 * GIB,
    },
    memoryBrakeHeld: false,
    diskBrakeHeld: false,
    cpuSaturated: false,
    ...overrides,
  };
}

/** Swap flat at `usedBytes` for a bit over six minutes, one reading a minute, the last at 30 s old. */
function steadySwap(usedBytes = 4 * GIB) {
  let history: ReturnType<typeof recordSwapUse> = [];
  for (let minute = 6; minute >= 0; minute -= 1) {
    history = recordSwapUse(history, { atMs: NOW - 30_000 - minute * MINUTE, usedBytes });
  }
  return history;
}

function input(overrides: Partial<BurstHeadroomInput> = {}): BurstHeadroomInput {
  return {
    platform: "darwin",
    nowMs: NOW,
    reading: reading(),
    swapHistory: steadySwap(),
    taken: 3,
    unseen: 0,
    freeDiskBytes: 200 * GIB,
    lowFreeBytes: 20 * GIB,
    lastGrantAtMs: undefined,
    config: resolveBurstConfig(undefined, { maxConcurrent: 3, burstMaxConcurrent: 5 }, 3),
    ...overrides,
  };
}

describe("evaluateBurstHeadroom", () => {
  test("a quiet, roomy machine passes, with the numbers it judged", () => {
    const verdict = evaluateBurstHeadroom(input());
    expect(verdict.ok).toBe(true);
    expect(verdict.numbers).toMatchObject({
      readingAgeMs: 30_000,
      availableGB: 30,
      requiredMemoryGB: 8,
      memoryPressure: 1,
      swapGrowthGB: 0,
      loadPerCore: 0.38,
      freeDiskGB: 200,
      requiredDiskGB: 80,
    });
  });

  test("no reading from the monitor refuses, as a failed read", () => {
    const verdict = evaluateBurstHeadroom(input({ reading: undefined }));
    expect(verdict).toMatchObject({ ok: false, check: "reading" });
  });

  test("a reading older than the bound refuses", () => {
    const verdict = evaluateBurstHeadroom(
      input({ reading: reading({ takenAtMs: NOW - BURST_READING_MAX_AGE_MS - 1 }) }),
    );
    expect(verdict).toMatchObject({ ok: false, check: "reading" });
  });

  test("an unreadable free-disk figure refuses", () => {
    const verdict = evaluateBurstHeadroom(input({ freeDiskBytes: undefined }));
    expect(verdict).toMatchObject({ ok: false, check: "reading" });
    expect(verdict.ok === false && verdict.detail).toContain("free disk");
  });

  test("macOS without memory counters refuses; so does a missing pressure level", () => {
    expect(
      evaluateBurstHeadroom(input({ reading: reading({ systemMemory: undefined }) })),
    ).toMatchObject({ ok: false, check: "reading" });
    const noPressure = reading().systemMemory;
    expect(
      evaluateBurstHeadroom(
        input({
          reading: reading({
            systemMemory: noPressure && { ...noPressure, memoryPressureLevel: undefined },
          }),
        }),
      ),
    ).toMatchObject({ ok: false, check: "reading" });
  });

  test("a memory-brake hold refuses", () => {
    expect(
      evaluateBurstHeadroom(input({ reading: reading({ memoryBrakeHeld: true }) })),
    ).toMatchObject({ ok: false, check: "memory" });
  });

  test("macOS pressure above normal refuses", () => {
    const memory = reading().systemMemory;
    const verdict = evaluateBurstHeadroom(
      input({
        reading: reading({ systemMemory: memory && { ...memory, memoryPressureLevel: 2 } }),
      }),
    );
    expect(verdict).toMatchObject({ ok: false, check: "memory" });
  });

  test("less available memory than one more build needs refuses", () => {
    const memory = reading().systemMemory;
    const verdict = evaluateBurstHeadroom(
      input({
        reading: reading({ systemMemory: memory && { ...memory, availableBytes: 7.9 * GIB } }),
      }),
    );
    expect(verdict).toMatchObject({ ok: false, check: "memory" });
  });

  test("allowed-but-unseen builds are reserved for before they show in the reading", () => {
    const memory = reading().systemMemory;
    const lowish = reading({ systemMemory: memory && { ...memory, availableBytes: 20 * GIB } });
    expect(evaluateBurstHeadroom(input({ reading: lowish, unseen: 1 })).ok).toBe(true);
    expect(evaluateBurstHeadroom(input({ reading: lowish, unseen: 2 }))).toMatchObject({
      ok: false,
      check: "memory",
    });
  });

  test("swap that grew past the line within the window refuses", () => {
    const grown = recordSwapUse(steadySwap(), {
      atMs: NOW - 10_000,
      usedBytes: 4 * GIB + BURST_SWAP_GROWTH_BYTES,
    });
    expect(evaluateBurstHeadroom(input({ swapHistory: grown }))).toMatchObject({
      ok: false,
      check: "swap",
    });
  });

  test("swap that drifted by tens of megabytes passes", () => {
    const drifted = recordSwapUse(steadySwap(), {
      atMs: NOW - 10_000,
      usedBytes: 4 * GIB + 60 * MIB,
    });
    expect(evaluateBurstHeadroom(input({ swapHistory: drifted })).ok).toBe(true);
  });

  test("swap growth is measured from the lowest point in the window, not the first", () => {
    let history = recordSwapUse([], { atMs: NOW - 5 * MINUTE, usedBytes: 9 * GIB });
    history = recordSwapUse(history, { atMs: NOW - 3 * MINUTE, usedBytes: 4 * GIB });
    history = recordSwapUse(history, { atMs: NOW - 10_000, usedBytes: 5 * GIB });
    expect(evaluateBurstHeadroom(input({ swapHistory: history }))).toMatchObject({
      ok: false,
      check: "swap",
    });
  });

  test("with under two minutes of swap history the swap check cannot pass", () => {
    const young = recordSwapUse([], { atMs: NOW - 60_000, usedBytes: 4 * GIB });
    expect(evaluateBurstHeadroom(input({ swapHistory: young }))).toMatchObject({
      ok: false,
      check: "swap",
    });
    expect(evaluateBurstHeadroom(input({ swapHistory: [] }))).toMatchObject({
      ok: false,
      check: "swap",
    });
  });

  test("a saturation incident refuses", () => {
    expect(
      evaluateBurstHeadroom(input({ reading: reading({ cpuSaturated: true }) })),
    ).toMatchObject({ ok: false, check: "cpu" });
  });

  test("load at the per-core line (1.5 x cores) refuses; the 1.2 x cores three builds put on a 16-core Mac passes", () => {
    const loaded = (load1: number) =>
      reading({
        systemLoad: {
          load: { kind: "loadavg", cores: 16, load1, load5: load1, load15: load1 },
          freeMemoryBytes: 0,
          totalMemoryBytes: 64 * GIB,
        },
      });
    expect(evaluateBurstHeadroom(input({ reading: loaded(19.2) })).ok).toBe(true);
    expect(evaluateBurstHeadroom(input({ reading: loaded(24) }))).toMatchObject({
      ok: false,
      check: "cpu",
    });
  });

  test("no load reading refuses", () => {
    const none = reading({
      systemLoad: { load: undefined, freeMemoryBytes: 0, totalMemoryBytes: 64 * GIB },
    });
    expect(evaluateBurstHeadroom(input({ reading: none }))).toMatchObject({
      ok: false,
      check: "reading",
    });
  });

  test("the disk brake holding refuses", () => {
    expect(
      evaluateBurstHeadroom(input({ reading: reading({ diskBrakeHeld: true }) })),
    ).toMatchObject({ ok: false, check: "disk" });
  });

  test("free disk must cover the low line plus a reserve for every build running and the new one", () => {
    // 20 + 15 x (3 + 1) = 80
    expect(evaluateBurstHeadroom(input({ freeDiskBytes: 80 * GIB })).ok).toBe(true);
    expect(evaluateBurstHeadroom(input({ freeDiskBytes: 79.9 * GIB }))).toMatchObject({
      ok: false,
      check: "disk",
    });
    // 20 + 15 x (4 + 1) = 95
    expect(evaluateBurstHeadroom(input({ taken: 4, freeDiskBytes: 90 * GIB }))).toMatchObject({
      ok: false,
      check: "disk",
    });
  });

  test("a burst build waits for a reading that has seen the previous build, floor or burst, run", () => {
    const grantedAt = NOW - 40_000;
    expect(evaluateBurstHeadroom(input({ lastGrantAtMs: grantedAt }))).toMatchObject({
      ok: false,
      check: "settling",
    });
    const later = reading({ takenAtMs: grantedAt + BURST_SETTLE_MS });
    expect(evaluateBurstHeadroom(input({ reading: later, lastGrantAtMs: grantedAt })).ok).toBe(
      true,
    );
  });

  test("on macOS the reclaimable figure is what memory is judged on, not the strict available one", () => {
    const memory = reading().systemMemory;
    const cached = reading({
      systemMemory: memory && {
        ...memory,
        availableBytes: 3.5 * GIB,
        reclaimableBytes: 15 * GIB,
      },
    });
    const verdict = evaluateBurstHeadroom(input({ reading: cached }));
    expect(verdict.ok).toBe(true);
    expect(verdict.numbers.availableGB).toBe(15);
    const tight = reading({
      systemMemory: memory && { ...memory, availableBytes: 30 * GIB, reclaimableBytes: 6 * GIB },
    });
    expect(evaluateBurstHeadroom(input({ reading: tight }))).toMatchObject({
      ok: false,
      check: "memory",
    });
  });

  test("with no reclaimable figure (Linux's MemAvailable already is one) the available figure is used", () => {
    const memory = reading().systemMemory;
    const linux = reading({
      systemMemory: memory && {
        ...memory,
        memoryPressureLevel: undefined,
        availableBytes: 9 * GIB,
      },
    });
    expect(evaluateBurstHeadroom(input({ platform: "linux", reading: linux })).ok).toBe(true);
  });

  test("memory pressure above normal still refuses with plenty reclaimable", () => {
    const memory = reading().systemMemory;
    const pressured = reading({
      systemMemory: memory && { ...memory, reclaimableBytes: 40 * GIB, memoryPressureLevel: 2 },
    });
    expect(evaluateBurstHeadroom(input({ reading: pressured }))).toMatchObject({
      ok: false,
      check: "memory",
    });
  });

  test("Windows has no pressure level or swap, so only memory, CPU busy share and disk apply", () => {
    const windows = reading({
      systemMemory: undefined,
      systemLoad: {
        load: { kind: "cpu-busy", cores: 16, busyFraction: 0.4, load1: 6.4 },
        freeMemoryBytes: 20 * GIB,
        totalMemoryBytes: 64 * GIB,
      },
    });
    expect(
      evaluateBurstHeadroom(input({ platform: "win32", reading: windows, swapHistory: [] })).ok,
    ).toBe(true);
    const busy = reading({
      systemMemory: undefined,
      systemLoad: {
        load: { kind: "cpu-busy", cores: 16, busyFraction: 0.8, load1: 12.8 },
        freeMemoryBytes: 20 * GIB,
        totalMemoryBytes: 64 * GIB,
      },
    });
    expect(
      evaluateBurstHeadroom(input({ platform: "win32", reading: busy, swapHistory: [] })),
    ).toMatchObject({ ok: false, check: "cpu" });
    const tight = reading({
      systemMemory: undefined,
      systemLoad: {
        load: { kind: "cpu-busy", cores: 16, busyFraction: 0.4, load1: 6.4 },
        freeMemoryBytes: 6 * GIB,
        totalMemoryBytes: 64 * GIB,
      },
    });
    expect(
      evaluateBurstHeadroom(input({ platform: "win32", reading: tight, swapHistory: [] })),
    ).toMatchObject({ ok: false, check: "memory" });
  });

  test("Linux has swap but no pressure level", () => {
    const memory = reading().systemMemory;
    const linux = reading({
      systemMemory: memory && { ...memory, memoryPressureLevel: undefined },
    });
    expect(evaluateBurstHeadroom(input({ platform: "linux", reading: linux })).ok).toBe(true);
  });
});

describe("the disk reserve", () => {
  const lowFreeBytes = 20 * GIB;
  const perBuildDiskBytes = 15 * GIB;

  test("is the low line plus the reserve for every build taken and the new one", () => {
    expect(diskReserveBytes({ lowFreeBytes, perBuildDiskBytes, taken: 0 })).toBe(35 * GIB);
    expect(diskReserveBytes({ lowFreeBytes, perBuildDiskBytes, taken: 2 })).toBe(65 * GIB);
    expect(diskReserveBytes({ lowFreeBytes, perBuildDiskBytes, taken: 3 })).toBe(80 * GIB);
  });

  test("describes the free and needed figures and how the need adds up", () => {
    const text = describeDiskReserve({
      freeBytes: 64 * GIB,
      lowFreeBytes,
      perBuildDiskBytes,
      taken: 2,
    });
    expect(text).toBe(
      "64 GB of disk is free and 65 GB is needed: the 20 GB low line plus 15 GB for each of 3 builds",
    );
  });
});
