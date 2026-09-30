import { describe, expect, test } from "vitest";
import { parseDevicectlDevicesJson } from "./device-devicectl.js";

/** Shaped like a real `devicectl list devices --json-output` capture on this machine, with
 * fake identifiers throughout. */
function fixture() {
  return {
    info: { commandType: "devicectl.list.devices", outcome: "success" },
    result: {
      devices: [
        {
          hardwareProperties: {
            reality: "physical",
            udid: "00001234-000FAKE01E2C1CE",
            deviceType: "iPhone",
            marketingName: "iPhone 16e",
            serialNumber: "FAKESN0001",
          },
          connectionProperties: { transportType: "wired" },
        },
        {
          // A physical device paired over the network, no cable.
          hardwareProperties: {
            reality: "physical",
            udid: "00002345-000FAKE02E3D2DF",
            deviceType: "iPhone",
            marketingName: "iPhone 17 Pro (network)",
          },
          connectionProperties: { transportType: "network" },
        },
        {
          // A simulator — must be excluded, it's covered by the process scan.
          hardwareProperties: {
            reality: "simulated",
            udid: "10000000-0000-0000-0000-000000000000",
            deviceType: "iPhone",
            marketingName: "iPhone 17 Pro",
          },
          connectionProperties: { transportType: "wired" },
        },
      ],
    },
  };
}

describe("parseDevicectlDevicesJson", () => {
  test("keeps only physical devices, mapping the fields the gate needs", () => {
    const devices = parseDevicectlDevicesJson(fixture());

    expect(devices).toEqual([
      {
        udid: "00001234-000FAKE01E2C1CE",
        name: "iPhone 16e",
        deviceType: "iPhone",
        serialNumber: "FAKESN0001",
        transport: "wired",
      },
      {
        udid: "00002345-000FAKE02E3D2DF",
        name: "iPhone 17 Pro (network)",
        deviceType: "iPhone",
        transport: "network",
      },
    ]);
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

  test("defaults transport to wired when devicectl omits transportType", () => {
    const devices = parseDevicectlDevicesJson({
      result: {
        devices: [
          {
            hardwareProperties: { reality: "physical", udid: "u1", deviceType: "iPhone" },
          },
        ],
      },
    });
    expect(devices[0]?.transport).toBe("wired");
  });
});
