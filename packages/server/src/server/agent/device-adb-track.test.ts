import { describe, expect, test } from "vitest";
import { AdbTrackDevicesFrameReader, parseAdbDeviceListPayload } from "./device-adb-track.js";

/** Builds a real track-devices frame: 4 hex chars of length, then the payload bytes. */
function frame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.from(body.length.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([header, body]);
}

const REAL_PAYLOAD =
  "FAKESERIAL45291         device usb:0-1 product:fakeproduct model:Fake_Pixel_Device device:fakeproduct transport_id:3\n" +
  "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n";

describe("AdbTrackDevicesFrameReader", () => {
  test("parses a single frame delivered whole (the real shape captured from adb)", () => {
    const reader = new AdbTrackDevicesFrameReader();
    const payloads = reader.push(frame(REAL_PAYLOAD));

    expect(payloads).toEqual([REAL_PAYLOAD]);
  });

  test("reassembles a frame split across chunks, including mid-header", () => {
    const whole = frame(REAL_PAYLOAD);
    const reader = new AdbTrackDevicesFrameReader();

    expect(reader.push(whole.subarray(0, 2))).toEqual([]);
    expect(reader.push(whole.subarray(2, 50))).toEqual([]);
    expect(reader.push(whole.subarray(50))).toEqual([REAL_PAYLOAD]);
  });

  test("yields two frames delivered back to back in one chunk", () => {
    const reader = new AdbTrackDevicesFrameReader();
    const two = Buffer.concat([
      frame("FAKESERIAL45291 device\n"),
      frame("emulator-5554 offline\n"),
    ]);

    expect(reader.push(two)).toEqual(["FAKESERIAL45291 device\n", "emulator-5554 offline\n"]);
  });

  test("a corrupt length header drops the buffer instead of spinning forever", () => {
    const reader = new AdbTrackDevicesFrameReader();
    expect(reader.push(Buffer.from("ZZZZgarbage"))).toEqual([]);
    // Recovers on the next real frame.
    expect(reader.push(frame("FAKESERIAL45291 device\n"))).toEqual(["FAKESERIAL45291 device\n"]);
  });
});

describe("parseAdbDeviceListPayload", () => {
  test("parses the real captured payload: one physical device, the emulator ignored as such", () => {
    const devices = parseAdbDeviceListPayload(REAL_PAYLOAD);

    expect(devices).toEqual([
      {
        serial: "FAKESERIAL45291",
        state: "device",
        physical: true,
        wireless: false,
        properties: {
          usb: "0-1",
          product: "fakeproduct",
          model: "Fake_Pixel_Device",
          device: "fakeproduct",
          transport_id: "3",
        },
      },
      {
        serial: "emulator-5554",
        state: "device",
        physical: false,
        wireless: false,
        properties: {
          product: "sdk_gphone64_arm64",
          model: "sdk_gphone64_arm64",
          device: "emu64a",
          transport_id: "1",
        },
      },
    ]);
  });

  test("recognizes a wireless adb connect serial (host:port)", () => {
    const devices = parseAdbDeviceListPayload("192.168.1.42:5555 device product:x\n");
    expect(devices[0]).toMatchObject({ physical: true, wireless: true });
  });

  test("recognizes a wireless mDNS pairing serial", () => {
    const devices = parseAdbDeviceListPayload(
      "adb-4829FAKE01-a1b2c3._adb-tls-connect._tcp device product:x\n",
    );
    expect(devices[0]).toMatchObject({ physical: true, wireless: true });
  });

  test("captures offline and unauthorized states", () => {
    const devices = parseAdbDeviceListPayload(
      "FAKESERIAL45291 offline\n88817FDAS00999 unauthorized\n",
    );
    expect(devices.map((d) => d.state)).toEqual(["offline", "unauthorized"]);
  });

  test("an empty payload (everything disconnected) yields no devices", () => {
    expect(parseAdbDeviceListPayload("")).toEqual([]);
  });

  test("skips a header line if the caller's adb build still sends one", () => {
    const devices = parseAdbDeviceListPayload("List of devices attached\nFAKESERIAL45291 device\n");
    expect(devices).toHaveLength(1);
  });
});
