import { describe, expect, test } from "vitest";
import { parseDevicectlDevicesJson, toPhysicalIosDevices } from "./device-devicectl.js";

/**
 * Shaped like a real `devicectl list devices --json-output` capture (Xcode 26, CoreDevice), with
 * fake identifiers throughout. CoreDevice's transport values are `wired`, `localNetwork` and
 * `sameMachine` (simulators); a paired device that can't be reached carries no transport and a
 * `tunnelState` of `unavailable`. A reachable Wi-Fi iPhone reads `tunnelState: "disconnected"`
 * — that field tracks devicectl's own tunnel session, not reachability. It reads `connected`
 * only while something (an install, Xcode) is talking to the phone.
 */
function fixture() {
  return {
    info: { commandType: "devicectl.list.devices", outcome: "success" },
    result: {
      devices: [
        {
          identifier: "11111111-2222-3333-4444-FAKE00000001",
          visibilityClass: "default",
          hardwareProperties: {
            reality: "physical",
            udid: "00001234-000FAKE01E2C1CE",
            deviceType: "iPhone",
            marketingName: "iPhone 16e",
            serialNumber: "FAKESN0001",
          },
          deviceProperties: { name: "Fake iPhone", bootState: "booted" },
          connectionProperties: {
            pairingState: "paired",
            transportType: "wired",
            tunnelState: "connected",
          },
        },
        {
          // Paired over Wi-Fi, no cable, reachable right now.
          identifier: "11111111-2222-3333-4444-FAKE00000002",
          visibilityClass: "default",
          hardwareProperties: {
            reality: "physical",
            udid: "00002345-000FAKE02E3D2DF",
            deviceType: "iPhone",
            marketingName: "iPhone 17 Pro",
          },
          deviceProperties: { name: "Fake Wi-Fi iPhone", bootState: "booted" },
          connectionProperties: {
            pairingState: "paired",
            transportType: "localNetwork",
            tunnelState: "disconnected",
            tunnelTransportProtocol: "tcp",
          },
        },
        {
          // Paired, but it left the network: listed, and not reachable.
          identifier: "11111111-2222-3333-4444-FAKE00000003",
          visibilityClass: "default",
          hardwareProperties: {
            reality: "physical",
            udid: "00003456-000FAKE03E4E3E0",
            deviceType: "iPhone",
            marketingName: "iPhone 15",
          },
          deviceProperties: { name: "Fake Gone iPhone" },
          connectionProperties: { pairingState: "paired", tunnelState: "unavailable" },
        },
        {
          // A simulator — covered by the process scan.
          identifier: "10000000-0000-0000-0000-000000000000",
          visibilityClass: "simulators",
          hardwareProperties: {
            reality: "simulated",
            udid: "10000000-0000-0000-0000-000000000000",
            deviceType: "iPhone",
            marketingName: "iPhone 17 Pro",
          },
          deviceProperties: { name: "iPhone 17 Pro", bootState: "booted" },
          connectionProperties: { transportType: "sameMachine", tunnelState: "disconnected" },
        },
      ],
    },
  };
}

describe("parseDevicectlDevicesJson", () => {
  test("keeps reachable physical devices: wired is USB, localNetwork is Wi-Fi", () => {
    expect(parseDevicectlDevicesJson(fixture())).toEqual([
      {
        udid: "00001234-000FAKE01E2C1CE",
        identifier: "11111111-2222-3333-4444-FAKE00000001",
        name: "iPhone 16e",
        deviceName: "Fake iPhone",
        deviceType: "iPhone",
        serialNumber: "FAKESN0001",
        transport: "wired",
        idle: false,
      },
      {
        udid: "00002345-000FAKE02E3D2DF",
        identifier: "11111111-2222-3333-4444-FAKE00000002",
        name: "iPhone 17 Pro",
        deviceName: "Fake Wi-Fi iPhone",
        deviceType: "iPhone",
        transport: "network",
        idle: true,
      },
    ]);
  });

  test("a Wi-Fi iPhone is idle until something opens a tunnel to it", () => {
    const devices = parseDevicectlDevicesJson({
      result: {
        devices: [
          {
            hardwareProperties: { reality: "physical", udid: "in-use", deviceType: "iPhone" },
            connectionProperties: { transportType: "localNetwork", tunnelState: "connected" },
          },
          {
            hardwareProperties: { reality: "physical", udid: "paired-only", deviceType: "iPhone" },
            connectionProperties: { transportType: "localNetwork", tunnelState: "disconnected" },
          },
          {
            hardwareProperties: {
              reality: "physical",
              udid: "no-tunnel-field",
              deviceType: "iPhone",
            },
            connectionProperties: { transportType: "localNetwork" },
          },
          {
            // Plugged in: a cable is in use whatever the tunnel says.
            hardwareProperties: { reality: "physical", udid: "wired", deviceType: "iPhone" },
            connectionProperties: { transportType: "wired", tunnelState: "disconnected" },
          },
        ],
      },
    });
    expect(devices.map((device) => [device.udid, device.idle])).toEqual([
      ["in-use", false],
      ["paired-only", true],
      ["no-tunnel-field", true],
      ["wired", false],
    ]);
  });

  test("toPhysicalIosDevices carries idle, transport and both aliases through to the gate", () => {
    expect(toPhysicalIosDevices(parseDevicectlDevicesJson(fixture()))).toEqual([
      {
        id: "00001234-000FAKE01E2C1CE",
        platform: "ios",
        transport: "usb",
        idle: false,
        name: "iPhone 16e",
        aliases: ["11111111-2222-3333-4444-FAKE00000001", "Fake iPhone"],
      },
      {
        id: "00002345-000FAKE02E3D2DF",
        platform: "ios",
        transport: "network",
        idle: true,
        name: "iPhone 17 Pro",
        aliases: ["11111111-2222-3333-4444-FAKE00000002", "Fake Wi-Fi iPhone"],
      },
    ]);
  });

  test("a paired iPhone that can't be reached is not connected", () => {
    const udids = parseDevicectlDevicesJson(fixture()).map((device) => device.udid);
    expect(udids).not.toContain("00003456-000FAKE03E4E3E0");
  });

  test("a device with a transport but an unavailable tunnel is not connected", () => {
    const devices = parseDevicectlDevicesJson({
      result: {
        devices: [
          {
            hardwareProperties: { reality: "physical", udid: "u1", deviceType: "iPhone" },
            connectionProperties: { transportType: "localNetwork", tunnelState: "unavailable" },
          },
        ],
      },
    });
    expect(devices).toEqual([]);
  });

  test("simulators never appear even with reality omitted-but-udid-present edge cases", () => {
    const devices = parseDevicectlDevicesJson({
      result: {
        devices: [
          { hardwareProperties: { udid: "no-reality-field" } },
          { hardwareProperties: { reality: "simulated", udid: "sim" } },
        ],
      },
    });
    expect(devices).toEqual([]);
  });

  test("malformed or empty input fails open to an empty list, never throws", () => {
    expect(parseDevicectlDevicesJson(null)).toEqual([]);
    expect(parseDevicectlDevicesJson(undefined)).toEqual([]);
    expect(parseDevicectlDevicesJson({})).toEqual([]);
    expect(parseDevicectlDevicesJson("not even an object")).toEqual([]);
    expect(parseDevicectlDevicesJson({ result: {} })).toEqual([]);
  });
});
