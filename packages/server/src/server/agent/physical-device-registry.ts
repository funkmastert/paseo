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
  /**
   * Set the moment a sweep first finds the device gone; cleared the moment it is seen again.
   * The lease survives a disconnect until `nowMs - disconnectedAtMs >= graceMs` — phones get
   * unplugged and re-paired constantly, and dropping the holder on the first missed poll would
   * hand a mid-session device to the next agent that asks.
   */
  disconnectedAtMs?: number;
}

export type PhysicalLeaseReleaseReason =
  | "released"
  | "device-disconnected"
  | "agent-gone"
  | "expired";

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
 * the same device an agent asking twice in a row gets both times).
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
    const named = input.connectedDevices.find((device) => device.id === input.namedDeviceId);
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
    .sort((a, b) => a.id.localeCompare(b.id));
  return free[0];
}
