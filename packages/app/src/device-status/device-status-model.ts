import type { DeviceStatusUpdateMessage } from "@getpaseo/protocol/messages";

type DeviceStatusPayload = DeviceStatusUpdateMessage["payload"];
type DeviceStatusEntry = DeviceStatusPayload["devices"][number];
type PhysicalDeviceStatusEntry = NonNullable<DeviceStatusPayload["physicalDevices"]>[number];

export type DeviceStatusTone = "ok" | "warning" | "danger";

export type DeviceStatusEnforcementTier = "observes" | "asks" | "refuses";

export interface DeviceStatusRow {
  key: string;
  /** Null only for a "starting" row — a checked-out slot with no device yet. */
  deviceId: string | null;
  platform: "ios" | "android";
  /** The device's own name where there is one; never a lease id dressed up as a device. A
   * simulator reads "<simctl name> · <first UDID block>"; an emulator reads its AVD name. */
  label: string;
  /** A simulator's simctl name, when the daemon resolved one. */
  name?: string;
  /** "held by <agent>", "booting", "no lease" — who has it, in the strip's own words. */
  holderKey: "heldBy" | "unleased" | "starting";
  agentId?: string;
  /** The holding agent's title, resolved by the caller from its own agent list. */
  agentLabel?: string;
  heldForSeconds?: number;
  /** How long the device itself has been running — distinct from how long it has been held. */
  runningForSeconds?: number;
  reason?: string;
  /**
   * How strongly the cap binds the holder's provider. Present only where the daemon knows the
   * holder; a row carrying "asks" or "observes" is a device the cap might not have been able
   * to refuse, which is worth seeing next to the device itself.
   */
  enforcement?: DeviceStatusEnforcementTier;
  /** Tyler reserved this device. Independent of holderKey — a reserved device can still show a
   * current holder; reserving doesn't evict one. */
  reserved: boolean;
  /** From the process scan, not the lease — a "starting" row is never running yet. */
  isRunning: boolean;
}

export interface PhysicalDeviceStatusRow {
  key: string;
  id: string;
  /** The last 4 characters only (docs/device-leases.md) — never the full serial/UDID. */
  shortId: string;
  platform: "ios" | "android";
  name?: string;
  transport: "usb" | "network";
  connected: boolean;
  graceRemainingSeconds?: number;
  agentId?: string;
  agentLabel?: string;
  heldForSeconds?: number;
  reserved: boolean;
}

/** "Enforcing", "Dry run", or the cap turned off entirely. What the Devices section's header
 * reads, and what the dry-run switch reflects. */
export type DeviceStatusMode = "off" | "dryRun" | "enforcing";

function resolveMode(payload: DeviceStatusPayload | undefined): DeviceStatusMode {
  if (!payload?.enabled) return "off";
  return payload.dryRun ? "dryRun" : "enforcing";
}

export interface DeviceStatusStripModel {
  /** False when there is nothing worth a row: no cap, no devices, nobody waiting. */
  hasData: boolean;
  enabled: boolean;
  dryRun: boolean;
  mode: DeviceStatusMode;
  used: number;
  totalSlots: number;
  tone: DeviceStatusTone;
  rows: DeviceStatusRow[];
  waiting: DeviceStatusPayload["waiting"];
  /** Recent refusals (and, in dry run, what would have been refused or handed over). */
  blocked: DeviceStatusPayload["blocked"];
  /** Simulator/emulator refusals plus the physical install gate's. */
  blockedCount: number;
  /** Every recorded refusal is a dry-run record: nothing was actually refused. */
  blockedDryRunOnly: boolean;
  /** Devices running under nobody's lease. Called out because they are the cap's blind spot. */
  unleasedCount: number;
  /** Connected physical devices (USB/network) — outside the slot cap entirely. */
  physicalRows: PhysicalDeviceStatusRow[];
  /**
   * Providers with a live agent that the cap cannot refuse outright, weakest first. A cap that
   * silently binds some agents and not others is the half-truth that makes the whole readout
   * untrustworthy, so the strip names them rather than implying the number is enforced.
   */
  unenforcedProviders: Array<{ provider: string; tier: "observes" | "asks" }>;
}

/** A UDID is 36 characters of noise in a 200px sidebar; the first block identifies it fine. */
function shortDeviceId(deviceId: string): string {
  return /^[0-9A-Fa-f]{8}-/.test(deviceId) ? deviceId.slice(0, 8) : deviceId;
}

function resolveHolderKey(device: DeviceStatusEntry): DeviceStatusRow["holderKey"] {
  if (device.state === "starting") return "starting";
  // No agent at all: booted by hand, or by an agent that is gone. Said plainly, not hidden.
  return device.agentId ? "heldBy" : "unleased";
}

function resolveLabel(device: DeviceStatusEntry): string {
  if (!device.deviceId) return "";
  const short = shortDeviceId(device.deviceId);
  return device.name ? `${device.name} · ${short}` : short;
}

function toRow(
  device: DeviceStatusEntry,
  index: number,
  agentLabels: Record<string, string>,
): DeviceStatusRow {
  const holderKey = resolveHolderKey(device);
  return {
    key: device.deviceId ?? `starting-${device.platform}-${index}`,
    deviceId: device.deviceId,
    platform: device.platform,
    label: resolveLabel(device),
    ...(device.name ? { name: device.name } : {}),
    ...(device.runningForSeconds !== undefined
      ? { runningForSeconds: device.runningForSeconds }
      : {}),
    holderKey,
    reserved: device.reserved ?? false,
    isRunning: device.state === "running",
    ...(device.agentId ? { agentId: device.agentId } : {}),
    ...(device.agentId && agentLabels[device.agentId]
      ? { agentLabel: agentLabels[device.agentId] }
      : {}),
    ...(device.heldForSeconds !== undefined ? { heldForSeconds: device.heldForSeconds } : {}),
    ...(device.reason ? { reason: device.reason } : {}),
    ...(device.enforcement ? { enforcement: device.enforcement } : {}),
  };
}

/**
 * Tone is about the cap, not the machine: full is worth noticing, over the cap is worth
 * flagging. Over is reachable — devices booted before the cap was turned on, or while it was
 * off, still count, and the strip says so rather than hiding them.
 */
function resolveTone(used: number, totalSlots: number): DeviceStatusTone {
  if (used > totalSlots) return "danger";
  if (used >= totalSlots) return "warning";
  return "ok";
}

/** The providers the cap cannot refuse outright. An old daemon says nothing, and claims nothing. */
function resolveUnenforcedProviders(
  payload: DeviceStatusPayload | undefined,
): DeviceStatusStripModel["unenforcedProviders"] {
  const entries = payload?.enforcement ?? [];
  const unenforced: DeviceStatusStripModel["unenforcedProviders"] = [];
  for (const entry of entries) {
    if (entry.tier === "refuses") continue;
    unenforced.push({ provider: entry.provider, tier: entry.tier });
  }
  return unenforced;
}

function countUnleased(devices: readonly DeviceStatusEntry[]): number {
  return devices.filter((device) => device.state === "running" && device.attribution === "none")
    .length;
}

/** The last 4 characters that identify the phone. A wireless-debugging mDNS serial
 * (`adb-<serial>-<id>._adb-tls-connect._tcp`) carries the USB serial inside it; its literal last
 * 4 would be `_tcp` on every phone. */
function physicalShortId(id: string): string {
  const embedded = /^adb-(.+)-[^-.]+\._adb-tls-connect\._tcp/.exec(id)?.[1];
  return (embedded ?? id).slice(-4);
}

function toPhysicalRow(
  device: PhysicalDeviceStatusEntry,
  agentLabels: Record<string, string>,
): PhysicalDeviceStatusRow {
  return {
    key: device.id,
    id: device.id,
    shortId: physicalShortId(device.id),
    platform: device.platform,
    transport: device.transport,
    connected: device.connected,
    reserved: device.reserved,
    ...(device.name ? { name: device.name } : {}),
    ...(device.graceRemainingSeconds !== undefined
      ? { graceRemainingSeconds: device.graceRemainingSeconds }
      : {}),
    ...(device.agentId ? { agentId: device.agentId } : {}),
    ...(device.agentId && agentLabels[device.agentId]
      ? { agentLabel: agentLabels[device.agentId] }
      : {}),
    ...(device.heldForSeconds !== undefined ? { heldForSeconds: device.heldForSeconds } : {}),
  };
}

/** Both gates' recent refusals, counted together; a list of only dry-run records refused
 * nothing and must not read as refusals. */
function summarizeBlocked(
  payload: DeviceStatusPayload | undefined,
): Pick<DeviceStatusStripModel, "blockedCount" | "blockedDryRunOnly"> {
  const entries = [...(payload?.blocked ?? []), ...(payload?.physicalBlocked ?? [])];
  return {
    blockedCount: entries.length,
    blockedDryRunOnly: entries.every((entry) => entry.dryRun),
  };
}

export function buildDeviceStatusStripModel(
  payload: DeviceStatusPayload | undefined,
  agentLabels: Record<string, string> = {},
): DeviceStatusStripModel {
  const devices = payload?.devices ?? [];
  const waiting = payload?.waiting ?? [];
  const used = payload?.used ?? 0;
  const totalSlots = payload?.totalSlots ?? 0;
  const physicalDevices = payload?.physicalDevices ?? [];
  return {
    // A daemon with the cap off and nothing running has nothing to say; the strip disappears
    // rather than sitting there reporting zero. Physical devices have no "cap off" state, so
    // any connected one is enough on its own to keep the panel visible.
    hasData: devices.length > 0 || waiting.length > 0 || physicalDevices.length > 0,
    enabled: payload?.enabled ?? false,
    dryRun: payload?.dryRun ?? false,
    mode: resolveMode(payload),
    used,
    totalSlots,
    tone: resolveTone(used, totalSlots),
    rows: devices.map((device, index) => toRow(device, index, agentLabels)),
    waiting,
    blocked: payload?.blocked ?? [],
    ...summarizeBlocked(payload),
    unleasedCount: countUnleased(devices),
    unenforcedProviders: resolveUnenforcedProviders(payload),
    physicalRows: physicalDevices.map((device) => toPhysicalRow(device, agentLabels)),
  };
}
