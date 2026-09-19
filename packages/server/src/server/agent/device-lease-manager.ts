/**
 * Daemon-owned cap on how many iOS simulators and Android emulators run at once, across every
 * agent. Only the daemon sees all of them, so only the daemon can hold the count.
 *
 * Three layers, with separate jobs (docs/device-leases.md):
 *   - the process scan is the count. `detectRunningDevices` reads the `ps` sample
 *     AgentResourceMonitor already takes, so a device Tyler booted by hand counts too.
 *   - a lease is intent. `checkout` records who wants a device and why, and queues rather than
 *     refusing when the cap is full — the work is usually right, just early.
 *   - the launch gate is enforcement. An agent that boots a device without checking out is
 *     refused at the tool call and told to check out instead (device-launch-commands.ts).
 *
 * The gate is only as strong as the provider allows: some providers can be refused, some only
 * asked, and one cannot be stopped at all (device-launch-enforcement.ts). A device that appears
 * with no lease still fills a slot — occupancy is the union of running devices and leases — and
 * is charged to the agent whose process tree owns it. Nothing is ever shut down.
 *
 * Off by default, with a dry run that reports what it would have refused, like the build-daemon
 * reaper it is modelled on.
 */

import { randomUUID } from "node:crypto";
import { attributeProcessTrees } from "./process-attribution.js";
import {
  detectRunningDevices,
  type DevicePlatform,
  type RunningDevice,
} from "./device-detection.js";
import {
  detectDeviceLaunchIntents,
  targetMatchesRunningDevice,
  type DeviceLaunchIntent,
} from "./device-launch-commands.js";
import {
  evaluateDeviceOccupancy,
  evaluateDeviceSlot,
  reconcileDeviceLeases,
  type DeviceLease,
  type DeviceLeaseRelease,
  type DeviceSlotCaps,
} from "./device-lease-registry.js";
import { readSystemHardware, type HardwareReader } from "./device-hardware.js";
import {
  DEVICE_LAUNCH_ENFORCEMENT_TIERS,
  describeDeviceLaunchEnforcement,
  resolveDeviceLaunchEnforcement,
  type DeviceLaunchEnforcementTier,
} from "./device-launch-enforcement.js";
import { deriveDeviceSlotDefaults, evaluateMemoryHeadroom } from "./device-slot-defaults.js";
import type { ProcessSampler, SystemMemorySample } from "./process-sampler.js";

const GIBIBYTE = 1024 ** 3;
const DEFAULT_PENDING_TTL_MINUTES = 10;
const DEFAULT_MAX_LEASE_HOURS = 12;
const DEFAULT_QUEUE_TIMEOUT_MINUTES = 20;
/**
 * A floor, not a comfort margin. macOS keeps free pages low on purpose — a freshly restarted
 * 64 GiB machine with no swap in use measured 2.8 GiB free — so this only fires when there is
 * genuinely nothing left. The machine this cap was written for was at 0.4 GiB. Swap pressure
 * below is the signal that usually catches trouble first; it was 96% on that same machine.
 */
const DEFAULT_MIN_AVAILABLE_BYTES = 0.5 * GIBIBYTE;
const DEFAULT_MAX_SWAP_USED_RATIO = 0.85;
/** How stale a `ps` snapshot may be before a gate decision re-takes it. */
const SAMPLE_MAX_AGE_MS = 5_000;
/** How often queued agents are reconsidered. Only runs while somebody is queued. */
const DRAIN_INTERVAL_MS = 5_000;
/** Denials kept for the status readout, newest first. */
const BLOCKED_HISTORY_LIMIT = 10;

export interface DeviceLeaseConfig {
  enabled?: boolean;
  dryRun?: boolean;
  totalSlots?: number;
  slotsPerPlatform?: number;
  requireHeadroom?: boolean;
  minAvailableBytes?: number;
  maxSwapUsedRatio?: number;
  pendingTtlMinutes?: number;
  maxLeaseHours?: number;
  queueTimeoutMinutes?: number;
}

export type DeviceStatusAttribution = "lease" | "process" | "none";

/**
 * An agent as the cap needs to see it. Richer than an id because the cap has two questions the
 * id cannot answer: which provider is holding this device (does the cap actually bind it —
 * device-launch-enforcement.ts), and is the agent mid-turn (only a running agent can be told
 * about a device it took without asking).
 */
export interface DeviceLeaseAgentSummary {
  agentId: string;
  provider: string;
  isRunning: boolean;
}

export interface DeviceStatusEntry {
  platform: DevicePlatform;
  deviceId: string | null;
  /** "running" comes from `ps`. "starting" is a lease whose device has not appeared yet. */
  state: "running" | "starting";
  agentId?: string;
  attribution: DeviceStatusAttribution;
  /** Since the lease was taken, or — for a device nobody leased — since the process started. */
  heldForSeconds?: number;
  source?: DeviceLease["source"];
  reason?: string;
  processCount?: number;
  /** The holder's provider, and how strongly the cap binds it. Absent with no holder. */
  provider?: string;
  enforcement?: DeviceLaunchEnforcementTier;
}

export interface DeviceStatusWaiter {
  agentId: string;
  platform: DevicePlatform;
  reason?: string;
  waitingForSeconds: number;
}

export interface DeviceStatusBlocked {
  agentId: string;
  platform: DevicePlatform;
  command: string;
  message: string;
  /** True when the cap was in dry run and the launch was allowed through anyway. */
  dryRun: boolean;
  at: string;
}

/** One provider with a live agent, and what the cap can do about its device launches. */
export interface DeviceStatusProviderEnforcement {
  provider: string;
  tier: DeviceLaunchEnforcementTier;
  /** Why it is not stronger. Absent for a provider the cap refuses outright. */
  gap?: string;
}

export interface DeviceStatusSnapshot {
  enabled: boolean;
  dryRun: boolean;
  totalSlots: number;
  slotsPerPlatform: number;
  used: number;
  usedByPlatform: Record<DevicePlatform, number>;
  devices: DeviceStatusEntry[];
  waiting: DeviceStatusWaiter[];
  blocked: DeviceStatusBlocked[];
  /** Every provider with a live agent right now, weakest tier first. The cap's own asymmetry. */
  enforcement: DeviceStatusProviderEnforcement[];
  generatedAt: string;
}

export type DeviceCheckoutResult =
  | { status: "disabled" }
  | { status: "granted"; leaseId: string; platform: DevicePlatform; note?: string }
  | { status: "queued"; platform: DevicePlatform; ahead: number; message: string }
  | { status: "unavailable"; platform: DevicePlatform; message: string };

export type DeviceLaunchGateDecision =
  | { decision: "allow" }
  | { decision: "deny"; message: string };

/**
 * What a provider needs from the cap to enforce it: one call, before a shell command runs.
 * `DeviceLeaseManager` satisfies it; providers take the interface so the gate can be absent
 * (the cap is unwired in tests and in a daemon that never built one) without them knowing.
 */
export interface DeviceLaunchGate {
  gateLaunch(input: { agentId: string; command: string }): Promise<DeviceLaunchGateDecision>;
  /**
   * Says why, for a provider whose rejection cannot carry a sentence back to the model — Codex
   * resolves an approval to a bare decision, ACP to an option id (device-launch-approval.ts).
   * Optional: a provider that can answer in-band, like Claude's hook, never calls it.
   */
  explainRefusalToAgent?(input: { agentId: string; message: string }): Promise<void>;
}

interface DeviceLeaseManagerLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface DeviceLeaseManagerOptions {
  processSampler: ProcessSampler;
  readDaemonConfig: () => { deviceLeases?: DeviceLeaseConfig };
  /** Agents the daemon still knows about; a lease held by anything else is released. */
  listAgents: () => readonly DeviceLeaseAgentSummary[];
  /**
   * Delivers ONE system-authored message into a running agent's conversation. The only lever
   * the cap has over a provider it cannot refuse: a device that appeared without a lease is
   * charged to the agent whose process tree owns it, and that agent is told. Shares the
   * resource monitor's steer path and its injection shape for the same reason.
   */
  sendSystemMessageToAgent?: (agentId: string, body: string) => Promise<void>;
  logger: DeviceLeaseManagerLogger;
  now?: () => number;
  readHardware?: HardwareReader;
  sampleMaxAgeMs?: number;
  drainIntervalMs?: number;
  createLeaseId?: () => string;
}

interface ResolvedDeviceLeaseConfig {
  enabled: boolean;
  dryRun: boolean;
  caps: DeviceSlotCaps;
  requireHeadroom: boolean;
  minAvailableBytes: number;
  maxSwapUsedRatio: number;
  pendingTtlMs: number;
  maxLeaseMs: number;
  queueTimeoutMs: number;
}

interface DeviceSample {
  devices: RunningDevice[];
  systemMemory: SystemMemorySample | undefined;
  takenAtMs: number;
}

interface QueuedWaiter {
  id: string;
  agentId: string;
  platform: DevicePlatform;
  reason?: string;
  enqueuedAtMs: number;
  resolve: (result: DeviceCheckoutResult) => void;
}

export interface DeviceCheckoutInput {
  agentId: string;
  platform: DevicePlatform;
  reason?: string;
  /** Wait for a slot instead of being told there is none. The point of checkout. */
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Reconciliation only ever drops a lease or binds one to a device, and keeps the list sorted, so
 * the same ids with the same devices in the same order means nothing happened.
 */
function sameLeases(before: readonly DeviceLease[], after: readonly DeviceLease[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((lease, index) => {
    const other = after[index];
    return lease.id === other.id && lease.deviceId === other.deviceId;
  });
}

function resolveCaps(
  config: DeviceLeaseConfig | undefined,
  defaults: DeviceSlotCaps,
): DeviceSlotCaps {
  const totalSlots = config?.totalSlots ?? defaults.totalSlots;
  return {
    totalSlots,
    // A per-platform cap above the total is meaningless; the total always wins.
    slotsPerPlatform: Math.min(totalSlots, config?.slotsPerPlatform ?? defaults.slotsPerPlatform),
  };
}

/**
 * The providers behind the agents that exist right now, weakest tier first, so a reader sees
 * what the cap cannot do before what it can. Only live agents: a tier for a provider nobody is
 * running is noise, and the point of the list is "which of my agents is unguarded".
 */
function summarizeProviderEnforcement(
  agents: readonly DeviceLeaseAgentSummary[],
): DeviceStatusProviderEnforcement[] {
  const byProvider = new Map<string, DeviceStatusProviderEnforcement>();
  for (const agent of agents) {
    if (byProvider.has(agent.provider)) continue;
    const enforcement = resolveDeviceLaunchEnforcement(agent.provider);
    byProvider.set(agent.provider, {
      provider: agent.provider,
      tier: enforcement.tier,
      ...(enforcement.gap ? { gap: enforcement.gap } : {}),
    });
  }
  return [...byProvider.values()].sort(
    (a, b) =>
      DEVICE_LAUNCH_ENFORCEMENT_TIERS.indexOf(a.tier) -
        DEVICE_LAUNCH_ENFORCEMENT_TIERS.indexOf(b.tier) || a.provider.localeCompare(b.provider),
  );
}

export class DeviceLeaseManager {
  private readonly processSampler: ProcessSampler;
  private readonly readDaemonConfig: DeviceLeaseManagerOptions["readDaemonConfig"];
  private readonly listAgents: () => readonly DeviceLeaseAgentSummary[];
  private readonly sendSystemMessageToAgent:
    | ((agentId: string, body: string) => Promise<void>)
    | undefined;
  private readonly logger: DeviceLeaseManagerLogger;
  private readonly now: () => number;
  private readonly readHardware: HardwareReader;
  private readonly sampleMaxAgeMs: number;
  private readonly drainIntervalMs: number;
  private readonly createLeaseId: () => string;

  private leases: DeviceLease[] = [];
  private waiters: QueuedWaiter[] = [];
  private blocked: DeviceStatusBlocked[] = [];
  private sample: DeviceSample | undefined;
  private inFlightSample: Promise<DeviceSample> | undefined;
  private derivedCaps: DeviceSlotCaps | undefined;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * `${agentId}:${deviceId}` for every unleased device already charged to its agent. The sweep
   * runs a minute; the agent hears about a device it took once, not sixty times an hour.
   * Pruned when the device goes, so booting a second one is a second message.
   */
  private readonly chargedUnleasedDevices = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(options: DeviceLeaseManagerOptions) {
    this.processSampler = options.processSampler;
    this.readDaemonConfig = options.readDaemonConfig;
    this.listAgents = options.listAgents;
    this.sendSystemMessageToAgent = options.sendSystemMessageToAgent;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.readHardware = options.readHardware ?? readSystemHardware;
    this.sampleMaxAgeMs = options.sampleMaxAgeMs ?? SAMPLE_MAX_AGE_MS;
    this.drainIntervalMs = options.drainIntervalMs ?? DRAIN_INTERVAL_MS;
    this.createLeaseId = options.createLeaseId ?? (() => randomUUID());
  }

  /** Fires whenever the count, the leases, or the queue change — the UI's push signal. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.stopDraining();
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({
        status: "unavailable",
        platform: waiter.platform,
        message: "The daemon stopped tracking device slots.",
      });
    }
  }

  /**
   * Reuses AgentResourceMonitor's sweep sample rather than taking its own: one `ps` per minute,
   * not two, on a machine that is already struggling. The monitor calls this every sweep.
   */
  async reconcileFromSample(input: {
    devices: RunningDevice[];
    systemMemory: SystemMemorySample | undefined;
  }): Promise<void> {
    this.sample = { ...input, takenAtMs: this.now() };
    const config = this.resolveConfig(await this.resolveCaps());
    this.reconcile(config);
    await this.chargeUnleasedDevices(config);
    await this.drainWaiters();
  }

  /**
   * What the cap does about a provider it cannot refuse (device-launch-enforcement.ts). The
   * device is already counted — occupancy is the union of running devices and leases, so an
   * unleased simulator takes a slot from everybody whether or not anyone owns up to it. What is
   * missing is that its agent does not know, and will boot another. So: charge it.
   *
   * Only an agent whose own process tree contains the device can be charged. That is Android
   * emulators and nothing else — `launchd_sim` is reparented to pid 1 the moment CoreSimulator
   * boots it, so an unleased iOS simulator has no owner `ps` can name, and guessing one is
   * worse than the silence. It stays unattributed, keeps its slot, and shows in the UI as
   * pressure nobody is accountable for.
   *
   * Never reaps, never refuses: a booted device may have a build running against it.
   */
  private async chargeUnleasedDevices(config: ResolvedDeviceLeaseConfig): Promise<void> {
    const devices = this.sample?.devices ?? [];
    // A device that stopped may be booted again later, and that is worth saying again.
    // Deleting the current entry mid-iteration is well-defined for a Set, so no copy.
    for (const key of this.chargedUnleasedDevices) {
      const deviceId = key.slice(key.indexOf(":") + 1);
      if (!devices.some((device) => device.deviceId === deviceId)) {
        this.chargedUnleasedDevices.delete(key);
      }
    }
    if (!config.enabled) return;

    const agents = new Map(this.listAgents().map((agent) => [agent.agentId, agent]));
    for (const device of devices) {
      if (!device.agentId) continue;
      if (this.leases.some((lease) => lease.deviceId === device.deviceId)) continue;
      const key = `${device.agentId}:${device.deviceId}`;
      if (this.chargedUnleasedDevices.has(key)) continue;
      this.chargedUnleasedDevices.add(key);

      const agent = agents.get(device.agentId);
      const enforcement = resolveDeviceLaunchEnforcement(agent?.provider);
      this.logger.info(
        {
          agentId: device.agentId,
          deviceId: device.deviceId,
          platform: device.platform,
          provider: agent?.provider,
          enforcement: enforcement.tier,
          dryRun: config.dryRun,
        },
        "Device running without a lease, charged to the agent whose process tree owns it",
      );
      // Dry run reports; it does not spend an agent's tokens on a message about a cap that is
      // refusing nothing. Same contract as the launch gate above.
      if (config.dryRun || !this.sendSystemMessageToAgent) continue;
      // The steer path starts a new turn for an idle agent (agent-prompt.ts), which would spend
      // tokens on an agent nobody is driving. Only tell one that is mid-turn.
      if (!agent?.isRunning) continue;
      try {
        await this.sendSystemMessageToAgent(
          device.agentId,
          this.unleasedDeviceMessage(device.platform, device.deviceId, enforcement),
        );
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: device.agentId, deviceId: device.deviceId },
          "Failed to steer the device cap's unleased-device message into the agent",
        );
      }
    }
  }

  private unleasedDeviceMessage(
    platform: DevicePlatform,
    deviceId: string,
    enforcement: ReturnType<typeof resolveDeviceLaunchEnforcement>,
  ): string {
    const occupancy = evaluateDeviceOccupancy({
      runningDevices: this.sample?.devices ?? [],
      leases: this.leases,
    });
    const caps = this.derivedCaps;
    const usage = caps ? ` (${occupancy.total} of ${caps.totalSlots} slots now in use)` : "";
    return (
      `Bozeo device cap: you are running a ${platform} device (${deviceId}) that you did not ` +
      `check out. It is holding one of the machine's device slots${usage}, so other agents are ` +
      `queueing behind it. Nothing has been shut down and nothing will be — keep using it. ` +
      `${describeDeviceLaunchEnforcement(enforcement)} Call \`device_checkin\` as soon as you ` +
      `are finished with this device, and call \`device_checkout\` before you boot the next one.`
    );
  }

  async getSnapshot(): Promise<DeviceStatusSnapshot> {
    const config = this.resolveConfig(await this.resolveCaps());
    const sample = await this.ensureSample();
    this.reconcile(config);
    return this.buildSnapshot(config, sample);
  }

  async checkout(input: DeviceCheckoutInput): Promise<DeviceCheckoutResult> {
    const config = this.resolveConfig(await this.resolveCaps());
    if (!config.enabled) {
      return { status: "disabled" };
    }
    await this.ensureSample({ fresh: true });
    this.reconcile(config);

    const verdict = this.tryGrant(input.agentId, input.platform, "checkout", input.reason, config);
    if (verdict.granted) {
      return { status: "granted", leaseId: verdict.leaseId, platform: input.platform };
    }
    if (config.dryRun) {
      // Dry run never makes anybody wait; it reports what the queue would have done.
      const lease = this.createLease(input.agentId, input.platform, "checkout", input.reason);
      return {
        status: "granted",
        leaseId: lease.id,
        platform: input.platform,
        note: `Device slots are in dry run: this would have waited (${verdict.message}).`,
      };
    }
    if (!input.wait) {
      return { status: "unavailable", platform: input.platform, message: verdict.message };
    }
    return await this.enqueue(input, config, verdict.message);
  }

  /** Gives a slot back. Without a lease id, every lease this agent holds is released. */
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
    await this.drainWaiters();
    return released.length;
  }

  /**
   * The enforcement point. Called from the provider's PreToolUse hook before a shell command
   * runs: a command that would boot a device is refused when there is no slot, and the refusal
   * says what to do instead. A rogue agent is stopped here; a well-behaved one never sees it,
   * because checkout already gave it a lease and this finds it.
   */
  async gateLaunch(input: { agentId: string; command: string }): Promise<DeviceLaunchGateDecision> {
    const intents = detectDeviceLaunchIntents(input.command);
    if (intents.length === 0) return { decision: "allow" };

    const config = this.resolveConfig(await this.resolveCaps());
    if (!config.enabled) return { decision: "allow" };

    const sample = await this.ensureSample({ fresh: true });
    this.reconcile(config);

    for (const intent of intents) {
      const decision = this.gateIntent(input.agentId, intent, config, sample);
      if (decision) {
        this.recordBlocked({
          agentId: input.agentId,
          platform: intent.platform,
          command: intent.command,
          message: decision,
          dryRun: config.dryRun,
          at: new Date(this.now()).toISOString(),
        });
        if (config.dryRun) {
          this.logger.info(
            { dryRun: true, agentId: input.agentId, command: intent.command },
            "Device cap would have refused a device launch",
          );
          continue;
        }
        this.logger.info(
          { agentId: input.agentId, command: intent.command, platform: intent.platform },
          "Device cap refused a device launch",
        );
        return { decision: "deny", message: decision };
      }
    }
    return { decision: "allow" };
  }

  /**
   * Delivers a refusal a provider could not put in front of the model itself. Silent when the
   * cap is off or in dry run: dry run refuses nothing, so it has nothing to explain.
   */
  async explainRefusalToAgent(input: { agentId: string; message: string }): Promise<void> {
    const config = this.resolveConfig(await this.resolveCaps());
    if (!config.enabled || config.dryRun || !this.sendSystemMessageToAgent) return;
    await this.sendSystemMessageToAgent(input.agentId, input.message);
  }

  /**
   * One launch intent against the cap. Returns the denial message, or undefined to allow.
   * Allowing takes a lease on the agent's behalf, so a device booted without asking still fills
   * a slot and still shows a holder — the count is never quietly wrong.
   */
  private gateIntent(
    agentId: string,
    intent: DeviceLaunchIntent,
    config: ResolvedDeviceLeaseConfig,
    sample: DeviceSample,
  ): string | undefined {
    // Booting a device that is already up costs nothing; refusing it would be nonsense.
    if (
      sample.devices.some((device) =>
        targetMatchesRunningDevice(intent.target, device, intent.platform),
      )
    ) {
      return undefined;
    }
    // The agent checked out first and has not used the slot yet. This is the good path.
    if (
      this.leases.some(
        (lease) =>
          lease.agentId === agentId &&
          lease.platform === intent.platform &&
          lease.deviceId === undefined,
      )
    ) {
      return undefined;
    }

    const verdict = this.tryGrant(agentId, intent.platform, "launch", undefined, config);
    return verdict.granted ? undefined : this.denialMessage(intent, verdict.message);
  }

  private denialMessage(intent: DeviceLaunchIntent, reason: string): string {
    const holders = this.describeHolders(intent.platform);
    return (
      `Bozeo device cap: \`${intent.command}\` was not run because ${reason}. ` +
      `${holders} ` +
      `Do not retry the command and do not work around the cap. Call the \`device_checkout\` ` +
      `tool with platform "${intent.platform}" and wait — it returns as soon as a slot frees, ` +
      `and then this command will run. Call \`device_checkin\` when you are finished with the ` +
      `device so the next agent can have it.`
    );
  }

  private describeHolders(platform: DevicePlatform): string {
    const entries = this.leases
      .filter((lease) => lease.platform === platform)
      .map((lease) => {
        const heldFor = formatDuration((this.now() - lease.acquiredAtMs) / 1000);
        return `${lease.agentId} (${heldFor}${lease.reason ? `, ${lease.reason}` : ""})`;
      });
    const unleased = (this.sample?.devices ?? []).filter(
      (device) =>
        device.platform === platform &&
        !this.leases.some((lease) => lease.deviceId === device.deviceId),
    );
    const parts: string[] = [];
    if (entries.length > 0) parts.push(`Held by: ${entries.join(", ")}.`);
    if (unleased.length > 0) {
      parts.push(
        `${unleased.length} running without a lease (booted by hand or before the cap was on): ` +
          `${unleased.map((device) => device.deviceId).join(", ")}.`,
      );
    }
    return parts.length > 0 ? parts.join(" ") : "";
  }

  /** Capacity plus headroom, and the lease if both say yes. */
  private tryGrant(
    agentId: string,
    platform: DevicePlatform,
    source: DeviceLease["source"],
    reason: string | undefined,
    config: ResolvedDeviceLeaseConfig,
  ): { granted: true; leaseId: string } | { granted: false; message: string } {
    const slot = evaluateDeviceSlot({
      platform,
      runningDevices: this.sample?.devices ?? [],
      leases: this.leases,
      caps: config.caps,
    });
    if (!slot.available) {
      const limit =
        slot.scope === "platform"
          ? `${config.caps.slotsPerPlatform} ${platform} device${config.caps.slotsPerPlatform === 1 ? "" : "s"}`
          : `${config.caps.totalSlots} devices in total`;
      return {
        granted: false,
        message: `the machine is already running ${limit} (${slot.occupancy.total} of ${config.caps.totalSlots} slots in use)`,
      };
    }
    if (config.requireHeadroom) {
      const headroom = evaluateMemoryHeadroom(
        {
          ...(this.sample?.systemMemory?.availableBytes !== undefined
            ? { availableBytes: this.sample.systemMemory.availableBytes }
            : {}),
          ...(this.sample?.systemMemory && this.sample.systemMemory.swapTotalBytes > 0
            ? {
                swapUsedRatio:
                  this.sample.systemMemory.swapUsedBytes / this.sample.systemMemory.swapTotalBytes,
              }
            : {}),
        },
        {
          minAvailableBytes: config.minAvailableBytes,
          maxSwapUsedRatio: config.maxSwapUsedRatio,
        },
      );
      if (!headroom.ok) {
        return { granted: false, message: headroom.reason };
      }
    }
    return { granted: true, leaseId: this.createLease(agentId, platform, source, reason).id };
  }

  private createLease(
    agentId: string,
    platform: DevicePlatform,
    source: DeviceLease["source"],
    reason: string | undefined,
  ): DeviceLease {
    const lease: DeviceLease = {
      id: this.createLeaseId(),
      agentId,
      platform,
      source,
      acquiredAtMs: this.now(),
      ...(reason ? { reason } : {}),
    };
    this.leases.push(lease);
    this.logger.info({ leaseId: lease.id, agentId, platform, source }, "Device slot leased");
    this.notify();
    return lease;
  }

  private async enqueue(
    input: DeviceCheckoutInput,
    config: ResolvedDeviceLeaseConfig,
    message: string,
  ): Promise<DeviceCheckoutResult> {
    const ahead = this.waiters.filter((waiter) => waiter.platform === input.platform).length;
    const timeoutMs = input.timeoutMs ?? config.queueTimeoutMs;
    let settle: (result: DeviceCheckoutResult) => void = () => undefined;
    const answer = new Promise<DeviceCheckoutResult>((resolve) => {
      settle = resolve;
    });

    // One answer per waiter: the grant, the timeout and the abort all race for it, and whoever
    // gets there first takes the waiter out of the queue.
    let settled = false;
    const waiter: QueuedWaiter = {
      id: this.createLeaseId(),
      agentId: input.agentId,
      platform: input.platform,
      enqueuedAtMs: this.now(),
      resolve: (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((entry) => entry.id !== waiter.id);
        this.stopDrainingWhenIdle();
        settle(result);
      },
      ...(input.reason ? { reason: input.reason } : {}),
    };
    const timer = setTimeout(() => {
      waiter.resolve({
        status: "unavailable",
        platform: input.platform,
        message: `Waited ${formatDuration(timeoutMs / 1000)} for a ${input.platform} device slot and none came free: ${message}.`,
      });
      this.notify();
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const onAbort = () => {
      waiter.resolve({
        status: "unavailable",
        platform: input.platform,
        message: "The wait for a device slot was canceled.",
      });
      this.notify();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    this.waiters.push(waiter);
    this.startDraining();
    this.notify();
    this.logger.info(
      { agentId: input.agentId, platform: input.platform, ahead },
      "Agent queued for a device slot",
    );
    return await answer;
  }

  /**
   * Hands freed slots to whoever has been waiting longest. Runs after every release and on its
   * own timer while anybody is queued — a slot frees when a device stops, which nothing notifies
   * the daemon about, so the queue has to look.
   */
  private async drainWaiters(): Promise<void> {
    if (this.waiters.length === 0) {
      this.stopDraining();
      return;
    }
    const config = this.resolveConfig(await this.resolveCaps());
    if (!config.enabled) {
      for (const waiter of this.waiters.slice()) {
        waiter.resolve({ status: "disabled" });
      }
      return;
    }
    await this.ensureSample();
    this.reconcile(config);

    for (const waiter of this.waiters.slice().sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs)) {
      const verdict = this.tryGrant(
        waiter.agentId,
        waiter.platform,
        "checkout",
        waiter.reason,
        config,
      );
      if (!verdict.granted) continue;
      this.logger.info(
        {
          agentId: waiter.agentId,
          platform: waiter.platform,
          waitedMs: this.now() - waiter.enqueuedAtMs,
        },
        "Queued agent received a device slot",
      );
      waiter.resolve({
        status: "granted",
        leaseId: verdict.leaseId,
        platform: waiter.platform,
      });
    }
    this.notify();
  }

  private startDraining(): void {
    if (this.drainTimer) return;
    const timer = setInterval(() => {
      void this.drainWaiters().catch((error) => {
        this.logger.warn({ err: error }, "Device slot queue drain failed");
      });
    }, this.drainIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.drainTimer = timer;
  }

  private stopDrainingWhenIdle(): void {
    if (this.waiters.length === 0) this.stopDraining();
  }

  private stopDraining(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private reconcile(config: ResolvedDeviceLeaseConfig): void {
    const before = this.leases;
    const result = reconcileDeviceLeases({
      leases: this.leases,
      runningDevices: this.sample?.devices ?? [],
      liveAgentIds: new Set(this.listAgents().map((agent) => agent.agentId)),
      nowMs: this.now(),
      pendingTtlMs: config.pendingTtlMs,
      maxLeaseMs: config.maxLeaseMs,
    });
    this.leases = result.leases;
    if (result.released.length > 0) {
      this.logRelease(result.released);
    }
    // Compare by content, not identity: reconcileDeviceLeases always builds a fresh array. A
    // session's listener answers a notify by taking a snapshot, which reconciles, so notifying on
    // identity re-entered here forever — pure microtasks, the event loop never got control back,
    // and the daemon pinned a core while pushing snapshots until the socket's buffer overflowed.
    if (result.released.length > 0 || !sameLeases(before, this.leases)) {
      this.notify();
    }
  }

  private logRelease(released: readonly DeviceLeaseRelease[]): void {
    for (const entry of released) {
      this.logger.info(
        {
          leaseId: entry.lease.id,
          agentId: entry.lease.agentId,
          platform: entry.lease.platform,
          deviceId: entry.lease.deviceId,
          reason: entry.reason,
          heldMs: this.now() - entry.lease.acquiredAtMs,
        },
        "Device slot released",
      );
    }
  }

  private recordBlocked(entry: DeviceStatusBlocked): void {
    this.blocked = [entry, ...this.blocked].slice(0, BLOCKED_HISTORY_LIMIT);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.logger.warn({ err: error }, "Device status listener failed");
      }
    }
  }

  private async ensureSample(options: { fresh?: boolean } = {}): Promise<DeviceSample> {
    const maxAge = options.fresh ? this.sampleMaxAgeMs : Number.POSITIVE_INFINITY;
    if (this.sample && this.now() - this.sample.takenAtMs <= maxAge) {
      return this.sample;
    }
    // One `ps` for however many gate checks land at once: several agents booting together is
    // the case this whole feature exists for.
    this.inFlightSample ??= this.takeSample().finally(() => {
      this.inFlightSample = undefined;
    });
    return await this.inFlightSample;
  }

  private async takeSample(): Promise<DeviceSample> {
    const [rows, systemMemory] = await Promise.all([
      this.processSampler.sampleProcesses(),
      this.processSampler.sampleSystemMemory(),
    ]);
    const attribution = attributeProcessTrees(
      rows,
      this.listAgents().map((agent) => agent.agentId),
    );
    const sample: DeviceSample = {
      devices: detectRunningDevices({ rows, agentTrees: attribution.agentTrees }),
      systemMemory,
      takenAtMs: this.now(),
    };
    this.sample = sample;
    return sample;
  }

  private async resolveCaps(): Promise<DeviceSlotCaps> {
    this.derivedCaps ??= deriveDeviceSlotDefaults(await this.readHardware());
    return this.derivedCaps;
  }

  private resolveConfig(defaults: DeviceSlotCaps): ResolvedDeviceLeaseConfig {
    const config = this.readDaemonConfig().deviceLeases;
    return {
      enabled: config?.enabled ?? false,
      dryRun: config?.dryRun ?? false,
      caps: resolveCaps(config, defaults),
      requireHeadroom: config?.requireHeadroom ?? true,
      minAvailableBytes: config?.minAvailableBytes ?? DEFAULT_MIN_AVAILABLE_BYTES,
      maxSwapUsedRatio: config?.maxSwapUsedRatio ?? DEFAULT_MAX_SWAP_USED_RATIO,
      pendingTtlMs: (config?.pendingTtlMinutes ?? DEFAULT_PENDING_TTL_MINUTES) * 60_000,
      maxLeaseMs: (config?.maxLeaseHours ?? DEFAULT_MAX_LEASE_HOURS) * 3_600_000,
      queueTimeoutMs: (config?.queueTimeoutMinutes ?? DEFAULT_QUEUE_TIMEOUT_MINUTES) * 60_000,
    };
  }

  /** Stamps a status entry with its holder's provider and what the cap can do about it. */
  private applyEnforcement(
    entry: DeviceStatusEntry,
    providerByAgentId: ReadonlyMap<string, string>,
  ): DeviceStatusEntry {
    const provider = entry.agentId ? providerByAgentId.get(entry.agentId) : undefined;
    if (!provider) return entry;
    entry.provider = provider;
    entry.enforcement = resolveDeviceLaunchEnforcement(provider).tier;
    return entry;
  }

  private toRunningDeviceEntry(
    device: RunningDevice,
    lease: DeviceLease | undefined,
    nowMs: number,
  ): DeviceStatusEntry {
    const entry: DeviceStatusEntry = {
      platform: device.platform,
      deviceId: device.deviceId,
      state: "running",
      attribution: "none",
      processCount: device.pids.length,
    };
    if (lease) {
      entry.attribution = "lease";
      entry.agentId = lease.agentId;
      entry.source = lease.source;
      entry.heldForSeconds = (nowMs - lease.acquiredAtMs) / 1000;
      if (lease.reason) entry.reason = lease.reason;
      return entry;
    }
    if (device.agentId) {
      // No lease, but the device sits in this agent's process tree — it skipped the gate.
      entry.attribution = "process";
      entry.agentId = device.agentId;
    }
    // Nobody's lease, so "how long" is how long the device itself has been up.
    if (device.uptimeSeconds !== undefined) entry.heldForSeconds = device.uptimeSeconds;
    return entry;
  }

  private buildSnapshot(
    config: ResolvedDeviceLeaseConfig,
    sample: DeviceSample,
  ): DeviceStatusSnapshot {
    const nowMs = this.now();
    const agents = this.listAgents();
    const providerByAgentId = new Map(agents.map((agent) => [agent.agentId, agent.provider]));
    const leaseByDeviceId = new Map(
      this.leases
        .filter((lease) => lease.deviceId !== undefined)
        .map((lease) => [lease.deviceId as string, lease] as const),
    );

    // Running devices come first and come from `ps`. A lease only decorates one with a holder.
    const devices: DeviceStatusEntry[] = sample.devices.map((device) =>
      this.applyEnforcement(
        this.toRunningDeviceEntry(device, leaseByDeviceId.get(device.deviceId), nowMs),
        providerByAgentId,
      ),
    );

    for (const lease of this.leases) {
      if (lease.deviceId !== undefined) continue;
      devices.push(
        this.applyEnforcement(
          {
            platform: lease.platform,
            deviceId: null,
            state: "starting",
            agentId: lease.agentId,
            attribution: "lease",
            heldForSeconds: (nowMs - lease.acquiredAtMs) / 1000,
            source: lease.source,
            ...(lease.reason ? { reason: lease.reason } : {}),
          },
          providerByAgentId,
        ),
      );
    }

    const occupancy = evaluateDeviceOccupancy({
      runningDevices: sample.devices,
      leases: this.leases,
    });

    return {
      enabled: config.enabled,
      dryRun: config.dryRun,
      totalSlots: config.caps.totalSlots,
      slotsPerPlatform: config.caps.slotsPerPlatform,
      used: occupancy.total,
      usedByPlatform: occupancy.byPlatform,
      devices,
      waiting: this.waiters.map((waiter) => ({
        agentId: waiter.agentId,
        platform: waiter.platform,
        waitingForSeconds: (nowMs - waiter.enqueuedAtMs) / 1000,
        ...(waiter.reason ? { reason: waiter.reason } : {}),
      })),
      blocked: this.blocked,
      enforcement: summarizeProviderEnforcement(agents),
      generatedAt: new Date(nowMs).toISOString(),
    };
  }
}
