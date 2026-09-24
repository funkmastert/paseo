import { describe, expect, test } from "vitest";
import { buildDaemonWedgedNotificationPayload } from "./daemon-vitals-notification.js";

describe("buildDaemonWedgedNotificationPayload", () => {
  test("says how long the daemon was wedged, and why, after the fact", () => {
    const payload = buildDaemonWedgedNotificationPayload({
      serverId: "srv-1",
      wedgedForMs: 94_400,
      cause: "blocked",
    });
    expect(payload.body).toContain("wedged for 94s");
    expect(payload.body).toContain("synchronous call");
    expect(payload.data).toEqual({
      serverId: "srv-1",
      reason: "daemon_event_loop_wedged",
      wedgedForMs: 94_400,
    });
  });

  test("a busy wedge says the daemon was computing", () => {
    const payload = buildDaemonWedgedNotificationPayload({
      serverId: "srv-1",
      wedgedForMs: 30_000,
      cause: "busy",
    });
    expect(payload.body).toContain("busy computing");
  });
});
