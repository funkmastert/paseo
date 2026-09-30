/**
 * Parses `xcrun devicectl list devices --json-output <file>`, keeping only physical devices —
 * `reality: "simulated"` entries are simulators, already covered by the process scan.
 *
 * Verified against a real run on this machine (docs/device-leases.md, Physical devices):
 * `result.devices[].hardwareProperties.{reality,udid,deviceType,marketingName,serialNumber}`
 * and `.connectionProperties.transportType` ("wired" | "network"). `properties.connection.state`
 * looks like the obvious "is it reachable" field but is not: it tracks devicectl's own remote
 * tunnel (used by `devicectl device install`/`process launch`), and reads "disconnected" on a
 * device the `devicectl list devices` table calls "available (paired)" right now — a physical
 * iPhone paired over the network with no active tunnel session. Presence in the polled device
 * list is the connectivity signal this uses instead: devicectl only lists what it currently
 * detects (USB enumeration or the coredevice Bonjour registration), so a device that becomes
 * unreachable drops out of the list on its own, and DevicectlPollingService's grace period
 * absorbs a momentary drop the same way the adb side does.
 */

import { z } from "zod";

export type DevicectlTransport = "wired" | "network";

export interface DevicectlPhysicalDevice {
  udid: string;
  name: string;
  deviceType: string;
  serialNumber?: string;
  transport: DevicectlTransport;
}

const DevicectlDeviceSchema = z.object({
  hardwareProperties: z
    .object({
      reality: z.string().optional(),
      udid: z.string().optional(),
      deviceType: z.string().optional(),
      marketingName: z.string().optional(),
      serialNumber: z.string().optional(),
    })
    .optional(),
  connectionProperties: z
    .object({
      transportType: z.string().optional(),
    })
    .optional(),
  deviceProperties: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

const DevicectlOutputSchema = z.object({
  result: z
    .object({
      devices: z.array(DevicectlDeviceSchema).optional(),
    })
    .optional(),
});

/** "wired" unless devicectl explicitly says "network" — a missing field is the safer default,
 * since an install command wrongly thought wired just gets a redundant -destination. */
function resolveTransport(transportType: string | undefined): DevicectlTransport {
  return transportType === "network" ? "network" : "wired";
}

export function parseDevicectlDevicesJson(raw: unknown): DevicectlPhysicalDevice[] {
  const parsed = DevicectlOutputSchema.safeParse(raw);
  if (!parsed.success) return [];

  const devices: DevicectlPhysicalDevice[] = [];
  for (const entry of parsed.data.result?.devices ?? []) {
    const hardware = entry.hardwareProperties;
    if (!hardware || hardware.reality !== "physical" || !hardware.udid) continue;
    devices.push({
      udid: hardware.udid,
      name:
        hardware.marketingName ??
        entry.deviceProperties?.name ??
        hardware.deviceType ??
        hardware.udid,
      deviceType: hardware.deviceType ?? "iPhone",
      ...(hardware.serialNumber ? { serialNumber: hardware.serialNumber } : {}),
      transport: resolveTransport(entry.connectionProperties?.transportType),
    });
  }
  return devices;
}
