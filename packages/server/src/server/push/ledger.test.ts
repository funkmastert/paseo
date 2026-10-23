import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PushLedger, toWireEntry, type LedgerRecord, type LedgerTicket } from "./ledger.js";

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

function record(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    id: "r1",
    at: "2026-10-13T12:00:00.000Z",
    level: "urgent",
    levelDeclared: true,
    reason: null,
    title: "Claude account signed out",
    body: "claude-backup needs you to sign in again.",
    agentId: null,
    outcome: "interrupt",
    state: "held",
    repeatCount: 0,
    digestId: null,
    memberIds: [],
    error: null,
    settledAt: null,
    serverId: null,
    workspaceId: null,
    data: {},
    dedupeKey: null,
    tickets: [],
    ...overrides,
  };
}

function transportFailedTicket(overrides: Partial<LedgerTicket> = {}): LedgerTicket {
  return {
    token: "tok",
    ticketId: null,
    status: "error",
    error: "fetch failed",
    checkedAt: null,
    transportFailure: true,
    ...overrides,
  };
}

describe("PushLedger retry bookkeeping", () => {
  let home: string;
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-push-ledger-"));
    now = Date.parse("2026-10-13T12:00:00.000Z");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function create(): PushLedger {
    return new PushLedger(createLogger(), path.join(home, "push-ledger.json"), () => now);
  }

  test("scheduleRetry sets nextRetryAt and retryCount, absent by default", () => {
    const ledger = create();
    ledger.append(record());
    expect(ledger.get("r1")?.nextRetryAt).toBeUndefined();
    expect(ledger.get("r1")?.retryCount).toBeUndefined();

    ledger.scheduleRetry("r1", "2026-10-13T12:01:00.000Z", 1);
    expect(ledger.get("r1")).toMatchObject({
      nextRetryAt: "2026-10-13T12:01:00.000Z",
      retryCount: 1,
    });
    expect(ledger.listPendingRetries().map((r) => r.id)).toEqual(["r1"]);
  });

  test("markSent clears a pending retry, whether it delivered or failed again", () => {
    const ledger = create();
    ledger.append(record());
    ledger.scheduleRetry("r1", "2026-10-13T12:01:00.000Z", 1);
    expect(ledger.listPendingRetries()).toHaveLength(1);

    ledger.markSent("r1", [transportFailedTicket()], null, "2026-10-13T12:01:00.000Z");
    expect(ledger.get("r1")?.nextRetryAt).toBeNull();
    expect(ledger.listPendingRetries()).toHaveLength(0);
    // retryCount is left as the attempt history; the caller decides whether to schedule another.
    expect(ledger.get("r1")?.retryCount).toBe(1);
  });

  test("markFailed clears a pending retry permanently", () => {
    const ledger = create();
    ledger.append(record());
    ledger.scheduleRetry("r1", "2026-10-13T12:01:00.000Z", 1);
    ledger.markFailed("r1", "push retries exhausted", "2026-10-13T14:01:00.000Z");
    expect(ledger.get("r1")?.nextRetryAt).toBeNull();
    expect(ledger.listPendingRetries()).toHaveLength(0);
    expect(ledger.get("r1")?.state).toBe("failed");
  });

  test("an old ledger file with no retry fields still loads", () => {
    const filePath = path.join(home, "push-ledger.json");
    const { retryCount: _retryCount, nextRetryAt: _nextRetryAt, ...withoutRetryFields } = record();
    writeFileSync(filePath, JSON.stringify({ records: [withoutRetryFields] }));
    const ledger = new PushLedger(createLogger(), filePath, () => now);
    expect(ledger.get("r1")).toBeTruthy();
    expect(ledger.listPendingRetries()).toHaveLength(0);
  });

  test("retryCount and nextRetryAt never reach the wire", () => {
    const ledger = create();
    ledger.append(record());
    ledger.scheduleRetry("r1", "2026-10-13T12:01:00.000Z", 1);
    const wire = toWireEntry(ledger.get("r1")!);
    expect(wire).not.toHaveProperty("nextRetryAt");
    expect(wire).not.toHaveProperty("retryCount");
  });

  test("the timing math between attempts stays within the backoff window", () => {
    const ledger = create();
    ledger.append(record());
    ledger.scheduleRetry("r1", new Date(now + MINUTE).toISOString(), 1);
    const pending = ledger.listPendingRetries()[0]!;
    expect(Date.parse(pending.nextRetryAt!) - now).toBe(MINUTE);
  });
});
