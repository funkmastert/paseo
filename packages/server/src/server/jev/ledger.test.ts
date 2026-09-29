import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { JevCost, JevFeatureId, JevLane } from "./contract.js";
import { JevLedger, localDay, nextLocalMidnight, type JevLedgerEntry } from "./ledger.js";

const logger = pino({ level: "silent" });

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function reported(usd: number): JevCost {
  return { usd, source: "reported" };
}

function estimated(usd: number): JevCost {
  return { usd, source: "estimated" };
}

function makeEntry(overrides: Partial<JevLedgerEntry> = {}): JevLedgerEntry {
  return {
    callId: `call-${Math.random().toString(36).slice(2)}`,
    at: new Date().toISOString(),
    feature: "spawnHint",
    lane: "control",
    callSite: "test.call-site",
    subjectAgentIds: [],
    outcome: "answered",
    reason: null,
    exclusionSignal: null,
    model: "jev-fake",
    attempts: 1,
    elapsedMs: 10,
    stateBytes: 100,
    bodyBytes: 200,
    redactions: 0,
    questionCount: 1,
    inputTokens: 50,
    outputTokens: 5,
    cost: reported(0.001),
    verdicts: ["task_class: mechanical 0.9"],
    chargedAgentId: null,
    ...overrides,
  };
}

function makeLedger(
  options: {
    now?: () => number;
    filePath?: string;
    writeFile?: (filePath: string, data: string) => Promise<void>;
    onBudgetExhausted?: (event: {
      lane: JevLane;
      topFeature: JevFeatureId | null;
      resetsAt: Date;
    }) => void;
    flushIntervalMs?: number;
    ringSize?: number;
    retainDays?: number;
  } = {},
): { ledger: JevLedger; filePath: string } {
  const filePath = options.filePath ?? path.join(tempDir(), "ledger.json");
  const ledger = new JevLedger({
    filePath,
    logger,
    now: options.now,
    writeFile: options.writeFile,
    onBudgetExhausted: options.onBudgetExhausted,
    flushIntervalMs: options.flushIntervalMs,
    ringSize: options.ringSize,
    retainDays: options.retainDays,
  });
  return { ledger, filePath };
}

describe("localDay / nextLocalMidnight", () => {
  test("formats a local calendar day", () => {
    expect(localDay(new Date(2026, 8, 28, 23, 59, 59))).toBe("2026-09-28");
    expect(localDay(new Date(2026, 0, 5, 0, 0, 0))).toBe("2026-01-05");
  });

  test("returns the next local midnight, handling month rollover", () => {
    expect(nextLocalMidnight(new Date(2026, 8, 28, 23, 59, 59)).toISOString()).toBe(
      new Date(2026, 8, 29, 0, 0, 0, 0).toISOString(),
    );
    expect(nextLocalMidnight(new Date(2026, 8, 30, 12, 0, 0)).toISOString()).toBe(
      new Date(2026, 9, 1, 0, 0, 0, 0).toISOString(),
    );
  });
});

describe("JevLedger totals", () => {
  test("spentTodayUsd and lane/feature totals accumulate across outcomes", () => {
    let now = new Date(2026, 8, 28, 10, 0, 0).getTime();
    const { ledger } = makeLedger({ now: () => now });

    ledger.record(
      makeEntry({
        feature: "spawnHint",
        lane: "control",
        outcome: "answered",
        cost: reported(0.01),
      }),
    );
    ledger.record(
      makeEntry({
        feature: "spawnHint",
        lane: "control",
        outcome: "shadow",
        cost: estimated(0.02),
      }),
    );
    ledger.record(
      makeEntry({
        feature: "remediationTriage",
        lane: "control",
        outcome: "unavailable",
        cost: { usd: null, source: "unknown" },
      }),
    );
    ledger.record(
      makeEntry({
        feature: "agentTools",
        lane: "agentTools",
        outcome: "failed",
        cost: reported(0.005),
      }),
    );

    expect(ledger.spentTodayUsd("control")).toBeCloseTo(0.03, 6);
    expect(ledger.spentTodayUsd("agentTools")).toBeCloseTo(0.005, 6);

    const controlTotals = ledger.laneTotalsToday("control");
    expect(controlTotals).toEqual({
      calls: 3,
      answered: 2,
      failed: 0,
      unavailable: 1,
      inputTokens: 150,
      usd: expect.closeTo(0.03, 6),
      usdSource: "mixed",
    });

    const spawnHintTotals = ledger.featureTotalsToday("spawnHint");
    expect(spawnHintTotals.calls).toBe(2);
    expect(spawnHintTotals.answered).toBe(2);
    expect(spawnHintTotals.usdSource).toBe("mixed");

    const remediationTotals = ledger.featureTotalsToday("remediationTriage");
    expect(remediationTotals).toEqual({
      calls: 1,
      answered: 0,
      failed: 0,
      unavailable: 1,
      inputTokens: 50,
      usd: 0,
      usdSource: "none",
    });
  });

  test("a fake cost source counts as reported for usdSource", () => {
    const { ledger } = makeLedger({ now: () => Date.now() });
    ledger.record(makeEntry({ cost: { usd: 0, source: "fake" } }));
    expect(ledger.laneTotalsToday("control").usdSource).toBe("reported");
  });

  test("usdSource is reported-only, estimated-only, or none when uniform", () => {
    const { ledger: reportedLedger } = makeLedger();
    reportedLedger.record(makeEntry({ cost: reported(0.01) }));
    expect(reportedLedger.laneTotalsToday("control").usdSource).toBe("reported");

    const { ledger: estimatedLedger } = makeLedger();
    estimatedLedger.record(makeEntry({ cost: estimated(0.01) }));
    expect(estimatedLedger.laneTotalsToday("control").usdSource).toBe("estimated");

    const { ledger: noneLedger } = makeLedger();
    noneLedger.record(makeEntry({ cost: { usd: null, source: "unknown" } }));
    expect(noneLedger.laneTotalsToday("control").usdSource).toBe("none");
  });
});

describe("JevLedger ring", () => {
  test("keeps only the newest entries once the ring size is exceeded", () => {
    const { ledger } = makeLedger({ ringSize: 3 });
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) ledger.record(makeEntry({ callId: id }));

    expect(ledger.entries().map((entry) => entry.callId)).toEqual(["c", "d", "e"]);
    expect(ledger.find("a")).toBeNull();
    expect(ledger.find("b")).toBeNull();
    expect(ledger.find("e")?.callId).toBe("e");
  });

  test("find looks up a recorded entry by callId", () => {
    const { ledger } = makeLedger();
    ledger.record(makeEntry({ callId: "the-call" }));
    expect(ledger.find("the-call")?.callId).toBe("the-call");
    expect(ledger.find("missing")).toBeNull();
  });
});

describe("JevLedger agent hour window", () => {
  test("spentByAgentLastHourUsd sums only charges within the last hour, by the injected clock", () => {
    let now = new Date(2026, 8, 28, 10, 0, 0).getTime();
    const { ledger } = makeLedger({ now: () => now });

    ledger.record(
      makeEntry({ lane: "agentTools", chargedAgentId: "agent-1", cost: reported(0.01) }),
    );
    now += 30 * 60_000; // +30 min
    ledger.record(
      makeEntry({ lane: "agentTools", chargedAgentId: "agent-1", cost: reported(0.02) }),
    );
    expect(ledger.spentByAgentLastHourUsd("agent-1")).toBeCloseTo(0.03, 6);

    now += 31 * 60_000; // +61 min from the first charge
    expect(ledger.spentByAgentLastHourUsd("agent-1")).toBeCloseTo(0.02, 6);

    expect(ledger.spentByAgentLastHourUsd("agent-2")).toBe(0);
  });

  test("a call with no chargedAgentId does not count toward any agent", () => {
    const { ledger } = makeLedger();
    ledger.record(makeEntry({ lane: "agentTools", chargedAgentId: null, cost: reported(0.01) }));
    expect(ledger.spentByAgentLastHourUsd("agent-1")).toBe(0);
  });
});

describe("JevLedger day rollover", () => {
  test("totals and exhaustion are scoped to the local calendar day", () => {
    let now = new Date(2026, 8, 28, 23, 0, 0).getTime();
    const { ledger } = makeLedger({ now: () => now });

    ledger.record(makeEntry({ cost: reported(0.5) }));
    ledger.markExhausted("control");
    expect(ledger.isExhausted("control")).toBe(true);
    expect(ledger.spentTodayUsd("control")).toBeCloseTo(0.5, 6);

    now = new Date(2026, 8, 29, 0, 30, 0).getTime(); // past local midnight
    expect(ledger.isExhausted("control")).toBe(false);
    expect(ledger.spentTodayUsd("control")).toBe(0);

    ledger.record(makeEntry({ cost: reported(0.1) }));
    expect(ledger.spentTodayUsd("control")).toBeCloseTo(0.1, 6);

    const last7 = ledger.last7Days();
    expect(last7).toHaveLength(7);
    expect(last7[6]).toEqual({ day: "2026-09-29", calls: 1, usd: expect.closeTo(0.1, 6) });
    expect(last7[5]).toEqual({ day: "2026-09-28", calls: 1, usd: expect.closeTo(0.5, 6) });
  });

  test("last7Days includes zero days when nothing was recorded", () => {
    const now = new Date(2026, 8, 28, 12, 0, 0).getTime();
    const { ledger } = makeLedger({ now: () => now });
    const days = ledger.last7Days();
    expect(days).toHaveLength(7);
    for (const day of days) expect(day).toEqual({ day: day.day, calls: 0, usd: 0 });
    expect(days[6].day).toBe("2026-09-28");
    expect(days[0].day).toBe("2026-09-22");
  });
});

describe("JevLedger markExhausted", () => {
  test("fires onBudgetExhausted once per day per lane, naming the top-spending feature", () => {
    const events: Array<{ lane: JevLane; topFeature: JevFeatureId | null }> = [];
    const now = new Date(2026, 8, 28, 12, 0, 0).getTime();
    const { ledger } = makeLedger({
      now: () => now,
      onBudgetExhausted: (event) => events.push({ lane: event.lane, topFeature: event.topFeature }),
    });

    ledger.record(makeEntry({ feature: "spawnHint", lane: "control", cost: reported(0.1) }));
    ledger.record(
      makeEntry({ feature: "remediationTriage", lane: "control", cost: reported(0.4) }),
    );
    ledger.record(makeEntry({ feature: "agentTools", lane: "agentTools", cost: reported(0.05) }));

    ledger.markExhausted("control");
    ledger.markExhausted("control");
    ledger.markExhausted("agentTools");

    expect(events).toEqual([
      { lane: "control", topFeature: "remediationTriage" },
      { lane: "agentTools", topFeature: "agentTools" },
    ]);
  });

  test("survives a reload the same day: markExhausted does not notify twice", async () => {
    const files = new Map<string, string>();
    const writeFile = async (filePath: string, data: string) => {
      files.set(filePath, data);
    };
    const filePath = path.join(tempDir(), "ledger.json");
    const now = new Date(2026, 8, 28, 12, 0, 0).getTime();

    const events: JevLane[] = [];
    const first = new JevLedger({
      filePath,
      logger,
      now: () => now,
      writeFile,
      onBudgetExhausted: (event) => events.push(event.lane),
    });
    first.record(makeEntry({ cost: reported(1) }));
    first.markExhausted("control");
    await first.flush();

    // A real reload reads back what was written.
    const { promises: fs } = await import("node:fs");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, files.get(filePath) ?? "");

    const second = new JevLedger({
      filePath,
      logger,
      now: () => now,
      onBudgetExhausted: (event) => events.push(event.lane),
    });
    await second.load();
    second.markExhausted("control");

    expect(events).toEqual(["control"]);
    expect(second.isExhausted("control")).toBe(true);
  });
});

describe("JevLedger corrupt/missing file", () => {
  test("load starts empty and never throws when the file is missing", async () => {
    const { ledger } = makeLedger();
    await expect(ledger.load()).resolves.toBeUndefined();
    expect(ledger.spentTodayUsd("control")).toBe(0);
  });

  test("load starts empty and logs once when the file is corrupt", async () => {
    const filePath = path.join(tempDir(), "ledger.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(filePath, "{ not json");
    const ledger = new JevLedger({ filePath, logger });
    await expect(ledger.load()).resolves.toBeUndefined();
    expect(ledger.spentTodayUsd("control")).toBe(0);
  });
});

describe("JevLedger flush cadence", () => {
  test("writes at most once per flush interval under many records", async () => {
    vi.useFakeTimers();
    let writes = 0;
    const writeFile = async () => {
      writes += 1;
    };
    const { ledger } = makeLedger({ writeFile, flushIntervalMs: 30_000 });

    for (let i = 0; i < 50; i += 1) ledger.record(makeEntry({ callId: `call-${i}` }));
    expect(writes).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toBe(1);

    for (let i = 0; i < 50; i += 1) ledger.record(makeEntry({ callId: `later-${i}` }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toBe(2);
  });

  test("stop flushes immediately and clears the timer", async () => {
    vi.useFakeTimers();
    let writes = 0;
    const writeFile = async () => {
      writes += 1;
    };
    const { ledger } = makeLedger({ writeFile, flushIntervalMs: 30_000 });
    ledger.record(makeEntry());
    await ledger.stop();
    expect(writes).toBe(1);

    // No further write is scheduled after stop.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toBe(1);
  });

  test("persists to disk with mode 0600 by default", async () => {
    vi.useFakeTimers();
    const filePath = path.join(tempDir(), "ledger.json");
    const ledger = new JevLedger({ filePath, logger, flushIntervalMs: 30_000 });
    ledger.record(makeEntry());
    await ledger.flush();
    const written = JSON.parse(readFileSync(filePath, "utf8"));
    expect(written.version).toBe(1);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });
});
