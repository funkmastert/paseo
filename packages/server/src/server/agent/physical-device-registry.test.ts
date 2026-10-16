import { describe, expect, test } from "vitest";
import {
  reconcilePhysicalDeviceLeases,
  selectFreePhysicalDevice,
  type PhysicalDevice,
  type PhysicalDeviceLease,
} from "./physical-device-registry.js";

const MINUTE = 60_000;

function device(overrides: Partial<PhysicalDevice> & { id: string }): PhysicalDevice {
  return { platform: "android", transport: "usb", ...overrides };
}

function lease(
  overrides: Partial<PhysicalDeviceLease> & { id: string; deviceId: string; agentId: string },
): PhysicalDeviceLease {
  return { platform: "android", source: "checkout", acquiredAtMs: 0, ...overrides };
}

describe("reconcilePhysicalDeviceLeases", () => {
  const base = {
    liveAgentIds: new Set(["a1"]),
    nowMs: 100 * MINUTE,
    graceMs: 30 * MINUTE,
    maxLeaseMs: 0,
  };

  test("a connected device's lease is untouched", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "a1" })],
      connectedDeviceIds: new Set(["SER1"]),
    });
    expect(result.leases).toEqual([lease({ id: "l1", deviceId: "SER1", agentId: "a1" })]);
    expect(result.released).toEqual([]);
  });

  test("a disconnected device keeps its lease inside the grace period", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "a1", disconnectedAtMs: 90 * MINUTE })],
      connectedDeviceIds: new Set(),
    });
    expect(result.released).toEqual([]);
    expect(result.leases[0]).toMatchObject({ disconnectedAtMs: 90 * MINUTE });
  });

  test("a device gone past the grace period releases the lease", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "a1", disconnectedAtMs: 60 * MINUTE })],
      connectedDeviceIds: new Set(),
    });
    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "device-disconnected" },
    ]);
  });

  test("reconnecting within the grace period keeps the holder and clears the timer", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "a1", disconnectedAtMs: 90 * MINUTE })],
      connectedDeviceIds: new Set(["SER1"]),
    });
    expect(result.released).toEqual([]);
    expect(result.leases[0].disconnectedAtMs).toBeUndefined();
  });

  test("starts the disconnect timer the first sweep a device is missing", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "a1" })],
      connectedDeviceIds: new Set(),
    });
    expect(result.released).toEqual([]);
    expect(result.leases[0].disconnectedAtMs).toBe(100 * MINUTE);
  });

  test("agent-gone releases regardless of connectivity", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "gone" })],
      connectedDeviceIds: new Set(["SER1"]),
    });
    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "agent-gone" },
    ]);
  });

  test("the maxLeaseHours backstop releases a long-held connected device", () => {
    const result = reconcilePhysicalDeviceLeases({
      ...base,
      maxLeaseMs: 10 * MINUTE,
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "a1", acquiredAtMs: 0 })],
      connectedDeviceIds: new Set(["SER1"]),
    });
    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "expired" },
    ]);
  });
});

describe("selectFreePhysicalDevice", () => {
  const noneReserved = new Set<string>();

  test("binds to the named device when it is connected and free", () => {
    const result = selectFreePhysicalDevice({
      platform: "android",
      namedDeviceId: "SER1",
      connectedDevices: [device({ id: "SER1" }), device({ id: "SER2" })],
      leases: [],
      reservedDeviceIds: noneReserved,
    });
    expect(result?.id).toBe("SER1");
  });

  test("a named device that is held returns undefined rather than stealing it", () => {
    const result = selectFreePhysicalDevice({
      platform: "android",
      namedDeviceId: "SER1",
      connectedDevices: [device({ id: "SER1" })],
      leases: [lease({ id: "l1", deviceId: "SER1", agentId: "other" })],
      reservedDeviceIds: noneReserved,
    });
    expect(result).toBeUndefined();
  });

  test("a named device that is reserved returns undefined", () => {
    const result = selectFreePhysicalDevice({
      platform: "android",
      namedDeviceId: "SER1",
      connectedDevices: [device({ id: "SER1" })],
      leases: [],
      reservedDeviceIds: new Set(["SER1"]),
    });
    expect(result).toBeUndefined();
  });

  test("without a name, picks the first free unreserved device of the platform", () => {
    const result = selectFreePhysicalDevice({
      platform: "ios",
      connectedDevices: [
        device({ id: "SER1", platform: "android" }),
        device({ id: "UDID2", platform: "ios" }),
        device({ id: "UDID1", platform: "ios" }),
      ],
      leases: [],
      reservedDeviceIds: noneReserved,
    });
    expect(result?.id).toBe("UDID1");
  });

  test("returns undefined when nothing of the platform is free", () => {
    const result = selectFreePhysicalDevice({
      platform: "ios",
      connectedDevices: [device({ id: "UDID1", platform: "ios" })],
      leases: [lease({ id: "l1", deviceId: "UDID1", agentId: "a1", platform: "ios" })],
      reservedDeviceIds: noneReserved,
    });
    expect(result).toBeUndefined();
  });
});
