/**
 * What the native build gate (native-build-gate.ts) needs to hand out burst slots: the slot
 * defaults derived from the machine, and the headroom rules a build above the guaranteed floor
 * must pass (docs/resource-monitor.md, "The native build gate"). Pure: the gate keeps the state.
 *
 * Burst fails closed. A reading that is missing, old, or lacks a signal the platform reports
 * refuses the build, where the floor's own checks fail open.
 */

import { GIBIBYTE } from "./gigabytes.js";
import type { SystemLoadReading, SystemLoadSample } from "./system-load.js";
import type { SystemMemorySample } from "./process-sampler.js";

/** The monitor sweeps every 60 s; a reading older than two and a half sweeps missed two. */
export const BURST_READING_MAX_AGE_MS = 150_000;
/** Swap is judged over this window of readings. */
export const BURST_SWAP_WINDOW_MS = 5 * 60_000;
/** A window shorter than this proves nothing about whether swap is growing. */
export const BURST_SWAP_MIN_SPAN_MS = 2 * 60_000;
/**
 * Swap that rose this far from its lowest point in the window is the machine paging out. A calm
 * Mac drifts by tens of MB a sweep (the memory brake's steady line is 128 MiB a sweep), so this
 * is 512 MiB over five minutes, well over drift and well under the brake's 1 GiB a sweep.
 */
export const BURST_SWAP_GROWTH_BYTES = 512 * 1024 ** 2;
/**
 * A burst build is judged only by a reading taken this long after the previous burst grant. A
 * Gradle or Xcode build takes a minute or two to reach its memory, so a reading taken sooner has
 * not seen the last grant's footprint and a second grant on it would stack on an unseen one.
 */
export const BURST_SETTLE_MS = 90_000;

const DEFAULT_PER_BUILD_MEMORY_GB = 8;
/**
 * Between the 10 GB one Gradle build commonly writes and the 34 GB of the 2026-10-08 incident
 * (docs/disk-pressure.md); the reserve is held for every build already running as well as the
 * new one, so a figure at the top of that range would forbid burst on any disk under 150 GB.
 */
const DEFAULT_PER_BUILD_DISK_GB = 15;
/** One heavy build loads about 1x the cores; saturation opens at 2x (docs/resource-monitor.md). */
const DEFAULT_MAX_LOAD_PER_CORE = 1;
/** Windows only: the busy share saturation opens at is 0.9, and the release line is 0.75. */
const DEFAULT_MAX_BUSY_FRACTION = 0.75;

/** Cores one guaranteed build is sized for: a Gradle JVM peaks near 3 and compilers add to it. */
const CORES_PER_FLOOR_BUILD = 5;
/** Cores one burst build is sized for: a build only needs 3 to make steady progress. */
const CORES_PER_BURST_BUILD = 3;
/** Left for the OS, the editors, the daemon and the agents themselves. */
const RESERVED_MEMORY_GB = 16;
/** A guaranteed build's budget: its daemons, test JVMs and a device, at their peak together. */
const MEMORY_PER_FLOOR_BUILD_GB = 16;
const MAX_FLOOR = 4;
const MAX_BURST_ABOVE_FLOOR = 3;

export interface BuildGateHardware {
  cpuCount: number;
  memoryBytes: number;
}

export interface BuildGateSlotDefaults {
  maxConcurrent: number;
  burstMaxConcurrent: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Floor and ceiling from cores and memory, each bound by whichever runs out first.
 *
 *   floor   = clamp(min(floor(cores / 5), floor((GiB - 16) / 16)), 1, 4)
 *   ceiling = clamp(min(floor(cores / 3), floor((GiB - 16) / 8)), floor, floor + 3)
 *
 * On the 16-core / 64 GiB Mac: floor 3 (cores 3, memory 3), ceiling 5 (cores 5, memory 6). An
 * 8-core / 16 GiB laptop gets 1 and 1, so burst never opens there.
 */
export function deriveBuildGateDefaults(hardware: BuildGateHardware): BuildGateSlotDefaults {
  const memoryGiB = hardware.memoryBytes / GIBIBYTE - RESERVED_MEMORY_GB;
  const maxConcurrent = clamp(
    Math.min(
      Math.floor(hardware.cpuCount / CORES_PER_FLOOR_BUILD),
      Math.floor(memoryGiB / MEMORY_PER_FLOOR_BUILD_GB),
    ),
    1,
    MAX_FLOOR,
  );
  const burstMaxConcurrent = clamp(
    Math.min(
      Math.floor(hardware.cpuCount / CORES_PER_BURST_BUILD),
      Math.floor(memoryGiB / DEFAULT_PER_BUILD_MEMORY_GB),
    ),
    maxConcurrent,
    maxConcurrent + MAX_BURST_ABOVE_FLOOR,
  );
  return { maxConcurrent, burstMaxConcurrent };
}

/** `agents.buildGate.burst`. */
export interface BuildGateBurstConfig {
  enabled?: boolean;
  maxConcurrent?: number;
  perBuildMemoryGB?: number;
  perBuildDiskGB?: number;
  maxLoadPerCore?: number;
  maxBusyFraction?: number;
}

export interface ResolvedBurstConfig {
  enabled: boolean;
  /** Never under the floor: a ceiling at or under the floor is burst off. */
  maxConcurrent: number;
  perBuildMemoryBytes: number;
  perBuildDiskBytes: number;
  maxLoadPerCore: number;
  maxBusyFraction: number;
}

export function resolveBurstConfig(
  config: BuildGateBurstConfig | undefined,
  defaults: BuildGateSlotDefaults,
  floor: number,
): ResolvedBurstConfig {
  return {
    enabled: config?.enabled ?? true,
    maxConcurrent: Math.max(
      floor,
      Math.floor(config?.maxConcurrent ?? defaults.burstMaxConcurrent),
    ),
    perBuildMemoryBytes: (config?.perBuildMemoryGB ?? DEFAULT_PER_BUILD_MEMORY_GB) * GIBIBYTE,
    perBuildDiskBytes: (config?.perBuildDiskGB ?? DEFAULT_PER_BUILD_DISK_GB) * GIBIBYTE,
    maxLoadPerCore: config?.maxLoadPerCore ?? DEFAULT_MAX_LOAD_PER_CORE,
    maxBusyFraction: config?.maxBusyFraction ?? DEFAULT_MAX_BUSY_FRACTION,
  };
}

/**
 * What the resource monitor knows about the machine at the end of a sweep, after its brakes and
 * saturation detector ran. The gate never reads these from the machine itself.
 */
export interface BuildGateMachineReading {
  /** When the sweep took its readings. */
  takenAtMs: number;
  systemMemory: SystemMemorySample | undefined;
  systemLoad: SystemLoadSample;
  /** The memory brake holds new child turns (macOS pressure or fast swap growth). */
  memoryBrakeHeld: boolean;
  /** The disk brake holds new child turns (free space low or falling fast). */
  diskBrakeHeld: boolean;
  /** A CPU saturation incident is open. */
  cpuSaturated: boolean;
}

export interface SwapUseReading {
  atMs: number;
  usedBytes: number;
}

/** Adds a reading and drops what is older than the window, measured from the newest. */
export function recordSwapUse(
  history: readonly SwapUseReading[],
  reading: SwapUseReading,
): SwapUseReading[] {
  const newest = Math.max(reading.atMs, ...history.map((entry) => entry.atMs));
  return [...history, reading]
    .filter((entry) => entry.atMs >= newest - BURST_SWAP_WINDOW_MS)
    .sort((a, b) => a.atMs - b.atMs);
}

export type BurstCheck = "reading" | "memory" | "swap" | "cpu" | "disk" | "settling";

/** The figures a decision judged, for the log and the refusal. Absent where a signal was. */
export interface BurstHeadroomNumbers {
  readingAgeMs?: number;
  availableGB?: number;
  requiredMemoryGB: number;
  memoryPressure?: number;
  swapGrowthGB?: number;
  loadPerCore?: number;
  busyFraction?: number;
  freeDiskGB?: number;
  requiredDiskGB: number;
}

export type BurstHeadroomVerdict =
  | { ok: true; numbers: BurstHeadroomNumbers }
  | { ok: false; check: BurstCheck; detail: string; numbers: BurstHeadroomNumbers };

export interface BurstHeadroomInput {
  platform: NodeJS.Platform;
  nowMs: number;
  reading: BuildGateMachineReading | undefined;
  swapHistory: readonly SwapUseReading[];
  /** Slots taken: running builds, runners setting up, and allowances the scan has not seen yet. */
  taken: number;
  /** Of those, the allowances not yet seen running: their memory is not in the reading. */
  unseen: number;
  freeDiskBytes: number | undefined;
  lowFreeBytes: number;
  lastBurstGrantAtMs: number | undefined;
  config: ResolvedBurstConfig;
}

function gb(bytes: number): number {
  return Math.round((bytes / GIBIBYTE) * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What the reading says, once every signal this platform reports is known to be there. */
interface HeadroomSignals {
  reading: BuildGateMachineReading;
  load: SystemLoadReading;
  availableBytes: number;
  freeDiskBytes: number;
  /** Rise from the window's lowest swap use; undefined where the platform has no swap reading. */
  swapGrowth: { bytes: number; spanMs: number } | undefined;
}

type SignalsRead = { ok: true; signals: HeadroomSignals } | { ok: false; detail: string };

/** Why there is no usable reading: none yet, or older than the bound. */
function readingProblem(input: BurstHeadroomInput, numbers: BurstHeadroomNumbers) {
  const { reading, nowMs } = input;
  if (!reading) return "the resource monitor has not reported a reading";
  const ageMs = nowMs - reading.takenAtMs;
  numbers.readingAgeMs = ageMs;
  if (ageMs <= BURST_READING_MAX_AGE_MS) return undefined;
  return `the resource monitor's last reading is ${Math.round(ageMs / 1000)}s old (limit ${BURST_READING_MAX_AGE_MS / 1000}s)`;
}

/** Available memory as this platform reports it: `os.freemem()` on Windows, the sampler elsewhere. */
function availableMemoryOf(platform: NodeJS.Platform, reading: BuildGateMachineReading) {
  return platform === "win32"
    ? reading.systemLoad.freeMemoryBytes
    : reading.systemMemory?.availableBytes;
}

/** A signal this platform reports that the reading lacks. */
function missingSignal(input: BurstHeadroomInput, reading: BuildGateMachineReading) {
  const windows = input.platform === "win32";
  if (input.freeDiskBytes === undefined) return "free disk could not be read";
  if (!windows && !reading.systemMemory) return "the machine's memory counters could not be read";
  if (input.platform === "darwin" && reading.systemMemory?.memoryPressureLevel === undefined) {
    return "macOS memory pressure could not be read";
  }
  if (!reading.systemLoad.load) return "the machine's CPU load could not be read";
  if (availableMemoryOf(input.platform, reading) === undefined) {
    return "the machine's available memory could not be read";
  }
  return undefined;
}

/**
 * Reads every signal the checks need, filling `numbers` as it goes, or says which one is missing
 * or old. This is where burst fails closed.
 */
function readSignals(input: BurstHeadroomInput, numbers: BurstHeadroomNumbers): SignalsRead {
  const { reading } = input;
  if (input.freeDiskBytes !== undefined) numbers.freeDiskGB = gb(input.freeDiskBytes);
  const problem = readingProblem(input, numbers);
  if (problem || !reading) return { ok: false, detail: problem ?? "no reading" };
  const load = reading.systemLoad.load;
  const availableBytes = availableMemoryOf(input.platform, reading);
  const missing = missingSignal(input, reading);
  if (missing || !load || availableBytes === undefined || input.freeDiskBytes === undefined) {
    return { ok: false, detail: missing ?? "a signal is missing" };
  }
  numbers.availableGB = gb(availableBytes);
  if (reading.systemMemory?.memoryPressureLevel !== undefined) {
    numbers.memoryPressure = reading.systemMemory.memoryPressureLevel;
  }
  if (load.kind === "loadavg") numbers.loadPerCore = round(load.load1 / load.cores);
  else numbers.busyFraction = round(load.busyFraction);
  const swapGrowth =
    input.platform === "win32" ? undefined : measureSwapGrowth(input.swapHistory, input.nowMs);
  if (swapGrowth) numbers.swapGrowthGB = gb(swapGrowth.bytes);
  return {
    ok: true,
    signals: { reading, load, availableBytes, freeDiskBytes: input.freeDiskBytes, swapGrowth },
  };
}

/** Rise from the lowest swap use in the window to the newest, and how much history it spans. */
function measureSwapGrowth(
  history: readonly SwapUseReading[],
  nowMs: number,
): { bytes: number; spanMs: number } {
  const window = history.filter((entry) => entry.atMs >= nowMs - BURST_SWAP_WINDOW_MS);
  const newest = window.at(-1);
  const oldest = window[0];
  if (!newest || !oldest) return { bytes: 0, spanMs: 0 };
  const lowest = Math.min(...window.map((entry) => entry.usedBytes));
  return { bytes: newest.usedBytes - lowest, spanMs: newest.atMs - oldest.atMs };
}

type CheckInput = BurstHeadroomInput & { signals: HeadroomSignals };

function checkMemory({ signals, config, unseen }: CheckInput): string | undefined {
  const { reading, availableBytes } = signals;
  const pressure = reading.systemMemory?.memoryPressureLevel;
  if (reading.memoryBrakeHeld) return "the memory brake is holding new work";
  if (pressure !== undefined && pressure > 1) {
    return `macOS memory pressure is ${pressure} (normal is 1)`;
  }
  const requiredBytes = config.perBuildMemoryBytes * (unseen + 1);
  if (availableBytes >= requiredBytes) return undefined;
  const starting = unseen > 0 ? `, counting ${unseen} starting` : "";
  return `${gb(availableBytes)} GB of memory is available and ${gb(requiredBytes)} GB is needed${starting}`;
}

function checkSwap({ signals }: CheckInput): string | undefined {
  const { swapGrowth } = signals;
  if (!swapGrowth) return undefined;
  if (swapGrowth.spanMs < BURST_SWAP_MIN_SPAN_MS) {
    return `swap has been watched for under ${BURST_SWAP_MIN_SPAN_MS / 60_000} minutes, too short to tell whether it is growing`;
  }
  if (swapGrowth.bytes < BURST_SWAP_GROWTH_BYTES) return undefined;
  return `swap grew ${gb(swapGrowth.bytes)} GB in the last ${BURST_SWAP_WINDOW_MS / 60_000} minutes (limit ${gb(BURST_SWAP_GROWTH_BYTES)} GB)`;
}

function checkCpu({ signals, config }: CheckInput): string | undefined {
  const { reading, load } = signals;
  if (reading.cpuSaturated) return "CPU saturation is open";
  if (load.kind === "loadavg") {
    if (load.load1 / load.cores < config.maxLoadPerCore) return undefined;
    return `load is ${round(load.load1)} on ${load.cores} cores (limit ${config.maxLoadPerCore} per core)`;
  }
  if (load.busyFraction < config.maxBusyFraction) return undefined;
  return `the CPU is ${Math.round(load.busyFraction * 100)}% busy (limit ${Math.round(config.maxBusyFraction * 100)}%)`;
}

function checkDisk({ signals, config, taken, lowFreeBytes }: CheckInput): string | undefined {
  if (signals.reading.diskBrakeHeld) return "the disk brake is holding new work";
  const requiredBytes = lowFreeBytes + config.perBuildDiskBytes * (taken + 1);
  if (signals.freeDiskBytes >= requiredBytes) return undefined;
  return `${gb(signals.freeDiskBytes)} GB of disk is free and ${gb(requiredBytes)} GB is needed: the ${gb(lowFreeBytes)} GB low line plus ${gb(config.perBuildDiskBytes)} GB for each of ${taken + 1} builds`;
}

function checkSettling({ signals, nowMs, lastBurstGrantAtMs }: CheckInput): string | undefined {
  if (
    lastBurstGrantAtMs === undefined ||
    signals.reading.takenAtMs >= lastBurstGrantAtMs + BURST_SETTLE_MS
  ) {
    return undefined;
  }
  return `the last burst build was allowed ${Math.round((nowMs - lastBurstGrantAtMs) / 1000)}s ago and no reading has seen it run for ${BURST_SETTLE_MS / 1000}s yet`;
}

const CHECKS: ReadonlyArray<
  [Exclude<BurstCheck, "reading">, (input: CheckInput) => string | undefined]
> = [
  ["memory", checkMemory],
  ["swap", checkSwap],
  ["cpu", checkCpu],
  ["disk", checkDisk],
  ["settling", checkSettling],
];

/**
 * Whether one more build above the floor has room. The first failing check names itself:
 * reading, memory, swap, cpu, disk, settling. macOS reports every signal; Linux has no pressure
 * level; Windows has neither pressure nor swap, so those checks do not apply there, and its
 * available memory is `os.freemem()` and its CPU figure the busy share.
 */
export function evaluateBurstHeadroom(input: BurstHeadroomInput): BurstHeadroomVerdict {
  const { config } = input;
  const numbers: BurstHeadroomNumbers = {
    requiredMemoryGB: gb(config.perBuildMemoryBytes * (input.unseen + 1)),
    requiredDiskGB: gb(input.lowFreeBytes + config.perBuildDiskBytes * (input.taken + 1)),
  };
  const read = readSignals(input, numbers);
  if (!read.ok) return { ok: false, check: "reading", detail: read.detail, numbers };
  const checkInput = { ...input, signals: read.signals };
  for (const [check, run] of CHECKS) {
    const detail = run(checkInput);
    if (detail !== undefined) return { ok: false, check, detail, numbers };
  }
  return { ok: true, numbers };
}
