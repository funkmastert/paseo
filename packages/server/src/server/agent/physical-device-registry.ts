/**
 * The lease table for physical devices and what a sweep does to it — the physical-device analog
 * of device-lease-registry.ts, with one real difference: a physical device costs the Mac no
 * memory or slot, so there is no occupancy/cap concept here at all, only who holds which device.
 * Pure: no timers, no process spawning, no id generation (physical-device-lease-manager.ts owns
 * those). See docs/device-leases.md, Physical devices.
 */

export type PhysicalDevicePlatform = "ios" | "android";
export type PhysicalDeviceTransport = "usb" | "network";

export interface PhysicalDevice {
  /** adb serial (Android) or devicectl UDID (iOS). Stable across a single connection. */
  id: string;
  platform: PhysicalDevicePlatform;
  name?: string;
  transport: PhysicalDeviceTransport;
  /** Other names a command may use for this device: an iPhone's CoreDevice identifier and the
   * name its owner gave it. */
  aliases?: readonly string[];
  /** A Wi-Fi iPhone that is reachable but not in use (device-devicectl.ts). Still a target for
   * checkout and the install gate; the status list leaves it out unless someone holds or
   * reserved it. */
  idle?: boolean;
}

/** Model names come from adb with underscores (`Pixel_9_Pro_XL`); people and CLIs write them
 * with spaces. Compared case-insensitively, like devicectl and xcodebuild compare them. */
function normalizeDeviceName(name: string): string {
  return name.replace(/_/g, " ").trim().toLowerCase();
}

/** Whether a command's device selector names this device: its serial/UDID, model name, or one
 * of its aliases. */
export function physicalDeviceMatches(device: PhysicalDevice, target: string): boolean {
  if (device.id === target) return true;
  if (device.platform === "ios" && device.id.toLowerCase() === target.toLowerCase()) return true;
  const wanted = normalizeDeviceName(target);
  return [device.name, ...(device.aliases ?? [])].some(
    (name) => name !== undefined && normalizeDeviceName(name) === wanted,
  );
}

export type PhysicalLeaseSource = "checkout" | "install";

export interface PhysicalDeviceLease {
  id: string;
  deviceId: string;
  platform: PhysicalDevicePlatform;
  agentId: string;
  reason?: string;
  source: PhysicalLeaseSource;
  acquiredAtMs: number;
  /** What the device was called and how it was connected when leased, so a row for a device
   * that has gone away still reads as that device. */
  name?: string;
  transport?: PhysicalDeviceTransport;
  /**
   * Set the moment a sweep first finds the device gone; cleared the moment it is seen again.
   * The lease survives a disconnect until `nowMs - disconnectedAtMs >= graceMs` — phones get
   * unplugged and re-paired constantly, and dropping the holder on the first missed poll would
   * hand a mid-session device to the next agent that asks.
   */
  disconnectedAtMs?: number;
  /**
   * When R2's "used" was last seen for this lease: the holder mid-turn, a live shell under its
   * root, or another process naming the device id. Set at bind, advanced by the owning
   * manager's sweep (the resource monitor's `ps` sample, the only process evidence a phone
   * lease has) and on a checkout or install-gate decision that touches this lease
   * (docs/device-leases.md#physical-devices).
   */
  lastUsedAtMs?: number;
}

export type PhysicalLeaseReleaseReason =
  | "released"
  | "device-disconnected"
  | "agent-gone"
  | "expired"
  | "idle";

export interface PhysicalLeaseRelease {
  lease: PhysicalDeviceLease;
  reason: PhysicalLeaseReleaseReason;
}

export interface ReconcilePhysicalLeasesInput {
  leases: readonly PhysicalDeviceLease[];
  connectedDeviceIds: ReadonlySet<string>;
  /** Agents the daemon still knows about; a lease held by anything else is not held at all. */
  liveAgentIds: ReadonlySet<string>;
  nowMs: number;
  /** How long a lease survives its device being gone from the live scan. */
  graceMs: number;
  /** Backstop for a device leased forever; 0 disables it. */
  maxLeaseMs: number;
}

export interface ReconcilePhysicalLeasesResult {
  leases: PhysicalDeviceLease[];
  released: PhysicalLeaseRelease[];
}

/**
 * Agent-gone and the max-lease backstop first (same order device-lease-registry.ts uses), then
 * connectivity: still connected clears any pending disconnect timer; gone starts or continues
 * one, releasing only once the grace window has actually elapsed.
 */
export function reconcilePhysicalDeviceLeases(
  input: ReconcilePhysicalLeasesInput,
): ReconcilePhysicalLeasesResult {
  const leases: PhysicalDeviceLease[] = [];
  const released: PhysicalLeaseRelease[] = [];

  for (const lease of input.leases) {
    if (!input.liveAgentIds.has(lease.agentId)) {
      released.push({ lease, reason: "agent-gone" });
      continue;
    }
    if (input.maxLeaseMs > 0 && input.nowMs - lease.acquiredAtMs >= input.maxLeaseMs) {
      released.push({ lease, reason: "expired" });
      continue;
    }
    if (input.connectedDeviceIds.has(lease.deviceId)) {
      leases.push(
        lease.disconnectedAtMs === undefined ? lease : { ...lease, disconnectedAtMs: undefined },
      );
      continue;
    }
    const disconnectedAtMs = lease.disconnectedAtMs ?? input.nowMs;
    if (input.nowMs - disconnectedAtMs >= input.graceMs) {
      released.push({ lease, reason: "device-disconnected" });
      continue;
    }
    leases.push(
      lease.disconnectedAtMs === disconnectedAtMs ? lease : { ...lease, disconnectedAtMs },
    );
  }

  return { leases, released };
}

/**
 * The device a checkout should bind to: the one named, when it is connected, free and
 * unreserved; otherwise the longest-connected free, unreserved device of the platform (there is
 * no memory cost to weigh, so "longest connected" is just a stable, unsurprising tie-break —
 * the same device an agent asking twice in a row gets both times). A phone in use goes before
 * an idle one: an idle Wi-Fi iPhone is most likely the one in Tyler's pocket.
 */
export function selectFreePhysicalDevice(input: {
  platform: PhysicalDevicePlatform;
  namedDeviceId?: string;
  connectedDevices: readonly PhysicalDevice[];
  leases: readonly PhysicalDeviceLease[];
  reservedDeviceIds: ReadonlySet<string>;
}): PhysicalDevice | undefined {
  const held = new Set(input.leases.map((lease) => lease.deviceId));
  if (input.namedDeviceId) {
    const target = input.namedDeviceId;
    const named = input.connectedDevices.find((device) => physicalDeviceMatches(device, target));
    if (!named || held.has(named.id) || input.reservedDeviceIds.has(named.id)) return undefined;
    return named;
  }
  const free = input.connectedDevices
    .filter(
      (device) =>
        device.platform === input.platform &&
        !held.has(device.id) &&
        !input.reservedDeviceIds.has(device.id),
    )
    .sort((a, b) => Number(a.idle ?? false) - Number(b.idle ?? false) || a.id.localeCompare(b.id));
  return free[0];
}
