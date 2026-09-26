import type { DeviceStatusUpdateMessage } from "@getpaseo/protocol/messages";

type DeviceStatusPayload = DeviceStatusUpdateMessage["payload"];
type DeviceStatusEntry = DeviceStatusPayload["devices"][number];

export type DeviceStatusTone = "ok" | "warning" | "danger";

export type DeviceStatusEnforcementTier = "observes" | "asks" | "refuses";

export interface DeviceStatusRow {
  key: string;
  platform: "ios" | "android";
  /** The device's own name where there is one; never a lease id dressed up as a device. */
  label: string;
  /** "held by <agent>", "booting", "no lease" — who has it, in the strip's own words. */
  holderKey: "heldBy" | "unleased" | "starting";
  agentId?: string;
  /** The holding agent's title, resolved by the caller from its own agent list. */
  agentLabel?: string;
  heldForSeconds?: number;
  reason?: string;
  /**
   * How strongly the cap binds the holder's provider. Present only where the daemon knows the
   * holder; a row carrying "asks" or "observes" is a device the cap might not have been able
   * to refuse, which is worth seeing next to the device itself.
   */
  enforcement?: DeviceStatusEnforcementTier;
}

export interface DeviceStatusStripModel {
  /** False when there is nothing worth a row: no cap, no devices, nobody waiting. */
  hasData: boolean;
  enabled: boolean;
  dryRun: boolean;
  used: number;
  totalSlots: number;
  tone: DeviceStatusTone;
  rows: DeviceStatusRow[];
  waiting: DeviceStatusPayload["waiting"];
  /** Devices running under nobody's lease. Called out because they are the cap's blind spot. */
  unleasedCount: number;
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

function toRow(
  device: DeviceStatusEntry,
  index: number,
  agentLabels: Record<string, string>,
): DeviceStatusRow {
  const holderKey = resolveHolderKey(device);
  return {
    key: device.deviceId ?? `starting-${device.platform}-${index}`,
    platform: device.platform,
    label: device.deviceId ? shortDeviceId(device.deviceId) : "",
    holderKey,
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

export function buildDeviceStatusStripModel(
  payload: DeviceStatusPayload | undefined,
  agentLabels: Record<string, string> = {},
): DeviceStatusStripModel {
  const devices = payload?.devices ?? [];
  const waiting = payload?.waiting ?? [];
  return {
    // A daemon with the cap off and nothing running has nothing to say; the strip disappears
    // rather than sitting there reporting zero.
    hasData: devices.length > 0 || waiting.length > 0,
    enabled: payload?.enabled ?? false,
    dryRun: payload?.dryRun ?? false,
    used: payload?.used ?? 0,
    totalSlots: payload?.totalSlots ?? 0,
    tone: resolveTone(payload?.used ?? 0, payload?.totalSlots ?? 0),
    rows: devices.map((device, index) => toRow(device, index, agentLabels)),
    waiting,
    unleasedCount: devices.filter(
      (device) => device.state === "running" && device.attribution === "none",
    ).length,
    unenforcedProviders: resolveUnenforcedProviders(payload),
  };
}
