import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

describe("notification policy over an isolated daemon", () => {
  let daemon: TestPaseoDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    daemon = await createTestPaseoDaemon();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    await daemon.close();
  }, 30000);

  test("the daemon advertises the feature and starts on quiet defaults", async () => {
    expect(client.getLastServerInfoMessage()?.features?.notificationPolicy).toBe(true);
    const policy = await client.getNotificationPolicy();
    expect(policy.settings).toEqual({
      minPostLevel: "notice",
      minInterruptLevel: "alert",
      digestIntervalMinutes: 30,
      availability: { mode: "available", until: null },
    });
    expect(policy.heldCount).toBe(0);
    expect(policy.unreachedCount).toBe(0);
  });

  test("availability set from a client takes effect and is written to the daemon's home", async () => {
    const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const changed = await client.setNotificationPolicy({ availability: { mode: "focus", until } });
    expect(changed.effectiveAvailability).toEqual({ mode: "focus", until });

    const reread = await client.getNotificationPolicy();
    expect(reread.settings.availability).toEqual({ mode: "focus", until });

    const file = path.join(daemon.paseoHome, "notify-policy.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).settings.availability.mode).toBe("focus");
  });

  test("an availability that already ended reads back as available", async () => {
    const until = new Date(Date.now() - 1000).toISOString();
    const changed = await client.setNotificationPolicy({ availability: { mode: "away", until } });
    expect(changed.effectiveAvailability.mode).toBe("available");
  });

  test("the dials are changed independently of availability", async () => {
    await client.setNotificationPolicy({ minInterruptLevel: "urgent" });
    const changed = await client.setNotificationPolicy({ digestIntervalMinutes: 5 });
    expect(changed.settings).toMatchObject({
      minInterruptLevel: "urgent",
      digestIntervalMinutes: 5,
      availability: { mode: "available" },
    });
  });

  test("an empty ledger reads as empty", async () => {
    const ledger = await client.listNotificationLedger({ unreachedOnly: true });
    expect(ledger).toMatchObject({ entries: [], unreachedCount: 0 });
  });
});
