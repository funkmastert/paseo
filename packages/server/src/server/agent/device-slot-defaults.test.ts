import { describe, expect, test } from "vitest";
import {
  DEVICE_FOOTPRINT_BYTES,
  deriveDeviceSlotDefaults,
  evaluateMemoryHeadroom,
} from "./device-slot-defaults.js";

const GIBIBYTE = 1024 ** 3;

describe("deriveDeviceSlotDefaults", () => {
  test("derives 3 total / 2 per platform on the M3 Max the defaults were measured on", () => {
    expect(
      deriveDeviceSlotDefaults({
        memoryBytes: 68_719_476_736,
        cpuCount: 16,
        performanceCpuCount: 12,
      }),
    ).toEqual({ totalSlots: 3, slotsPerPlatform: 2 });
  });

  test("counts performance cores only, so efficiency cores never buy a slot", () => {
    const allCores = deriveDeviceSlotDefaults({ memoryBytes: 68_719_476_736, cpuCount: 16 });
    const performanceCores = deriveDeviceSlotDefaults({
      memoryBytes: 68_719_476_736,
      cpuCount: 16,
      performanceCpuCount: 12,
    });

    expect(allCores.totalSlots).toBe(4);
    expect(performanceCores.totalSlots).toBe(3);
  });

  test("memory binds on a small machine, cores bind on a large one", () => {
    // 16 GiB laptop: the reserve alone exceeds what is installed, so one device at a time.
    expect(deriveDeviceSlotDefaults({ memoryBytes: 16 * GIBIBYTE, cpuCount: 8 })).toEqual({
      totalSlots: 1,
      slotsPerPlatform: 1,
    });
    // 128 GiB / 16 performance cores: memory would allow 19, cores allow 4.
    expect(
      deriveDeviceSlotDefaults({
        memoryBytes: 128 * GIBIBYTE,
        cpuCount: 24,
        performanceCpuCount: 16,
      }),
    ).toEqual({ totalSlots: 4, slotsPerPlatform: 2 });
  });

  test("clamps to at least one slot and at most six", () => {
    expect(deriveDeviceSlotDefaults({ memoryBytes: 4 * GIBIBYTE, cpuCount: 2 }).totalSlots).toBe(1);
    expect(
      deriveDeviceSlotDefaults({ memoryBytes: 1024 * GIBIBYTE, cpuCount: 192 }).totalSlots,
    ).toBe(6);
  });
});

describe("evaluateMemoryHeadroom", () => {
  const thresholds = { minAvailableBytes: 2 * GIBIBYTE, maxSwapUsedRatio: 0.85 };

  test("refuses on the machine state this feature was written for", () => {
    // Measured: 0.4 GB free, 20.6 of 21.5 GB of swap in use, with a slot nominally free.
    expect(
      evaluateMemoryHeadroom(
        { availableBytes: 0.4 * GIBIBYTE, swapUsedRatio: 20.6 / 21.5 },
        thresholds,
      ),
    ).toEqual({ ok: false, reason: "swap is 96% used (limit 85%)" });
  });

  test("refuses on free memory alone when swap is healthy", () => {
    expect(
      evaluateMemoryHeadroom({ availableBytes: 1.2 * GIBIBYTE, swapUsedRatio: 0.1 }, thresholds),
    ).toEqual({ ok: false, reason: "only 1.2 GB of memory is free (need 2.0 GB)" });
  });

  test("allows a machine with room, and never refuses for lack of a signal", () => {
    expect(
      evaluateMemoryHeadroom({ availableBytes: 20 * GIBIBYTE, swapUsedRatio: 0.2 }, thresholds),
    ).toEqual({ ok: true });
    expect(evaluateMemoryHeadroom({}, thresholds)).toEqual({ ok: true });
  });

  test("one device costs the measured footprint, not its RSS sum", () => {
    // The simulator measured at 3.95 GiB of phys_footprint summed to 24.4 GiB of RSS.
    expect(DEVICE_FOOTPRINT_BYTES).toBe(4 * GIBIBYTE);
  });
});
