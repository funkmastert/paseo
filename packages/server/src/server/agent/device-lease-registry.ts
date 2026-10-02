/**
 * The lease table and what the daemon does to it every sweep. Pure: no timers, no sampling, no
 * id generation — device-lease-manager.ts owns those and calls in here.
 *
 * A lease records that an agent *intends* to run a device, and which device it ended up with.
 * It is never the count: `evaluateDeviceOccupancy` counts running devices from `ps` and adds
 * only the leases that have no device yet, so a device nobody leased still fills a slot and a
 * lease whose device died stops filling one. See docs/device-leases.md.
 */

import type { DevicePlatform, RunningDevice } from "./device-detection.js";

export type DeviceLeaseSource = "checkout" | "launch";

export interface DeviceLease {
  id: string;
  agentId: string;
  platform: DevicePlatform;
  /** Free text from the agent: what it wants the device for. Shown in the UI and in denials. */
  reason?: string;
  /** "checkout" — the agent asked first. "launch" — the gate leased one on its behalf. */
  source: DeviceLeaseSource;
  acquiredAtMs: number;
  /** Set once reconciliation matches a running device to this lease. */
  deviceId?: string;
  /**
   * When the gate last saw this agent start the device it is waiting for. The never-started TTL
   * runs from here, falling back to `acquiredAtMs`: a cold `expo run:ios` spends its first
   * several minutes on pods and a native build, and a lease that expires mid-build hands the
   * slot to somebody else moments before the device it was holding it for appears.
   *
   * Deliberately a second clock rather than moving `acquiredAtMs` forward. That one is what
   * `startedAfterLease` binds against, so advancing it would put the device this lease is
   * waiting for in its own past and stop it binding at all.
   */
  lastLaunchAtMs?: number;
  /**
   * False for a lease only the dry run handed out — one the real cap would have made wait. It
   * still shows in the status readout, so the agent has a holder, but it must not fill a slot:
   * an agent waiting in a real run holds nothing, and counting it here would push occupancy
   * past the cap and make every later dry-run decision report a refusal the real run would
   * never have made. Absent means counted, which is every lease outside dry run.
   */
  counted?: boolean;
}

export type DeviceLeaseReleaseReason =
  | "released"
  | "device-stopped"
  | "never-started"
  | "agent-gone"
  | "expired";

export interface DeviceLeaseRelease {
  lease: DeviceLease;
  reason: DeviceLeaseReleaseReason;
}

export interface DeviceSlotCaps {
  totalSlots: number;
  slotsPerPlatform: number;
}

export interface DeviceOccupancy {
  /** Every slot in use: running devices plus leases still waiting for their device to appear. */
  total: number;
  byPlatform: Record<DevicePlatform, number>;
  runningDevices: number;
  pendingLeases: number;
}

function isPending(lease: DeviceLease): boolean {
  return lease.deviceId === undefined;
}

/** A pending lease that fills a slot. See DeviceLease's `counted`. */
function fillsSlot(lease: DeviceLease): boolean {
  return isPending(lease) && lease.counted !== false;
}

/**
 * Whether this device could be the one the lease went on to boot. A device that was already up
 * when the lease was taken cannot be: binding to it would hand the agent somebody else's
 * simulator, free the slot it is about to fill, and let it boot a device over the cap. Uptime
 * comes from `ps`'s elapsed column; a device that cannot report one is allowed to bind, since
 * refusing on a missing signal would strand the lease instead.
 */
function startedAfterLease(device: RunningDevice, lease: DeviceLease, nowMs: number): boolean {
  if (device.uptimeSeconds === undefined) return true;
  return nowMs - device.uptimeSeconds * 1000 >= lease.acquiredAtMs - DEVICE_START_SLACK_MS;
}

/**
 * Occupancy is the union of what is running and what has been promised, counted by device
 * identity so a bound lease and its device are one slot, not two.
 */
export function evaluateDeviceOccupancy(input: {
  runningDevices: readonly RunningDevice[];
  leases: readonly DeviceLease[];
}): DeviceOccupancy {
  const byPlatform: Record<DevicePlatform, number> = { ios: 0, android: 0 };
  const seenDeviceIds = new Set<string>();
  for (const device of input.runningDevices) {
    if (seenDeviceIds.has(device.deviceId)) continue;
    seenDeviceIds.add(device.deviceId);
    byPlatform[device.platform] += 1;
  }
  const pendingLeases = input.leases.filter(fillsSlot);
  for (const lease of pendingLeases) {
    byPlatform[lease.platform] += 1;
  }
  return {
    total: byPlatform.ios + byPlatform.android,
    byPlatform,
    runningDevices: seenDeviceIds.size,
    pendingLeases: pendingLeases.length,
  };
}

/**
 * Whether the guaranteed floor for a platform is still unfilled — nothing running, and nothing
 * pending either, since a lease waiting to become a device is about to fill the floor itself.
 * "The FIRST running device on each platform is always allowed" (docs/device-leases.md); this is
 * the check that decides whether a grant IS that first one.
 */
export function isPlatformFloorUnfilled(input: {
  platform: DevicePlatform;
  runningDevices: readonly RunningDevice[];
  leases: readonly DeviceLease[];
}): boolean {
  return evaluateDeviceOccupancy(input).byPlatform[input.platform] === 0;
}

/**
 * Case-insensitive whole-token match of `needle` inside `haystack`, so a UDID or AVD name found
 * inside a longer sentence counts but a name that is merely a substring of a longer word does
 * not (`pixel` must not match `pixel_7a`).
 */
function containsWholeToken(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9A-Za-z_-])${escaped}([^0-9A-Za-z_-]|$)`, "i").test(haystack);
}

/**
 * Picks the device a checkout or launch should bind to, out of what is already running and
 * unclaimed. "Prefer, in order: the device the caller names; a device matched by name in the
 * reason text, only if unambiguous; otherwise the longest-idle one nobody holds" — named-device
 * matching against an explicit `device` input lives in the caller, since only it knows whether
 * the name was a running device at all; this only does the reason-text and longest-idle legs.
 *
 * A device in a live agent's process tree is held by that agent even with no lease: it booted
 * the device without checking out, and is very likely mid-build on it. It is offered back to
 * that agent first and never to anybody else (`agentId` is only ever set for a live agent —
 * process attribution walks the trees of the agents the daemon knows about).
 */
export function selectReusableDevice(input: {
  platform: DevicePlatform;
  runningDevices: readonly RunningDevice[];
  leases: readonly DeviceLease[];
  reservedDeviceIds: ReadonlySet<string>;
  reason?: string;
  /** The agent asking. A device in its own process tree is its own; one in anybody else's isn't. */
  requesterAgentId?: string;
}): RunningDevice | undefined {
  const held = new Set(
    input.leases
      .filter((lease) => lease.deviceId !== undefined)
      .map((lease) => lease.deviceId as string),
  );
  const candidates = input.runningDevices.filter(
    (device) =>
      device.platform === input.platform &&
      !held.has(device.deviceId) &&
      !input.reservedDeviceIds.has(device.deviceId) &&
      (device.agentId === undefined || device.agentId === input.requesterAgentId),
  );
  if (candidates.length === 0) return undefined;

  const own = candidates.find((device) => device.agentId !== undefined);
  if (own) return own;

  if (input.reason) {
    const named = candidates.filter((device) =>
      containsWholeToken(input.reason as string, device.deviceId),
    );
    if (named.length === 1) return named[0];
  }

  return candidates.slice().sort((a, b) => (b.uptimeSeconds ?? 0) - (a.uptimeSeconds ?? 0))[0];
}

export type DeviceSlotVerdict =
  | { available: true }
  | { available: false; scope: "total" | "platform"; occupancy: DeviceOccupancy };

export function evaluateDeviceSlot(input: {
  platform: DevicePlatform;
  runningDevices: readonly RunningDevice[];
  leases: readonly DeviceLease[];
  caps: DeviceSlotCaps;
}): DeviceSlotVerdict {
  const occupancy = evaluateDeviceOccupancy(input);
  if (occupancy.byPlatform[input.platform] >= input.caps.slotsPerPlatform) {
    return { available: false, scope: "platform", occupancy };
  }
  if (occupancy.total >= input.caps.totalSlots) {
    return { available: false, scope: "total", occupancy };
  }
  return { available: true };
}

/**
 * How much clock skew between the `ps` sample and the lease clock to forgive when deciding
 * whether a device started after a lease was taken. One sweep's sampling jitter, no more.
 */
const DEVICE_START_SLACK_MS = 5_000;

export interface ReconcileDeviceLeasesInput {
  leases: readonly DeviceLease[];
  runningDevices: readonly RunningDevice[];
  /** Agents the daemon still knows about. A lease held by anything else is not held at all. */
  liveAgentIds: ReadonlySet<string>;
  nowMs: number;
  /** How long a lease may wait for its device to appear before it stops holding a slot. */
  pendingTtlMs: number;
  /** Backstop for a device that runs forever; 0 disables it. */
  maxLeaseMs: number;
}

export interface ReconcileDeviceLeasesResult {
  leases: DeviceLease[];
  released: DeviceLeaseRelease[];
  /** Devices running under nobody's lease — booted by hand, or by an agent that skipped the gate. */
  unleasedDevices: RunningDevice[];
}

/**
 * Binding, then expiry. A lease that has no device yet claims the first running device of its
 * platform that no other lease has claimed, preferring one whose process tree already belongs
 * to the leasing agent (true for an Android emulator, which stays a child of the agent's shell;
 * never true for a simulator, whose `launchd_sim` is reparented to pid 1 at boot). Among equals
 * the oldest lease binds first, which is also the order agents were let through the gate.
 */
export function reconcileDeviceLeases(
  input: ReconcileDeviceLeasesInput,
): ReconcileDeviceLeasesResult {
  const runningById = new Map(input.runningDevices.map((device) => [device.deviceId, device]));
  const claimedDeviceIds = new Set<string>();
  const leases: DeviceLease[] = [];
  const released: DeviceLeaseRelease[] = [];

  const release = (lease: DeviceLease, reason: DeviceLeaseReleaseReason) => {
    released.push({ lease, reason });
  };

  // Bound leases first, so a device already spoken for is never re-bound to somebody else.
  for (const lease of input.leases) {
    if (isPending(lease)) continue;
    if (!input.liveAgentIds.has(lease.agentId)) {
      release(lease, "agent-gone");
      continue;
    }
    if (!runningById.has(lease.deviceId as string)) {
      release(lease, "device-stopped");
      continue;
    }
    if (input.maxLeaseMs > 0 && input.nowMs - lease.acquiredAtMs >= input.maxLeaseMs) {
      release(lease, "expired");
      continue;
    }
    claimedDeviceIds.add(lease.deviceId as string);
    leases.push(lease);
  }

  const pending = input.leases
    .filter(isPending)
    .slice()
    .sort((a, b) => a.acquiredAtMs - b.acquiredAtMs)
    .filter((lease) => {
      if (input.liveAgentIds.has(lease.agentId)) return true;
      release(lease, "agent-gone");
      return false;
    });

  const boundLeaseIds = new Set<string>();
  const bind = (lease: DeviceLease, deviceId: string) => {
    claimedDeviceIds.add(deviceId);
    boundLeaseIds.add(lease.id);
    leases.push({ ...lease, deviceId });
  };

  // Attribution first, across every device: an Android emulator stays inside the process tree
  // of the agent that started it, and that agent's lease should get it even when somebody else
  // has been waiting longer. Doing this lease-first instead would hand the device to the oldest
  // waiter and leave its real owner holding a second slot.
  for (const device of input.runningDevices) {
    if (claimedDeviceIds.has(device.deviceId) || device.agentId === undefined) continue;
    const owner = pending.find(
      (lease) =>
        !boundLeaseIds.has(lease.id) &&
        lease.agentId === device.agentId &&
        lease.platform === device.platform &&
        startedAfterLease(device, lease, input.nowMs),
    );
    if (owner) bind(owner, device.deviceId);
  }

  for (const lease of pending) {
    if (boundLeaseIds.has(lease.id)) continue;
    // A simulator's launchd_sim belongs to no tree, so most leases bind here: oldest lease to
    // the first unclaimed device of its platform, which is the order agents passed the gate in.
    // Never a device in another live agent's process tree: that agent booted it, and binding it
    // here would hand its device to whoever happened to be waiting.
    const match = input.runningDevices.find(
      (device) =>
        device.platform === lease.platform &&
        !claimedDeviceIds.has(device.deviceId) &&
        (device.agentId === undefined || device.agentId === lease.agentId) &&
        startedAfterLease(device, lease, input.nowMs),
    );
    if (match) {
      bind(lease, match.deviceId);
      continue;
    }
    // Nothing booted yet. A lease that never turns into a device must not hold a slot forever:
    // the agent may have crashed between checking out and launching, or given up on its own.
    // Measured from the last launch the gate saw, so a long native build keeps its slot.
    if (input.nowMs - (lease.lastLaunchAtMs ?? lease.acquiredAtMs) >= input.pendingTtlMs) {
      release(lease, "never-started");
      continue;
    }
    leases.push(lease);
  }

  return {
    leases: leases.sort((a, b) => a.acquiredAtMs - b.acquiredAtMs),
    released,
    unleasedDevices: input.runningDevices.filter(
      (device) => !claimedDeviceIds.has(device.deviceId),
    ),
  };
}
