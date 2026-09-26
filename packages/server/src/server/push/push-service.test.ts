import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";

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

function stubFetch(handler: (url: string, body: unknown) => unknown, status = 200) {
  const calls: Array<{ url: string; body: Array<Record<string, unknown>> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      return { ok: status === 200, status, statusText: "", json: async () => handler(url, body) };
    }),
  );
  return calls;
}

describe("PushService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a loud push plays a sound; a quiet one posts without", async () => {
    const calls = stubFetch(() => ({ data: [{ status: "ok", id: "t1" }] }));
    const service = new PushService(createLogger(), () => undefined);
    await service.sendPush(["tok"], { title: "T", body: "B" }, { quiet: false });
    await service.sendPush(["tok"], { title: "T", body: "B" }, { quiet: true });
    await service.sendPush(
      ["tok"],
      { title: "T", body: "B" },
      { quiet: false, timeSensitive: true },
    );

    const [loud, quiet, urgent] = calls.map((call) => call.body[0]);
    expect(loud).toMatchObject({ sound: "default", priority: "high", interruptionLevel: "active" });
    expect(quiet).toMatchObject({
      sound: null,
      priority: "normal",
      interruptionLevel: "passive",
      channelId: "quiet",
    });
    expect(urgent).toMatchObject({ interruptionLevel: "time-sensitive" });
  });

  test("returns a ticket id per device and a reason for each refusal", async () => {
    stubFetch(() => ({
      data: [
        { status: "ok", id: "t1" },
        { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      ],
    }));
    const revoked: string[] = [];
    const service = new PushService(createLogger(), (token) => revoked.push(token));
    const results = await service.sendPush(["a", "b"], { title: "T", body: "B" });
    expect(results).toEqual([
      { token: "a", ticketId: "t1", error: null },
      { token: "b", ticketId: null, error: "DeviceNotRegistered" },
    ]);
    expect(revoked).toEqual(["b"]);
  });

  test("an unreachable push API fails every device instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const service = new PushService(createLogger(), () => undefined);
    const results = await service.sendPush(["a", "b"], { title: "T", body: "B" });
    expect(results.map((result) => result.error)).toEqual(["offline", "offline"]);
  });

  test("reads receipts, skipping ids that have none yet, and revokes dead devices", async () => {
    stubFetch(() => ({
      data: {
        t1: { status: "ok" },
        t2: { status: "error", details: { error: "DeviceNotRegistered" } },
      },
    }));
    const revoked: string[] = [];
    const service = new PushService(createLogger(), (token) => revoked.push(token));
    const verdicts = await service.fetchReceipts([
      { ticketId: "t1", token: "a" },
      { ticketId: "t2", token: "b" },
      { ticketId: "t3", token: "c" },
    ]);
    expect([...verdicts]).toEqual([
      ["t1", { status: "ok", error: null }],
      ["t2", { status: "error", error: "DeviceNotRegistered" }],
    ]);
    expect(revoked).toEqual(["b"]);
  });
});
