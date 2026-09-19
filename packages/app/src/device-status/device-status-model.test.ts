import { describe, expect, test } from "vitest";
import type { DeviceStatusUpdateMessage } from "@getpaseo/protocol/messages";
import { buildDeviceStatusStripModel } from "./device-status-model";

type Payload = DeviceStatusUpdateMessage["payload"];

function payload(overrides: Partial<Payload> = {}): Payload {
  return {
    enabled: true,
    dryRun: false,
    totalSlots: 3,
    slotsPerPlatform: 2,
    used: 0,
    devices: [],
    waiting: [],
    blocked: [],
    generatedAt: "2026-09-18T16:00:00.000Z",
    ...overrides,
  };
}

describe("buildDeviceStatusStripModel", () => {
  test("shows nothing when no device is running and nobody is waiting", () => {
    expect(buildDeviceStatusStripModel(payload()).hasData).toBe(false);
    expect(buildDeviceStatusStripModel(undefined).hasData).toBe(false);
  });

  test("names the holding agent by title, not by id", () => {
    const model = buildDeviceStatusStripModel(
      payload({
        used: 1,
        devices: [
          {
            platform: "ios",
            deviceId: "A0A912ED-C766-4778-957C-F9680C7309F3",
            state: "running",
            attribution: "lease",
            agentId: "agent-1",
            heldForSeconds: 8040,
            source: "checkout",
            reason: "run the UI tests",
          },
        ],
      }),
      { "agent-1": "iOS review" },
    );

    expect(model.rows).toEqual([
      {
        key: "A0A912ED-C766-4778-957C-F9680C7309F3",
        platform: "ios",
        // A UDID is 36 characters of noise in a sidebar.
        label: "A0A912ED",
        holderKey: "heldBy",
        agentId: "agent-1",
        agentLabel: "iOS review",
        heldForSeconds: 8040,
        reason: "run the UI tests",
      },
    ]);
  });

  test("reports a device nobody leased rather than hiding it", () => {
    const model = buildDeviceStatusStripModel(
      payload({
        used: 1,
        devices: [
          {
            platform: "ios",
            deviceId: "A0A912ED-C766-4778-957C-F9680C7309F3",
            state: "running",
            attribution: "none",
            // ps's elapsed column, so "how long" is answerable with no lease at all.
            heldForSeconds: 8040,
          },
        ],
      }),
    );

    expect(model.rows[0]).toMatchObject({ holderKey: "unleased", heldForSeconds: 8040 });
    expect(model.unleasedCount).toBe(1);
  });

  test("a checked-out slot with no device yet reads as starting", () => {
    const model = buildDeviceStatusStripModel(
      payload({
        used: 1,
        devices: [
          {
            platform: "android",
            deviceId: null,
            state: "starting",
            attribution: "lease",
            agentId: "agent-2",
            heldForSeconds: 12,
          },
        ],
      }),
    );

    expect(model.rows[0]).toMatchObject({ holderKey: "starting", label: "", platform: "android" });
    expect(model.unleasedCount).toBe(0);
  });

  test("tone warns at the cap and flags going over it", () => {
    expect(buildDeviceStatusStripModel(payload({ used: 1 })).tone).toBe("ok");
    expect(buildDeviceStatusStripModel(payload({ used: 3 })).tone).toBe("warning");
    // Reachable: devices booted before the cap was turned on still count.
    expect(buildDeviceStatusStripModel(payload({ used: 4 })).tone).toBe("danger");
  });
});
