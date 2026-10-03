/**
 * Derives the default device-slot caps from the machine the daemon is running on, and decides
 * whether there is enough live memory headroom to start one more device.
 *
 * Every constant here came off Tyler's M3 Max (64 GiB, 12 performance + 4 efficiency cores)
 * while two simulators were booted and a build was running. The numbers are in
 * docs/device-leases.md; the short version is that a booted simulator with an app running costs
 * 3.95 GiB of phys_footprint (not the 24 GiB its 277 processes sum to in RSS), and that memory
 * is not what runs out first on a machine this size.
 */

const GIBIBYTE = 1024 ** 3;

/**
 * Measured: one iPhone 17 Pro simulator, booted with an app running, summed across its 277
 * processes by phys_footprint (`top -stats pid,mem`, which reports what Activity Monitor calls
 * Memory). Rounded up to 4 GiB. An Android emulator was not measured — booting one on that
 * machine was off limits — so it is assumed to cost the same; its guest RAM alone is 2 GiB on a
 * stock AVD, plus qemu overhead, which lands in the same place.
 */
export const DEVICE_FOOTPRINT_BYTES = 4 * GIBIBYTE;

/**
 * What the machine needs before any device gets a slot: the OS, the editors, and the build
 * toolchains that are the whole point of booting a device. Measured on Tyler's machine as
 * Android Studio and its Gradle/Kotlin daemons at ~21 GiB, Chrome at ~9 GiB, Xcode's build
 * services at ~2.4 GiB, plus the daemon and its agents. 24 GiB is the floor; on a larger
 * machine the proportional term takes over, because a bigger machine is bought to run more.
 */
const RESERVE_FLOOR_BYTES = 24 * GIBIBYTE;
const RESERVE_FRACTION = 0.4;

/**
 * Cores per device. A booted device is nearly free at idle — measured at 2% of one core — but
 * boot, install and the first app launch each burn 1–2 cores for a minute or two, and they all
 * happen at once when several agents start together. Four cores per device leaves a build the
 * 8+ it wants. Performance cores only: an efficiency core will not carry a simulator boot, and
 * counting all 16 on an M3 Max would buy a slot the machine cannot actually serve.
 */
const CORES_PER_DEVICE = 4;

/** Never derive zero (the cap would block every device), never derive more than a desk needs. */
const MIN_SLOTS = 1;
const MAX_SLOTS = 6;

export interface SystemHardware {
  memoryBytes: number;
  /** `hw.ncpu`. Used when the performance-core count is unavailable (Intel Macs, Linux). */
  cpuCount: number;
  /** `hw.perflevel0.logicalcpu` on Apple silicon; undefined elsewhere. */
  performanceCpuCount?: number;
}

export interface DeviceSlotDefaults {
  totalSlots: number;
  slotsPerPlatform: number;
}

/**
 * Reserve, then divide, then clamp by cores.
 *
 *   reserve      = max(24 GiB, 40% of hw.memsize)
 *   memorySlots  = floor((hw.memsize - reserve) / 4 GiB)
 *   coreSlots    = floor(performanceCores / 4)        // hw.perflevel0.logicalcpu, else hw.ncpu
 *   totalSlots   = clamp(min(memorySlots, coreSlots), 1, 6)
 *   perPlatform  = clamp(ceil(totalSlots / 2), 1, totalSlots)
 *
 * On the 64 GiB / 12-performance-core M3 Max this brief was written against: reserve 25.6 GiB,
 * memorySlots 9, coreSlots 3 — so 3 total and 2 per platform. Cores bind, not memory, which is
 * why a naive RAM division suggests 5 or 6 and is wrong.
 */
export function deriveDeviceSlotDefaults(hardware: SystemHardware): DeviceSlotDefaults {
  const reserveBytes = Math.max(RESERVE_FLOOR_BYTES, hardware.memoryBytes * RESERVE_FRACTION);
  const memorySlots = Math.floor((hardware.memoryBytes - reserveBytes) / DEVICE_FOOTPRINT_BYTES);
  const cores = hardware.performanceCpuCount ?? hardware.cpuCount;
  const coreSlots = Math.floor(cores / CORES_PER_DEVICE);
  const totalSlots = Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, Math.min(memorySlots, coreSlots)));
  return {
    totalSlots,
    slotsPerPlatform: Math.min(totalSlots, Math.max(1, Math.ceil(totalSlots / 2))),
  };
}

export interface MemoryHeadroom {
  /** Pages that are free right now — not the file cache, which a new device cannot have. */
  availableBytes?: number;
  swapUsedRatio?: number;
}

export interface HeadroomThresholds {
  minAvailableBytes: number;
  maxSwapUsedRatio: number;
}

export type HeadroomVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The second gate, independent of the slot count: today's machine had 0.4 GiB free and 20.6 of
 * 21.5 GiB of swap in use *with a slot nominally free*, and one more device then is
 * catastrophic. Both signals are machine-wide, because a per-device attribution of memory
 * pressure would be the same misleading RSS sum the detector refuses to compute.
 */
export function evaluateMemoryHeadroom(
  headroom: MemoryHeadroom,
  thresholds: HeadroomThresholds,
): HeadroomVerdict {
  if (
    headroom.swapUsedRatio !== undefined &&
    headroom.swapUsedRatio >= thresholds.maxSwapUsedRatio
  ) {
    return {
      ok: false,
      reason: `swap is ${Math.round(headroom.swapUsedRatio * 100)}% used (limit ${Math.round(
        thresholds.maxSwapUsedRatio * 100,
      )}%)`,
    };
  }
  if (
    headroom.availableBytes !== undefined &&
    headroom.availableBytes < thresholds.minAvailableBytes
  ) {
    return {
      ok: false,
      reason: `only ${(headroom.availableBytes / GIBIBYTE).toFixed(1)} GB of memory is free (need ${(
        thresholds.minAvailableBytes / GIBIBYTE
      ).toFixed(1)} GB)`,
    };
  }
  // No signal at all is not a reason to refuse: the sampler returns undefined on a host where
  // it cannot read memory, and the slot count still applies there.
  return { ok: true };
}
