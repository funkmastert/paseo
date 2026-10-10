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
 * Waiting works as for the emulator cap: `checkout` with `wait` parks the agent until a device
 * frees (a check-in, the holder ending, a grace period running out) or its timeout passes.
 */

import {
  detectInstallCommandIntents,
  type InstallCommandIntent,
} from "./device-install-commands.js";
import {
  physicalDeviceMatches,
  reconcilePhysicalDeviceLeases,
  selectFreePhysicalDevice,
  type PhysicalDevice,
  type PhysicalDeviceLease,
  type PhysicalDevicePlatform,
  type PhysicalLeaseRelease,
} from "./physical-device-registry.js";
import {
  hasLiveCommands,
  type DeviceLaunchGateDecision,
  type DeviceLeaseAgentSummary,
} from "./device-lease-manager.js";
import { collectDeviceIdReferences, type DeviceIdReference } from "./device-detection.js";
import type { AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

const DEFAULT_GRACE_MINUTES = 30;
const DEFAULT_MAX_LEASE_HOURS = 12;
const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60_000;
/**
 * R1 (docs/plans/2026-10-09-002-fix-device-idle-release-plan.md): the same default the emulator
 * cap uses, since both read `idleReleaseMinutes` off the one shared `agents.deviceLeases` block.
 */
const DEFAULT_IDLE_RELEASE_MINUTES = 15;

/** Process evidence from one resource-monitor sweep (device-lease-manager.ts's DeviceUseEvidence,
 * duplicated here rather than imported — a phone lease has no RunningDevice to pair it with). */
interface PhysicalUseEvidence {
  rows: readonly ProcessSampleRow[];
  agentTrees: readonly AgentProcessTree[];
  references: ReadonlyMap<string, DeviceIdReference>;
}

/**
 * R2's "used", for a phone: the holder mid-turn, a live shell under its root, or any other
 * process naming the device's serial/UDID. Unlike a simulator or emulator, a physical device is
 * never itself a process in the sample — nothing to exclude as "the device's own pids" — so any
 * naming pid at all is somebody using it.
 */
function isPhysicalLeaseInUse(input: {
  lease: PhysicalDeviceLease;
  holder: DeviceLeaseAgentSummary | undefined;
  evidence: PhysicalUseEvidence | undefined;
}): boolean {
  const { evidence } = input;
  if (input.holder?.isRunning || !evidence) return true;
  const tree = evidence.agentTrees.find((entry) => entry.agentId === input.lease.agentId);
  // No tree at all is not evidence of nothing running — Codex's `app-server` and OpenCode's
  // shared `serve` never carry the `callerAgentId` marker attribution keys on
  // (docs/stalled-agents.md), so every non-Claude agent would otherwise read as permanently
  // idle. Treat a missing tree as inconclusive, the same as no evidence at all.
  if (!tree) return true;
  if (hasLiveCommands(evidence.rows, tree)) return true;
  return (evidence.references.get(input.lease.deviceId)?.pids.length ?? 0) > 0;
}
/** How often a waiting checkout looks again when nothing has notified it — a disconnect grace
 * period runs out without anybody calling in. */
const WAIT_RECHECK_MS = 5_000;
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
  /** Emulators adb sees as well. An untargeted `adb` command could mean any of them too, and
   * with more than one target adb refuses to pick on its own. Defaults to none. */
  countAndroidEmulators?: () => number;
  listAgents: () => readonly DeviceLeaseAgentSummary[];
  reservations: PhysicalDeviceReservations;
  readDaemonConfig: () => {
    deviceLeases?: { enabled?: boolean; dryRun?: boolean; idleReleaseMinutes?: number };
  };
  logger: PhysicalDeviceLeaseManagerLogger;
  now?: () => number;
  graceMinutes?: number;
  maxLeaseHours?: number;
  createLeaseId?: () => string;
}

let leaseCounter = 0;

export class PhysicalDeviceLeaseManager {
  private readonly listConnectedDevices: () => readonly PhysicalDevice[];
  private readonly countAndroidEmulators: () => number;
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
  private lastDetectionFingerprint: string;

  constructor(options: PhysicalDeviceLeaseManagerOptions) {
    this.listConnectedDevices = options.listConnectedDevices;
    this.countAndroidEmulators = options.countAndroidEmulators ?? (() => 0);
    this.listAgents = options.listAgents;
    this.reservations = options.reservations;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.graceMs = (options.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;
    this.maxLeaseMs = (options.maxLeaseHours ?? DEFAULT_MAX_LEASE_HOURS) * 3_600_000;
    this.createLeaseId = options.createLeaseId ?? (() => `physical-${++leaseCounter}`);
    this.lastDetectionFingerprint = this.connectedFingerprint();
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

  /**
   * Called by AdbTrackDevicesService's and DevicectlPollingService's `onDevicesChanged`, and by
   * PhysicalDeviceDetection's `onStopped` — the only way this manager hears about a connect, a
   * disconnect, or a Wi-Fi iPhone's idle flip. Reconciles right away, so a disconnect starts its
   * grace clock now rather than waiting for the next checkout or install-gate call, then notifies
   * only if the connected list actually changed: devicectl polls every 15s with identical
   * results, and every notify pushes a device_status_update to every subscribed client.
   */
  detectionChanged(): void {
    const leasesChanged = this.reconcile();
    const fingerprint = this.connectedFingerprint();
    const fingerprintChanged = fingerprint !== this.lastDetectionFingerprint;
    this.lastDetectionFingerprint = fingerprint;
    // reconcile() already notified for a lease it changed (a disconnect starting the grace
    // clock, an expiry). Don't notify twice for the same event.
    if (fingerprintChanged && !leasesChanged) this.notify();
  }

  /**
   * KTD-3 (docs/plans/2026-10-09-002-fix-device-idle-release-plan.md): the resource-monitor
   * sweep's `ps` sample, the only process evidence a phone lease has — this manager has no `ps`
   * sampler of its own, since detection is push-based (adb's `track-devices`, a devicectl poll).
   * Between sweeps the idle check uses this sweep's verdict; it never takes a fresh sample.
   */
  reportProcessSample(input: {
    rows: readonly ProcessSampleRow[];
    agentTrees: readonly AgentProcessTree[];
  }): void {
    this.reconcile();
    this.releaseIdleLeases(input);
  }

  /**
   * R1, R2, R4, R6: a phone lease nothing has used for `idleReleaseMinutes` is released, reason
   * `idle`, so an install lease a finished agent forgot to check in comes back on its own.
   * Releasing costs the agent nothing it was using — a phone has no slot to free, only a holder
   * to clear.
   */
  private releaseIdleLeases(sample: {
    rows: readonly ProcessSampleRow[];
    agentTrees: readonly AgentProcessTree[];
  }): void {
    const idleReleaseMs =
      (this.readDaemonConfig().deviceLeases?.idleReleaseMinutes ?? DEFAULT_IDLE_RELEASE_MINUTES) *
      60_000;
    if (idleReleaseMs <= 0) return;
    const agentsById = new Map(this.listAgents().map((agent) => [agent.agentId, agent]));
    const knownDeviceIds = this.leases.map((lease) => lease.deviceId);
    const references = collectDeviceIdReferences(sample.rows, knownDeviceIds);
    const idle: PhysicalDeviceLease[] = [];
    for (const lease of this.leases) {
      const inUse = isPhysicalLeaseInUse({
        lease,
        holder: agentsById.get(lease.agentId),
        evidence: { ...sample, references },
      });
      if (inUse || lease.lastUsedAtMs === undefined) {
        lease.lastUsedAtMs = this.now();
        continue;
      }
      if (this.now() - lease.lastUsedAtMs >= idleReleaseMs) idle.push(lease);
    }
    if (idle.length === 0) return;
    if (this.isDryRun()) {
      for (const lease of idle) {
        lease.lastUsedAtMs = this.now();
        this.logger.info(
          { dryRun: true, leaseId: lease.id, agentId: lease.agentId, deviceId: lease.deviceId },
          "Would release an idle device lease",
        );
      }
      return;
    }
    this.leases = this.leases.filter((lease) => !idle.includes(lease));
    this.logRelease(idle.map((lease) => ({ lease, reason: "idle" as const })));
    this.notify();
  }

  private connectedFingerprint(): string {
    return this.listConnectedDevices()
      .map(
        (device) =>
          `${device.id}|${device.platform}|${device.transport}|${device.idle ? "1" : "0"}|${device.name ?? ""}`,
      )
      .sort()
      .join(";");
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

  /** Returns whether any lease changed, so a caller that already notified for it (detectionChanged)
   * can skip a redundant second notify. */
  private reconcile(): boolean {
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
    return changed;
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
    /** Wait for the device (or any free one) instead of being told there is none. */
    wait?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<PhysicalDeviceCheckoutResult> {
    if (!this.isEnabled()) return { status: "disabled" };
    const deadline = this.now() + (input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    for (;;) {
      const attempt = this.tryCheckout(input);
      if (attempt.status !== "unavailable" || !input.wait || attempt.final) {
        const { final: _final, ...result } = attempt;
        return result;
      }
      if (input.signal?.aborted) {
        return {
          status: "unavailable",
          platform: input.platform,
          message: "The wait was canceled.",
        };
      }
      if (this.now() >= deadline) {
        return {
          status: "unavailable",
          platform: input.platform,
          message: `Waited and nothing came free: ${attempt.message}`,
        };
      }
      await this.nextChange(input.signal);
      if (!this.isEnabled()) return { status: "disabled" };
    }
  }

  /** Resolves on the next lease change, after WAIT_RECHECK_MS, or on abort — whichever first. */
  private async nextChange(signal: AbortSignal | undefined): Promise<void> {
    let finish: () => void = () => undefined;
    const changed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => finish(), WAIT_RECHECK_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    const unsubscribe = this.subscribe(() => finish());
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await changed;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private tryCheckout(input: {
    agentId: string;
    platform: PhysicalDevicePlatform;
    device?: string;
    reason?: string;
  }): PhysicalDeviceCheckoutResult & { final?: boolean } {
    this.reconcile();
    const connected = this.listConnectedDevices();
    if (input.device) {
      const target = input.device;
      const named = connected.find((device) => physicalDeviceMatches(device, target));
      const lease = named ? this.leases.find((entry) => entry.deviceId === named.id) : undefined;
      if (named && lease?.agentId === input.agentId) {
        lease.lastUsedAtMs = this.now();
        return {
          status: "granted",
          leaseId: lease.id,
          platform: named.platform,
          device: this.describeDevice(named),
        };
      }
      if (named && this.reservations.isReserved(named.id) && !lease) {
        return {
          status: "unavailable",
          platform: input.platform,
          message: `${named.name ?? named.id} is reserved for Tyler, so it is never handed to an agent`,
          final: true,
        };
      }
      if (named && lease) {
        return {
          status: "unavailable",
          platform: input.platform,
          message:
            `${named.name ?? named.id} is held by ${this.describeAgent(lease.agentId)}. Call ` +
            `device_checkout with kind "physical", this device and \`wait: true\` to get it ` +
            `when it is checked in`,
        };
      }
    }
    const device = selectFreePhysicalDevice({
      platform: input.platform,
      ...(input.device ? { namedDeviceId: input.device } : {}),
      connectedDevices: connected,
      leases: this.leases,
      reservedDeviceIds: this.reservations.reservedDeviceIds(),
    });
    if (!device) {
      // Waiting only makes sense for a device somebody holds. With nothing of the platform
      // connected there is nothing to wait for — a phone being plugged in isn't a check-in.
      const anyConnected = connected.some((entry) => entry.platform === input.platform);
      let message = `no ${input.platform} device is connected`;
      if (input.device) message = `${input.device} is not a connected ${input.platform} device`;
      else if (anyConnected) message = `no free ${input.platform} device is connected`;
      return {
        status: "unavailable",
        platform: input.platform,
        message,
        ...(anyConnected ? {} : { final: true }),
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
      platform: device.platform,
      device: this.describeDevice(device),
    };
  }

  private describeAgent(agentId: string): string {
    const title = this.listAgents().find((agent) => agent.agentId === agentId)?.title;
    return title ? `"${title}" (${agentId})` : agentId;
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
      const target = intent.target;
      const device = candidates.find((entry) => physicalDeviceMatches(entry, target));
      // Names a device this gate doesn't currently see connected — an emulator, a simulator, or
      // nothing at all: nothing here to protect.
      return device ? this.resolveDeviceAccess(agentId, device, intent) : undefined;
    }

    if (candidates.length === 0) return undefined;
    // A plain `adb` command with more than one device attached refuses to pick one on its own,
    // so it can't install over anybody — unless an ANDROID_SERIAL the gate can't see (the
    // agent's shell profile) points it somewhere, and then it is a good command. Let adb decide.
    const adbTargets =
      intent.platform === "android" ? candidates.length + this.countAndroidEmulators() : 0;
    if (intent.command.startsWith("adb ") && adbTargets > 1) return undefined;
    if (candidates.length === 1) {
      return this.resolveDeviceAccess(agentId, candidates[0] as PhysicalDevice, intent);
    }
    const platformLabel = intent.platform === "unknown" ? "" : `${intent.platform} `;
    const fixes = candidates.map((device) => `\`${targetingFix(intent, device)}\``).join(" or ");
    return (
      `\`${intent.command}\` does not target a device, and ${candidates.length} ${platformLabel}` +
      `devices are connected (${candidates.map((device) => device.name ?? device.id).join(", ")}) — ` +
      `${intent.installsOnAllIfUntargeted ? "it would install on all of them" : "it could pick any of them"}, ` +
      `including another agent's. Name the device you hold: ${fixes}. \`device_checkout\` with ` +
      `kind "physical" gets you one.`
    );
  }

  private resolveDeviceAccess(
    agentId: string,
    device: PhysicalDevice,
    intent: InstallCommandIntent,
  ): string | undefined {
    const lease = this.leases.find((entry) => entry.deviceId === device.id);
    // Whoever holds it keeps using it: reserving a device doesn't evict its holder.
    if (lease?.agentId === agentId) {
      lease.lastUsedAtMs = this.now();
      return undefined;
    }
    const label = device.name ?? device.id;
    if (lease) {
      const harm = intent.stateOnly
        ? "it would change the app state of another agent's device"
        : "installing over another agent's device is exactly what this gate exists to stop";
      return (
        `${label} is held by ${this.describeAgent(lease.agentId)}. \`${intent.command}\` was not ` +
        `run — ${harm}. ` +
        `Call device_checkout with kind "physical", this device and \`wait: true\` to get it ` +
        `when it is checked in, or target a different device.`
      );
    }
    // Force-stopping an app on a free device changes nothing anybody is relying on, and is no
    // reason to claim the device.
    if (intent.stateOnly) return undefined;
    if (this.reservations.isReserved(device.id)) {
      return `${label} is reserved for Tyler. \`${intent.command}\` was not run.`;
    }
    this.bindLease({ agentId, device, source: "install" });
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
      const lease = leaseByDeviceId.get(device.id);
      // A phone that is only paired and on the same Wi-Fi is not a device anyone is using.
      const claimed = lease !== undefined || reservedIds.has(device.id);
      if (device.idle && !claimed) continue;
      devices.push(this.toEntry(device, lease, true, nowMs, reservedIds));
    }
    for (const lease of this.leases) {
      if (seen.has(lease.deviceId)) continue;
      devices.push(
        this.toEntry(
          {
            id: lease.deviceId,
            platform: lease.platform,
            transport: lease.transport ?? "usb",
            ...(lease.name ? { name: lease.name } : {}),
          },
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
      lastUsedAtMs: this.now(),
      transport: input.device.transport,
      ...(input.device.name ? { name: input.device.name } : {}),
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

/** The exact command shape that targets this device, for a refusal to paste. */
function targetingFix(intent: InstallCommandIntent, device: PhysicalDevice): string {
  if (device.platform === "android") {
    return intent.command.startsWith("adb ")
      ? `adb -s ${device.id} …`
      : `ANDROID_SERIAL=${device.id} ${intent.command}`;
  }
  if (intent.command === "ios-deploy") return `ios-deploy --id ${device.id} …`;
  if (intent.command.startsWith("xcodebuild")) return `-destination 'id=${device.id}'`;
  return `--device ${device.id}`;
}
