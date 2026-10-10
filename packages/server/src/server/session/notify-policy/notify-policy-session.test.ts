import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { SessionOutboundMessage } from "../../messages.js";
import { NotifyPolicy } from "../../notify-policy/notify-policy.js";
import { NotifyPolicySettingsStore } from "../../notify-policy/settings.js";
import { PushLedger } from "../../push/ledger.js";
import { NotifyPolicySession } from "./notify-policy-session.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("NotifyPolicySession", () => {
  let home: string;
  let emitted: SessionOutboundMessage[];
  let policy: NotifyPolicy;
  let session: NotifyPolicySession;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-notify-policy-session-"));
    emitted = [];
    const logger = createLogger();
    policy = new NotifyPolicy({
      logger,
      ledger: new PushLedger(logger, path.join(home, "ledger.json"), Date.now),
      settings: new NotifyPolicySettingsStore(logger, path.join(home, "settings.json")),
      // No phone is registered, so every push ends in the ledger as unreached.
      transport: { activeTokens: () => [], deliver: async () => [] },
    });
    session = new NotifyPolicySession({
      host: { emit: (message) => emitted.push(message) },
      getNotifyPolicy: () => policy,
      logger,
    });
  });

  afterEach(() => {
    policy.stop();
    rmSync(home, { recursive: true, force: true });
  });

  test("get returns the defaults and the in-force availability", async () => {
    await session.handlePolicyRequest({
      type: "notifications.policy.get.request",
      requestId: "r1",
    });
    expect(emitted).toEqual([
      {
        type: "notifications.policy.get.response",
        payload: {
          requestId: "r1",
          settings: {
            minPostLevel: "notice",
            minInterruptLevel: "alert",
            digestIntervalMinutes: 30,
            availability: { mode: "available", until: null },
          },
          effectiveAvailability: { mode: "available", until: null },
          heldCount: 0,
          unreachedCount: 0,
        },
      },
    ]);
  });

  test("set changes only the fields it names", async () => {
    await session.handlePolicyRequest({
      type: "notifications.policy.set.request",
      requestId: "r1",
      availability: { mode: "focus" },
    });
    await session.handlePolicyRequest({
      type: "notifications.policy.set.request",
      requestId: "r2",
      minInterruptLevel: "urgent",
    });
    const last = emitted.at(-1);
    expect(last).toMatchObject({
      type: "notifications.policy.set.response",
      payload: {
        settings: {
          minPostLevel: "notice",
          minInterruptLevel: "urgent",
          availability: { mode: "focus" },
        },
        effectiveAvailability: { mode: "focus" },
      },
    });
  });

  test("the ledger lists unreached pushes and counts them", async () => {
    await policy.submit({ title: "Agent finished", body: "Done" }, { level: "alert" });
    await policy.submit({ title: "Fast agent", body: "Busy" }, { level: "notice" });
    session.handleLedgerListRequest({
      type: "notifications.ledger.list.request",
      requestId: "r1",
      unreachedOnly: true,
    });
    expect(emitted[0]).toMatchObject({
      type: "notifications.ledger.list.response",
      payload: {
        requestId: "r1",
        unreachedCount: 1,
        entries: [{ title: "Agent finished", state: "no-device" }],
      },
    });
  });

  test("a failure comes back as an rpc error, not silence", async () => {
    session = new NotifyPolicySession({
      host: { emit: (message) => emitted.push(message) },
      getNotifyPolicy: () => {
        throw new Error("policy unavailable");
      },
      logger: createLogger(),
    });
    await session.handlePolicyRequest({
      type: "notifications.policy.get.request",
      requestId: "r1",
    });
    expect(emitted).toMatchObject([
      { type: "rpc_error", payload: { requestId: "r1", error: "policy unavailable" } },
    ]);
  });
});
