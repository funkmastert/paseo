/**
 * Parses `xcrun devicectl list devices --json-output <file>`, keeping only physical devices that
 * can be reached right now — `reality: "simulated"` entries are simulators, already covered by
 * the process scan.
 *
 * Fields, from real captures (docs/device-leases.md, Physical devices):
 * `result.devices[].identifier` (the CoreDevice identifier, which `devicectl --device` accepts;
 * it is not the UDID), `.hardwareProperties.{reality,udid,deviceType,marketingName,serialNumber}`,
 * `.deviceProperties.name` (the name Tyler gave the phone), and
 * `.connectionProperties.{transportType,tunnelState}`.
 *
 * Reachability: devicectl lists every PAIRED device, reachable or not. CoreDevice's transports
 * are `wired` (USB), `localNetwork` (Wi-Fi) and `sameMachine` (simulators). A paired iPhone that
 * left the network has no transport and a `tunnelState` of `unavailable`. `tunnelState` is
 * otherwise about devicectl's own tunnel session — a reachable Wi-Fi iPhone reads
 * `disconnected` — so only `unavailable` means anything here.
 */

import { z } from "zod";

export type DevicectlTransport = "wired" | "network";

export interface DevicectlPhysicalDevice {
  udid: string;
  /** CoreDevice's own identifier — a second id `devicectl --device` accepts. */
  identifier?: string;
  /** The model's marketing name ("iPhone 16e"), which commands also use to name a device. */
  name: string;
  /** The name the owner gave the phone, when devicectl reports one. */
  deviceName?: string;
  deviceType: string;
  serialNumber?: string;
  transport: DevicectlTransport;
}

const DevicectlDeviceSchema = z.object({
  identifier: z.string().optional(),
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
      tunnelState: z.string().optional(),
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

const TRANSPORTS: Readonly<Record<string, DevicectlTransport>> = {
  wired: "wired",
  localNetwork: "network",
};

type DevicectlDeviceEntry = z.infer<typeof DevicectlDeviceSchema>;

/** One devicectl entry as a reachable physical device, or undefined for a simulator or a
 * paired device that can't be reached right now. */
function toPhysicalDevice(entry: DevicectlDeviceEntry): DevicectlPhysicalDevice | undefined {
  const hardware = entry.hardwareProperties;
  if (!hardware || hardware.reality !== "physical" || !hardware.udid) return undefined;
  const connection = entry.connectionProperties;
  const transport = TRANSPORTS[connection?.transportType ?? ""];
  if (!transport || connection?.tunnelState === "unavailable") return undefined;
  const deviceName = entry.deviceProperties?.name;
  return {
    udid: hardware.udid,
    ...(entry.identifier ? { identifier: entry.identifier } : {}),
    name: hardware.marketingName ?? deviceName ?? hardware.deviceType ?? hardware.udid,
    ...(deviceName ? { deviceName } : {}),
    deviceType: hardware.deviceType ?? "iPhone",
    ...(hardware.serialNumber ? { serialNumber: hardware.serialNumber } : {}),
    transport,
  };
}

export function parseDevicectlDevicesJson(raw: unknown): DevicectlPhysicalDevice[] {
  const parsed = DevicectlOutputSchema.safeParse(raw);
  if (!parsed.success) return [];
  return (parsed.data.result?.devices ?? [])
    .map(toPhysicalDevice)
    .filter((device): device is DevicectlPhysicalDevice => device !== undefined);
}
