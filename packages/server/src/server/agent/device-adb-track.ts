/**
 * Parses `adb track-devices -l`'s wire format: the same framing the adb host protocol always
 * uses (4 ASCII hex characters giving the payload's byte length, then that many bytes), which
 * the CLI subcommand relays unmodified. Verified against the real adb on this machine
 * (docs/device-leases.md, Physical devices): `adb track-devices -l` run for ~2s captured
 * `00d6<214 bytes of devices -l output>`.
 *
 * Every frame is the FULL current device list, not a diff — `AdbTrackDevicesService` is what
 * turns a sequence of frames into connect/disconnect events.
 */

export type AdbDeviceConnectionState =
  | "device"
  | "offline"
  | "unauthorized"
  | "authorizing"
  | "no permissions"
  | "bootloader"
  | "recovery"
  | "sideload"
  | "host"
  | "connecting";

export interface AdbTrackedDevice {
  serial: string;
  state: AdbDeviceConnectionState;
  /** False for `emulator-<port>` serials — those are the emulator, not a physical device. */
  physical: boolean;
  /** True for a TCP serial (`host:port`) or the mDNS `adb-<id>._adb-tls-connect._tcp` form. */
  wireless: boolean;
  properties: Record<string, string>;
}

const KNOWN_STATES = new Set<AdbDeviceConnectionState>([
  "device",
  "offline",
  "unauthorized",
  "authorizing",
  "no permissions",
  "bootloader",
  "recovery",
  "sideload",
  "host",
  "connecting",
]);

function isWirelessSerial(serial: string): boolean {
  // `adb connect host:port` -> `192.168.1.5:5555`. Paired-over-network mDNS serials look like
  // `adb-XXXXXXXX-XXXXXX._adb-tls-connect._tcp` or `adb-XXXXXXXX-XXXXXX._adb-tls-connect._tcp.local`.
  if (/^[\w.-]+:\d+$/.test(serial)) return true;
  if (serial.startsWith("adb-") && serial.includes("._adb-tls-connect._tcp")) return true;
  return false;
}

/** One `adb devices -l`-shaped line: `<serial>\s+<state>(\s+<key>:<value>)*`. Malformed lines
 * (a blank line, the "List of devices attached" header some callers still send) are skipped. */
function parseDeviceLine(line: string): AdbTrackedDevice | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return undefined;
  const [serial, rawState, ...rest] = tokens;
  if (!serial || serial === "List") return undefined;
  const state = KNOWN_STATES.has(rawState as AdbDeviceConnectionState)
    ? (rawState as AdbDeviceConnectionState)
    : undefined;
  if (!state) return undefined;

  const properties: Record<string, string> = {};
  for (const token of rest) {
    const separator = token.indexOf(":");
    if (separator <= 0) continue;
    properties[token.slice(0, separator)] = token.slice(separator + 1);
  }

  return {
    serial,
    state,
    physical: !serial.startsWith("emulator-"),
    wireless: isWirelessSerial(serial),
    properties,
  };
}

/** Every device line in one frame's payload — the full list as of that frame. */
export function parseAdbDeviceListPayload(payload: string): AdbTrackedDevice[] {
  const devices: AdbTrackedDevice[] = [];
  for (const line of payload.split("\n")) {
    const device = parseDeviceLine(line);
    if (device) devices.push(device);
  }
  return devices;
}

/**
 * Accumulates bytes across chunks and yields each complete frame's raw payload text as soon as
 * it is available — a frame's length header can itself be split across two `data` events, and
 * one `data` event can carry more than one frame back to back.
 */
export class AdbTrackDevicesFrameReader {
  private buffer = Buffer.alloc(0);

  /** Returns every complete frame payload found once `chunk` is appended. */
  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const payloads: string[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const lengthHex = this.buffer.subarray(0, 4).toString("ascii");
      const length = Number.parseInt(lengthHex, 16);
      if (!Number.isFinite(length)) {
        // A corrupt stream can never resync on its own; drop everything rather than spin.
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < 4 + length) break;
      payloads.push(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return payloads;
  }
}
