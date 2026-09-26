import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PushLedger, type LedgerRecord } from "./ledger.js";
import type { PushReceiptVerdict } from "./push-service.js";
import { ReceiptTracker } from "./receipts.js";

const MINUTE = 60 * 1000;

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

function sentRecord(id: string, at: number, ticketIds: string[]): LedgerRecord {
  return {
    id,
    at: new Date(at).toISOString(),
    level: "alert",
    levelDeclared: true,
    reason: "test",
    title: id,
    body: "",
    agentId: null,
    outcome: "interrupt",
    state: "sent",
    repeatCount: 0,
    digestId: null,
    memberIds: [],
    error: null,
    settledAt: null,
    serverId: null,
    workspaceId: null,
    data: {},
    dedupeKey: null,
    tickets: ticketIds.map((ticketId) => ({
      token: `token-for-${ticketId}`,
      ticketId,
      status: "pending" as const,
      error: null,
      checkedAt: null,
    })),
  };
}

describe("ReceiptTracker", () => {
  let home: string;
  let now: number;
  let ledger: PushLedger;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-push-receipts-"));
    now = Date.parse("2026-09-23T12:00:00.000Z");
    ledger = new PushLedger(createLogger(), path.join(home, "push-ledger.json"), () => now);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function tracker(verdicts: Map<string, PushReceiptVerdict>, asked: string[][] = []) {
    return new ReceiptTracker({
      logger: createLogger(),
      ledger,
      now: () => now,
      fetchReceipts: async (tickets) => {
        asked.push(tickets.map((ticket) => ticket.ticketId));
        return verdicts;
      },
    });
  }

  test("does not ask for a receipt before the provider could have one", async () => {
    ledger.append(sentRecord("a", now, ["t1"]));
    const asked: string[][] = [];
    now += 5 * MINUTE;
    await tracker(new Map(), asked).checkDue();
    expect(asked).toEqual([]);
  });

  test("an ok receipt settles the notification as delivered", async () => {
    ledger.append(sentRecord("a", now, ["t1"]));
    now += 16 * MINUTE;
    await tracker(new Map([["t1", { status: "ok", error: null }]])).checkDue();
    expect(ledger.get("a")).toMatchObject({ state: "delivered", error: null });
    expect(ledger.countUnreached()).toBe(0);
  });

  test("an error receipt makes the notification unreached and keeps the reason", async () => {
    ledger.append(sentRecord("a", now, ["t1"]));
    now += 16 * MINUTE;
    await tracker(new Map([["t1", { status: "error", error: "DeviceNotRegistered" }]])).checkDue();
    expect(ledger.get("a")).toMatchObject({ state: "failed", error: "DeviceNotRegistered" });
    expect(ledger.listUnreached().map((record) => record.id)).toEqual(["a"]);
  });

  test("one device receiving it is enough to call it delivered", async () => {
    ledger.append(sentRecord("a", now, ["t1", "t2"]));
    now += 16 * MINUTE;
    await tracker(
      new Map<string, PushReceiptVerdict>([
        ["t1", { status: "error", error: "DeviceNotRegistered" }],
        ["t2", { status: "ok", error: null }],
      ]),
    ).checkDue();
    expect(ledger.get("a")).toMatchObject({ state: "delivered", error: null });
  });

  test("a receipt that is not there yet is asked for again next time", async () => {
    ledger.append(sentRecord("a", now, ["t1"]));
    now += 16 * MINUTE;
    const asked: string[][] = [];
    await tracker(new Map(), asked).checkDue();
    expect(ledger.get("a")?.state).toBe("sent");
    await tracker(new Map([["t1", { status: "ok", error: null }]]), asked).checkDue();
    expect(asked).toEqual([["t1"], ["t1"]]);
    expect(ledger.get("a")?.state).toBe("delivered");
  });

  test("stops asking after the provider has dropped its receipts, without calling it a failure", async () => {
    ledger.append(sentRecord("a", now, ["t1"]));
    now += 25 * 60 * MINUTE;
    const asked: string[][] = [];
    await tracker(new Map(), asked).checkDue();
    expect(asked).toEqual([]);
    expect(ledger.get("a")?.state).toBe("sent");
    expect(ledger.countUnreached()).toBe(0);
  });

  test("a receipt outage changes nothing", async () => {
    ledger.append(sentRecord("a", now, ["t1"]));
    now += 16 * MINUTE;
    await new ReceiptTracker({
      logger: createLogger(),
      ledger,
      now: () => now,
      fetchReceipts: async () => {
        throw new Error("network down");
      },
    }).checkDue();
    expect(ledger.get("a")?.state).toBe("sent");
  });
});
