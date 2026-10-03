/**
 * Finds the iOS simulators and Android emulators that are actually running, from the same
 * `ps` snapshot AgentResourceMonitor already takes (process-sampler.ts). Pure: no subprocess,
 * no CoreSimulator or adb round trip.
 *
 * This is the source of truth for "how many devices are running" — never the lease table.
 * A simulator Tyler booted by hand, or an agent that skipped checkout entirely, shows up here
 * and counts against the cap; bookkeeping that disagrees with `ps` is the bookkeeping's problem.
 * See docs/device-leases.md.
 */

import { parseClockSeconds, type ProcessSampleRow } from "./process-sampler.js";

export type DevicePlatform = "ios" | "android";

export interface RunningDevice {
  platform: DevicePlatform;
  /**
   * Stable identity of the booted device: a simulator UDID, or an AVD name. Two devices are
   * the same device when these match, which is what lets a lease bind to one and what keeps
   * the emulator launcher and its qemu child from being counted twice.
   */
  deviceId: string;
  /** The process that represents the device — `launchd_sim`, or the emulator/qemu process. */
  pid: number;
  /**
   * Every pid that belongs to this device. Deliberately no memory figure: summing RSS across a
   * simulator's 277 processes reads 24 GB against a real footprint of 4 GB, because RSS counts
   * every shared page in every process that maps it. The cap's memory reasoning uses a measured
   * per-device constant (device-slot-defaults.ts) and machine-wide headroom instead.
   */
  pids: number[];
  /**
   * How long the device has been up, from `ps`'s elapsed-time column. This is how the UI can
   * say "running for 2h" about a device nobody leased — Tyler's own, most of all.
   */
  uptimeSeconds?: number;
  /** The agent whose process tree contains this device's process, when there is one. */
  agentId?: string;
}

/**
 * A booted simulator is exactly one `launchd_sim` process whose argv names the device's data
 * directory — verified against both simulators booted on Tyler's machine:
 *
 *   launchd_sim .../CoreSimulator/Devices/<UDID>/data/var/run/launchd_bootstrap.plist
 *
 * Every other process in the simulator (235–277 of them) is a descendant of it, so the tree
 * walk below is what `xcrun simctl list devices booted` would tell us, without the subprocess
 * — and unlike simctl, it still answers when CoreSimulator is wedged, which on a machine
 * thrashing this hard is exactly when the answer is needed.
 */
const SIMULATOR_UDID_PATTERN =
  /\/Devices\/([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})\//;
const SIMULATOR_PROCESS = "launchd_sim";

/**
 * The Android emulator launches as `<sdk>/emulator/emulator -avd <name>` and re-execs into
 * `<sdk>/emulator/qemu/<host>/qemu-system-<arch>[-headless] -avd <name>` (both binaries verified
 * present in Tyler's SDK; the argv shape is the emulator's documented CLI). `-avd <name>` is
 * required on both halves, which is what keeps `emulator -list-avds`, `adb`, and a plain
 * qemu VM that has nothing to do with Android out of the count.
 */
const EMULATOR_AVD_FLAG = "-avd";

function basename(token: string): string {
  return token.split("/").pop() ?? token;
}

/**
 * argv[0] only, never "some token looks like this". `grep -r launchd_sim <device path>` carries
 * both halves of the simulator signature as arguments, and matching it would invent a device out
 * of somebody reading about one — the same trap build-daemon-reaper.ts documents.
 */
function isEmulatorExecutable(token: string | undefined): boolean {
  const name = basename(token ?? "");
  return name === "emulator" || name.startsWith("qemu-system-");
}

function readAvdName(tokens: readonly string[]): string | undefined {
  const flagIndex = tokens.indexOf(EMULATOR_AVD_FLAG);
  if (flagIndex < 0) return undefined;
  const name = tokens[flagIndex + 1];
  return name && !name.startsWith("-") ? name : undefined;
}

function identifyDevice(
  row: ProcessSampleRow,
): { platform: DevicePlatform; deviceId: string } | undefined {
  const tokens = row.command.split(/\s+/);
  if (basename(tokens[0] ?? "") === SIMULATOR_PROCESS) {
    const udid = SIMULATOR_UDID_PATTERN.exec(row.command)?.[1];
    return udid ? { platform: "ios", deviceId: udid.toUpperCase() } : undefined;
  }
  if (!isEmulatorExecutable(tokens[0])) return undefined;
  const avd = readAvdName(tokens);
  return avd ? { platform: "android", deviceId: avd } : undefined;
}

function buildChildrenByPpid(rows: readonly ProcessSampleRow[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }
  return children;
}

function collectTree(rootPid: number, children: Map<number, number[]>): number[] {
  const pids: number[] = [];
  const seen = new Set<number>();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return pids;
}

export interface DetectRunningDevicesInput {
  rows: readonly ProcessSampleRow[];
  /** Agent process trees from attributeProcessTrees, for attributing a device to its launcher. */
  agentTrees: ReadonlyArray<{ agentId: string; pids: readonly number[] }>;
}

/**
 * One entry per running device, deduplicated by `deviceId`. The emulator launcher and its qemu
 * child both carry `-avd <name>`; the ancestor wins, so the tree below covers both.
 *
 * Attribution is best-effort and usually absent for iOS: `launchd_sim` is reparented to pid 1
 * the moment CoreSimulator boots the device, so it is in no agent's tree — the same gap
 * process-attribution.ts documents for build daemons. A lease is what supplies the owner in
 * that case; a device with neither is reported as unattributed rather than guessed at.
 */
export function detectRunningDevices(input: DetectRunningDevicesInput): RunningDevice[] {
  const children = buildChildrenByPpid(input.rows);
  const agentIdByPid = new Map<number, string>();
  for (const tree of input.agentTrees) {
    for (const pid of tree.pids) agentIdByPid.set(pid, tree.agentId);
  }

  const byDeviceId = new Map<string, RunningDevice>();
  for (const row of input.rows) {
    const identity = identifyDevice(row);
    if (!identity) continue;
    const pids = collectTree(row.pid, children);
    const uptimeSeconds = parseClockSeconds(row.etime);
    const device: RunningDevice = {
      platform: identity.platform,
      deviceId: identity.deviceId,
      pid: row.pid,
      pids,
      ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
      ...(agentIdByPid.has(row.pid) ? { agentId: agentIdByPid.get(row.pid) as string } : {}),
    };
    const existing = byDeviceId.get(device.deviceId);
    // The launcher's tree contains the qemu process, never the other way round.
    if (existing && existing.pids.includes(device.pid)) continue;
    byDeviceId.set(device.deviceId, device);
  }

  return [...byDeviceId.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

export function countDevicesByPlatform(
  devices: readonly RunningDevice[],
): Record<DevicePlatform, number> {
  return {
    ios: devices.filter((device) => device.platform === "ios").length,
    android: devices.filter((device) => device.platform === "android").length,
  };
}

/**
 * Every simulator UDID mentioned by any process in the sample, and — when the process is a
 * `launchd_sim` — the device set its data directory lives in.
 *
 * This exists for the artifact janitor, which has to prove a simulator directory is abandoned
 * before it deletes it, and it is deliberately far broader than `detectRunningDevices` above.
 * That function answers "how many devices are running", so it matches argv[0] and one shape.
 * This one answers "could anything on this machine still care about this UDID", so anything
 * naming it counts: the `xcodebuild` mid-run, the `testmanagerd` talking to it, a `simctl`
 * subprocess, a shell whose cwd flag carries the path. A false positive here costs one sweep of
 * patience. A false negative costs somebody their simulator.
 *
 * `detectRunningDevices` cannot answer this on its own for the case that matters most: its
 * pattern requires the literal path segment `/Devices/`, and a test clone lives under
 * `/XCTestDevices/`, which does not contain it. A booted clone is therefore invisible to the
 * device cap's count — see docs/artifact-janitor.md, which says why that is left alone here.
 */
export interface DeviceIdReference {
  /**
   * Set when a `launchd_sim` process owns this UDID's data directory — the device is booted.
   * The value is the device set root the directory sits in, so a janitor scoped to one set can
   * tell "booted, in my set" from "booted, somewhere else".
   */
  bootedInSetRoot?: string;
  /** Every pid whose command line names the UDID, booted or not. */
  pids: number[];
}

/**
 * A booted device's `launchd_sim` argv ends in
 * `<set root>/<UDID>/data/var/run/launchd_bootstrap.plist`, which is the only place the set root
 * appears in a process listing at all. Anchored on the `/data/` structure rather than on the
 * set directory's name, because the name is `Devices` for the default set, `XCTestDevices` for
 * test clones, and anything at all for a set created with `simctl --set`.
 */
const DEVICE_DATA_PATH =
  /(\/.*?)\/([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})\/data\/var\/run\//;
const ANY_DEVICE_UDID = /[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}/g;

export function collectDeviceIdReferences(
  rows: readonly ProcessSampleRow[],
): Map<string, DeviceIdReference> {
  const references = new Map<string, DeviceIdReference>();
  const record = (deviceId: string, pid: number, setRoot?: string) => {
    const existing = references.get(deviceId) ?? { pids: [] };
    if (!existing.pids.includes(pid)) existing.pids.push(pid);
    if (setRoot !== undefined) existing.bootedInSetRoot = setRoot;
    references.set(deviceId, existing);
  };

  for (const row of rows) {
    for (const match of row.command.matchAll(ANY_DEVICE_UDID)) {
      record(match[0].toUpperCase(), row.pid);
    }
    if (basename(row.command.split(/\s+/)[0] ?? "") !== SIMULATOR_PROCESS) continue;
    const booted = DEVICE_DATA_PATH.exec(row.command);
    if (booted) record(booted[2].toUpperCase(), row.pid, booted[1]);
  }
  return references;
}
