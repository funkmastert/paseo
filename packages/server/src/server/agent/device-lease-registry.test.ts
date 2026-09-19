import { describe, expect, test } from "vitest";
import type { RunningDevice } from "./device-detection.js";
import {
  evaluateDeviceOccupancy,
  evaluateDeviceSlot,
  reconcileDeviceLeases,
  type DeviceLease,
} from "./device-lease-registry.js";

const MINUTE = 60_000;

function lease(overrides: Partial<DeviceLease> & { id: string; agentId: string }): DeviceLease {
  return {
    platform: "ios",
    source: "checkout",
    acquiredAtMs: 0,
    ...overrides,
  };
}

function device(overrides: Partial<RunningDevice> & { deviceId: string }): RunningDevice {
  return {
    platform: "ios",
    pid: 100,
    pids: [100],
    ...overrides,
  };
}

const caps = { totalSlots: 3, slotsPerPlatform: 2 };

describe("evaluateDeviceOccupancy", () => {
  test("counts a device Tyler booted by hand, with no lease anywhere", () => {
    const occupancy = evaluateDeviceOccupancy({
      runningDevices: [device({ deviceId: "UDID-1" })],
      leases: [],
    });

    expect(occupancy).toEqual({
      total: 1,
      byPlatform: { ios: 1, android: 0 },
      runningDevices: 1,
      pendingLeases: 0,
    });
  });

  test("a bound lease and its device are one slot, not two", () => {
    const occupancy = evaluateDeviceOccupancy({
      runningDevices: [device({ deviceId: "UDID-1" })],
      leases: [lease({ id: "l1", agentId: "a1", deviceId: "UDID-1" })],
    });

    expect(occupancy.total).toBe(1);
  });

  test("a lease whose device has not booted yet still holds a slot", () => {
    const occupancy = evaluateDeviceOccupancy({
      runningDevices: [device({ deviceId: "UDID-1" })],
      leases: [lease({ id: "l2", agentId: "a2" })],
    });

    expect(occupancy).toMatchObject({ total: 2, runningDevices: 1, pendingLeases: 1 });
  });
});

describe("evaluateDeviceSlot", () => {
  test("refuses past the per-platform cap while the total still has room", () => {
    const verdict = evaluateDeviceSlot({
      platform: "ios",
      runningDevices: [device({ deviceId: "UDID-1" }), device({ deviceId: "UDID-2" })],
      leases: [],
      caps,
    });

    expect(verdict).toMatchObject({ available: false, scope: "platform" });
    // The other platform's slot is still free — this is a per-platform cap, not a queue.
    expect(
      evaluateDeviceSlot({
        platform: "android",
        runningDevices: [device({ deviceId: "UDID-1" }), device({ deviceId: "UDID-2" })],
        leases: [],
        caps,
      }),
    ).toEqual({ available: true });
  });

  test("refuses past the total cap across platforms", () => {
    const running = [
      device({ deviceId: "UDID-1" }),
      device({ deviceId: "UDID-2" }),
      device({ deviceId: "Pixel_7", platform: "android" }),
    ];

    expect(
      evaluateDeviceSlot({ platform: "android", runningDevices: running, leases: [], caps }),
    ).toMatchObject({
      available: false,
      scope: "total",
    });
  });
});

describe("reconcileDeviceLeases", () => {
  const base = {
    liveAgentIds: new Set(["a1", "a2"]),
    nowMs: 10 * MINUTE,
    pendingTtlMs: 10 * MINUTE,
    maxLeaseMs: 0,
  };

  test("binds a pending lease to the device that appeared", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", agentId: "a1", acquiredAtMs: 9 * MINUTE })],
      runningDevices: [device({ deviceId: "UDID-1" })],
    });

    expect(result.leases[0]).toMatchObject({ id: "l1", deviceId: "UDID-1" });
    expect(result.unleasedDevices).toEqual([]);
  });

  test("prefers the lease whose agent's process tree owns the device", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [
        lease({ id: "older", agentId: "a1", platform: "android", acquiredAtMs: 1 }),
        lease({ id: "owner", agentId: "a2", platform: "android", acquiredAtMs: 2 }),
      ],
      runningDevices: [device({ deviceId: "Pixel_7", platform: "android", agentId: "a2" })],
    });

    expect(result.leases.find((entry) => entry.deviceId === "Pixel_7")?.id).toBe("owner");
  });

  test("never binds to a device that was already running when the lease was taken", () => {
    // Otherwise a fresh checkout adopts somebody else's simulator, frees the slot it is about
    // to fill, and the device it then boots puts the machine over the cap.
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "fresh", agentId: "a1", acquiredAtMs: 10 * MINUTE - 1_000 })],
      runningDevices: [device({ deviceId: "UDID-1", uptimeSeconds: 8040 })],
    });

    expect(result.leases[0].deviceId).toBeUndefined();
    expect(result.unleasedDevices.map((entry) => entry.deviceId)).toEqual(["UDID-1"]);
  });

  test("binds to the device that booted after the lease", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "fresh", agentId: "a1", acquiredAtMs: 10 * MINUTE - 60_000 })],
      runningDevices: [device({ deviceId: "UDID-1", uptimeSeconds: 30 })],
    });

    expect(result.leases[0].deviceId).toBe("UDID-1");
  });

  test("releases a bound lease as soon as its device stops", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", agentId: "a1", deviceId: "UDID-1" })],
      runningDevices: [],
    });

    expect(result.leases).toEqual([]);
    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "device-stopped" },
    ]);
  });

  test("releases a lease whose agent crashed before it booted anything", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", agentId: "gone" })],
      runningDevices: [],
    });

    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "agent-gone" },
    ]);
  });

  test("a crashed agent's still-running device keeps counting, now as unleased", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", agentId: "gone", deviceId: "UDID-1" })],
      runningDevices: [device({ deviceId: "UDID-1" })],
    });

    expect(result.leases).toEqual([]);
    expect(result.released[0].reason).toBe("agent-gone");
    expect(result.unleasedDevices.map((entry) => entry.deviceId)).toEqual(["UDID-1"]);
    // The point of the union rule: dropping the lease does not drop the slot.
    expect(
      evaluateDeviceOccupancy({ runningDevices: result.unleasedDevices, leases: result.leases })
        .total,
    ).toBe(1);
  });

  test("expires a lease that never became a device", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", agentId: "a1", acquiredAtMs: 0 })],
      runningDevices: [],
    });

    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "never-started" },
    ]);
  });

  test("keeps a young pending lease through the boot window", () => {
    const result = reconcileDeviceLeases({
      ...base,
      leases: [lease({ id: "l1", agentId: "a1", acquiredAtMs: 9 * MINUTE })],
      runningDevices: [],
    });

    expect(result.released).toEqual([]);
    expect(result.leases.map((entry) => entry.id)).toEqual(["l1"]);
  });

  test("expires a bound lease at the backstop age", () => {
    const result = reconcileDeviceLeases({
      ...base,
      maxLeaseMs: 5 * MINUTE,
      leases: [lease({ id: "l1", agentId: "a1", deviceId: "UDID-1", acquiredAtMs: 0 })],
      runningDevices: [device({ deviceId: "UDID-1" })],
    });

    expect(result.released).toEqual([
      { lease: expect.objectContaining({ id: "l1" }), reason: "expired" },
    ]);
    expect(result.unleasedDevices.map((entry) => entry.deviceId)).toEqual(["UDID-1"]);
  });
});
