/**
 * Leases for physical devices — a USB Pixel, an iPhone paired over the network — outside the
 * emulator/simulator slot cap and its headroom rules entirely: a phone costs the Mac no memory.
 * The point is narrower than the cap: stop one agent's `adb install` from overwriting another
 * agent's install on the same phone. See docs/device-leases.md, Physical devices.
 *
 * Shares two things with DeviceLeaseManager rather than duplicating them: the `agents.deviceLeases`
 * enabled/dryRun toggle (one switch for the whole device-management feature), and the
 * DeviceReservations store (a reservation is just a deviceId, physical or not).
 *
 * No waiting queue: `checkout` with nothing free returns `unavailable` immediately rather than
 * parking the agent the way the emulator cap's `device_checkout` does. A physical device doesn't
 * free up on its own the way a slot does when a device stops, so there's nothing worth waiting
 * for — the agent is told to ask again once the device is free. See docs/device-leases.md for
 * why this is a scoped-down corner of "waiting works as for the emulator cap".
 */

import {
  detectInstallCommandIntents,
  type InstallCommandIntent,
} from "./device-install-commands.js";
import {
  reconcilePhysicalDeviceLeases,
  selectFreePhysicalDevice,
  type PhysicalDevice,
  type PhysicalDeviceLease,
  type PhysicalDevicePlatform,
  type PhysicalLeaseRelease,
} from "./physical-device-registry.js";
import type { DeviceLaunchGateDecision, DeviceLeaseAgentSummary } from "./device-lease-manager.js";

const DEFAULT_GRACE_MINUTES = 30;
const DEFAULT_MAX_LEASE_HOURS = 12;
const BLOCKED_HISTORY_LIMIT = 10;

export interface PhysicalDeviceReservations {
  reservedDeviceIds(): ReadonlySet<string>;
  isReserved(deviceId: string): boolean;
}

export interface PhysicalDeviceCheckoutDeviceInfo {
  id: string;
  name?: string;
  platform: PhysicalDevicePlatform;
  transport: "usb" | "network";
  /** How to run a command against this device, ready to paste. */
  targetHint: string;
}

export type PhysicalDeviceCheckoutResult =
  | { status: "disabled" }
  | {
      status: "granted";
      leaseId: string;
      platform: PhysicalDevicePlatform;
      device: PhysicalDeviceCheckoutDeviceInfo;
    }
  | { status: "unavailable"; platform: PhysicalDevicePlatform; message: string };

export interface PhysicalDeviceStatusEntry {
  id: string;
  platform: PhysicalDevicePlatform;
  name?: string;
  transport: "usb" | "network";
  connected: boolean;
  /** Seconds until the lease releases on its own, for a disconnected-but-still-held device. */
  graceRemainingSeconds?: number;
  agentId?: string;
  heldForSeconds?: number;
  reason?: string;
  reserved: boolean;
}

export interface PhysicalDeviceStatusBlocked {
  agentId: string;
  command: string;
  message: string;
  dryRun: boolean;
  at: string;
}

export interface PhysicalDeviceStatusSnapshot {
  enabled: boolean;
  dryRun: boolean;
  devices: PhysicalDeviceStatusEntry[];
  blocked: PhysicalDeviceStatusBlocked[];
  generatedAt: string;
}

interface PhysicalDeviceLeaseManagerLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface PhysicalDeviceLeaseManagerOptions {
  /** The live detection services' current view — never polled here directly. */
  listConnectedDevices: () => readonly PhysicalDevice[];
  listAgents: () => readonly DeviceLeaseAgentSummary[];
  reservations: PhysicalDeviceReservations;
  readDaemonConfig: () => { deviceLeases?: { enabled?: boolean; dryRun?: boolean } };
  logger: PhysicalDeviceLeaseManagerLogger;
  now?: () => number;
  graceMinutes?: number;
  maxLeaseHours?: number;
  createLeaseId?: () => string;
}

let leaseCounter = 0;

export class PhysicalDeviceLeaseManager {
  private readonly listConnectedDevices: () => readonly PhysicalDevice[];
  private readonly listAgents: () => readonly DeviceLeaseAgentSummary[];
  private readonly reservations: PhysicalDeviceReservations;
  private readonly readDaemonConfig: PhysicalDeviceLeaseManagerOptions["readDaemonConfig"];
  private readonly logger: PhysicalDeviceLeaseManagerLogger;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxLeaseMs: number;
  private readonly createLeaseId: () => string;

  private leases: PhysicalDeviceLease[] = [];
  private blocked: PhysicalDeviceStatusBlocked[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(options: PhysicalDeviceLeaseManagerOptions) {
    this.listConnectedDevices = options.listConnectedDevices;
    this.listAgents = options.listAgents;
    this.reservations = options.reservations;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.graceMs = (options.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;
    this.maxLeaseMs = (options.maxLeaseHours ?? DEFAULT_MAX_LEASE_HOURS) * 3_600_000;
    this.createLeaseId = options.createLeaseId ?? (() => `physical-${++leaseCounter}`);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Same reason as DeviceLeaseManager.refreshSnapshot: a daemon-config edit to the shared
   * agents.deviceLeases toggle doesn't otherwise make this push a fresh update on its own. */
  refreshSnapshot(): void {
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn({ err: error }, "Physical device status listener failed");
      }
    }
  }

  private isEnabled(): boolean {
    return this.readDaemonConfig().deviceLeases?.enabled ?? false;
  }

  private isDryRun(): boolean {
    return this.readDaemonConfig().deviceLeases?.dryRun ?? false;
  }

  private reconcile(): void {
    const connected = this.listConnectedDevices();
    const result = reconcilePhysicalDeviceLeases({
      leases: this.leases,
      connectedDeviceIds: new Set(connected.map((device) => device.id)),
      liveAgentIds: new Set(this.listAgents().map((agent) => agent.agentId)),
      nowMs: this.now(),
      graceMs: this.graceMs,
      maxLeaseMs: this.maxLeaseMs,
    });
    const changed =
      result.released.length > 0 ||
      result.leases.length !== this.leases.length ||
      result.leases.some((lease, index) => lease !== this.leases[index]);
    this.leases = result.leases;
    if (result.released.length > 0) this.logRelease(result.released);
    if (changed) this.notify();
  }

  private logRelease(released: readonly PhysicalLeaseRelease[]): void {
    for (const entry of released) {
      this.logger.info(
        {
          leaseId: entry.lease.id,
          deviceId: entry.lease.deviceId,
          agentId: entry.lease.agentId,
          reason: entry.reason,
        },
        "Physical device lease released",
      );
    }
  }

  async checkout(input: {
    agentId: string;
    platform: PhysicalDevicePlatform;
    device?: string;
    reason?: string;
  }): Promise<PhysicalDeviceCheckoutResult> {
    if (!this.isEnabled()) return { status: "disabled" };
    this.reconcile();

    const connected = this.listConnectedDevices();
    const device = selectFreePhysicalDevice({
      platform: input.platform,
      ...(input.device ? { namedDeviceId: input.device } : {}),
      connectedDevices: connected,
      leases: this.leases,
      reservedDeviceIds: this.reservations.reservedDeviceIds(),
    });
    if (!device) {
      return {
        status: "unavailable",
        platform: input.platform,
        message: input.device
          ? `${input.device} is not a connected, free, unreserved ${input.platform} device`
          : `no free ${input.platform} device is connected`,
      };
    }

    const lease = this.bindLease({
      agentId: input.agentId,
      device,
      source: "checkout",
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return {
      status: "granted",
      leaseId: lease.id,
      platform: input.platform,
      device: this.describeDevice(device),
    };
  }

  /** Without a lease id, every physical lease this agent holds is released. */
  async checkin(input: { agentId: string; leaseId?: string }): Promise<number> {
    const released = this.leases.filter(
      (lease) =>
        lease.agentId === input.agentId &&
        (input.leaseId === undefined || lease.id === input.leaseId),
    );
    if (released.length === 0) return 0;
    this.leases = this.leases.filter((lease) => !released.includes(lease));
    this.logRelease(released.map((lease) => ({ lease, reason: "released" as const })));
    this.notify();
    return released.length;
  }

  releaseLeaseForDevice(deviceId: string): boolean {
    const lease = this.leases.find((entry) => entry.deviceId === deviceId);
    if (!lease) return false;
    this.leases = this.leases.filter((entry) => entry.id !== lease.id);
    this.logRelease([{ lease, reason: "released" }]);
    this.notify();
    return true;
  }

  /**
   * The enforcement point for install/uninstall/launch commands. Unlike `gateLaunch`'s slot cap,
   * there is nothing to allocate here: a free device is leased to the agent on the spot and the
   * command proceeds; a held or reserved device denies (or, in dry run, records and proceeds);
   * an untargeted command that could hit more than one connected device of its platform denies
   * too, since the gate cannot know which one the caller meant to protect.
   */
  async gateInstall(input: {
    agentId: string;
    command: string;
  }): Promise<DeviceLaunchGateDecision> {
    const intents = detectInstallCommandIntents(input.command);
    if (intents.length === 0) return { decision: "allow" };
    if (!this.isEnabled()) return { decision: "allow" };
    this.reconcile();

    const dryRun = this.isDryRun();
    const connected = this.listConnectedDevices();
    for (const intent of intents) {
      const decision = this.gateIntent(input.agentId, intent, connected);
      if (!decision) continue;
      this.recordBlocked({
        agentId: input.agentId,
        command: intent.command,
        message: decision,
        dryRun,
        at: new Date(this.now()).toISOString(),
      });
      if (dryRun) continue;
      return { decision: "deny", message: decision };
    }
    return { decision: "allow" };
  }

  private gateIntent(
    agentId: string,
    intent: InstallCommandIntent,
    connected: readonly PhysicalDevice[],
  ): string | undefined {
    const candidates =
      intent.platform === "unknown"
        ? connected
        : connected.filter((device) => device.platform === intent.platform);

    if (intent.target) {
      const device = candidates.find((entry) => entry.id === intent.target);
      // Names a device this gate doesn't currently see connected: nothing here to protect, and
      // the command itself will fail against a device that isn't there.
      return device ? this.resolveDeviceAccess(agentId, device, intent) : undefined;
    }

    if (candidates.length === 0) return undefined;
    if (candidates.length === 1 && !intent.installsOnAllIfUntargeted) {
      // Exactly one candidate: an untargeted adb/expo/etc. command can only mean this one.
      return this.resolveDeviceAccess(agentId, candidates[0] as PhysicalDevice, intent);
    }
    if (candidates.length === 1) {
      // installsOnAllIfUntargeted (gradle) still only touches the one connected device.
      return this.resolveDeviceAccess(agentId, candidates[0] as PhysicalDevice, intent);
    }
    const platformLabel = intent.platform === "unknown" ? "" : `${intent.platform} `;
    return (
      `\`${intent.command}\` does not target a device, and ${candidates.length} ${platformLabel}` +
      `devices are connected (${candidates.map((device) => device.id).join(", ")}) — ` +
      `${intent.installsOnAllIfUntargeted ? "it would install on all of them" : "it could pick any of them"}.`
    );
  }

  private resolveDeviceAccess(
    agentId: string,
    device: PhysicalDevice,
    intent: InstallCommandIntent,
  ): string | undefined {
    if (this.reservations.isReserved(device.id)) {
      return `${device.name ?? device.id} is reserved for Tyler. \`${intent.command}\` was not run.`;
    }
    const lease = this.leases.find((entry) => entry.deviceId === device.id);
    if (lease && lease.agentId !== agentId) {
      return (
        `${device.name ?? device.id} is held by ${lease.agentId}. \`${intent.command}\` was not run ` +
        `— installing over another agent's device is exactly what this gate exists to stop. ` +
        `Call device_checkout with kind "physical" and wait for it to free up, or target a different device.`
      );
    }
    if (!lease) {
      this.bindLease({ agentId, device, source: "install" });
    }
    return undefined;
  }

  async getSnapshot(): Promise<PhysicalDeviceStatusSnapshot> {
    this.reconcile();
    const nowMs = this.now();
    const connected = this.listConnectedDevices();
    const reservedIds = this.reservations.reservedDeviceIds();
    const leaseByDeviceId = new Map(this.leases.map((lease) => [lease.deviceId, lease] as const));

    const seen = new Set<string>();
    const devices: PhysicalDeviceStatusEntry[] = [];
    for (const device of connected) {
      seen.add(device.id);
      devices.push(this.toEntry(device, leaseByDeviceId.get(device.id), true, nowMs, reservedIds));
    }
    for (const lease of this.leases) {
      if (seen.has(lease.deviceId)) continue;
      devices.push(
        this.toEntry(
          { id: lease.deviceId, platform: lease.platform, transport: "usb" },
          lease,
          false,
          nowMs,
          reservedIds,
        ),
      );
    }

    return {
      enabled: this.isEnabled(),
      dryRun: this.isDryRun(),
      devices,
      blocked: this.blocked,
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  private toEntry(
    device: PhysicalDevice,
    lease: PhysicalDeviceLease | undefined,
    connected: boolean,
    nowMs: number,
    reservedIds: ReadonlySet<string>,
  ): PhysicalDeviceStatusEntry {
    const entry: PhysicalDeviceStatusEntry = {
      id: device.id,
      platform: device.platform,
      transport: device.transport === "network" ? "network" : "usb",
      connected,
      reserved: reservedIds.has(device.id),
    };
    if (device.name) entry.name = device.name;
    if (lease) {
      entry.agentId = lease.agentId;
      entry.heldForSeconds = (nowMs - lease.acquiredAtMs) / 1000;
      if (lease.reason) entry.reason = lease.reason;
      if (lease.disconnectedAtMs !== undefined) {
        entry.graceRemainingSeconds = Math.max(
          0,
          (lease.disconnectedAtMs + this.graceMs - nowMs) / 1000,
        );
      }
    }
    return entry;
  }

  private describeDevice(device: PhysicalDevice): PhysicalDeviceCheckoutDeviceInfo {
    const targetHint =
      device.platform === "android"
        ? `adb -s ${device.id} <command> (or ANDROID_SERIAL=${device.id})`
        : `--device ${device.id}  /  -destination 'id=${device.id}'`;
    return {
      id: device.id,
      platform: device.platform,
      transport: device.transport === "network" ? "network" : "usb",
      targetHint,
      ...(device.name ? { name: device.name } : {}),
    };
  }

  private bindLease(input: {
    agentId: string;
    device: PhysicalDevice;
    source: PhysicalDeviceLease["source"];
    reason?: string;
  }): PhysicalDeviceLease {
    const lease: PhysicalDeviceLease = {
      id: this.createLeaseId(),
      deviceId: input.device.id,
      platform: input.device.platform,
      agentId: input.agentId,
      source: input.source,
      acquiredAtMs: this.now(),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.leases.push(lease);
    this.logger.info(
      {
        leaseId: lease.id,
        deviceId: input.device.id,
        agentId: input.agentId,
        source: input.source,
      },
      "Physical device leased",
    );
    this.notify();
    return lease;
  }

  private recordBlocked(entry: PhysicalDeviceStatusBlocked): void {
    this.blocked = [entry, ...this.blocked].slice(0, BLOCKED_HISTORY_LIMIT);
    this.notify();
  }
}
