import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createSaturationLedger,
  readLatestSaturationIncident,
  type SaturationLedgerEvent,
  type SaturationLedgerRecord,
  saturationLedgerPath,
} from "./saturation-ledger.js";

const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-09-24T20:39:00.000Z");

function record(input: {
  event: SaturationLedgerEvent;
  atMs: number;
  openedAtMs?: number;
  load1: number;
  peakLoad1?: number;
  agentId?: string;
}): SaturationLedgerRecord {
  return {
    version: 1,
    at: new Date(input.atMs).toISOString(),
    event: input.event,
    openedAt: new Date(input.openedAtMs ?? T0).toISOString(),
    peakLoad1: input.peakLoad1 ?? input.load1,
    load: { kind: "loadavg", cores: 16, load1: input.load1, load5: 30, load15: 20 },
    memory: {
      freeBytes: 1,
      totalBytes: 2,
      availableBytes: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
    },
    evidence: {
      sample: { status: "fresh", ageMs: 0 },
      cause: {
        kind: "cpu",
        explainedByAgents: 7,
        explainedByOthers: 1,
        unexplained: 0,
        ioProcesses: [],
      },
      agentTrees: [
        {
          agentId: input.agentId ?? "backend",
          title: "Fix orders API",
          cwd: "/w",
          cpuPercent: 700,
          rssBytes: 1,
          topCommands: [],
        },
      ],
      otherProcesses: [],
    },
  };
}

describe("saturation ledger", () => {
  let home: string;
  const logger = { warn: vi.fn() };

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "saturation-ledger-"));
    logger.warn.mockReset();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("appends one JSON line per record under PASEO_HOME", async () => {
    const ledger = createSaturationLedger({ paseoHome: home, logger });

    await ledger.append(record({ event: "open", atMs: T0, load1: 34 }));
    await ledger.append(record({ event: "ongoing", atMs: T0 + 300_000, load1: 38 }));

    const lines = (await readFile(saturationLedgerPath(home), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["open", "ongoing"]);
  });

  test("reports the latest incident's span, peak and the trees at its peak", async () => {
    const ledger = createSaturationLedger({ paseoHome: home, logger });
    const earlier = T0 - DAY_MS;
    await ledger.append(record({ event: "open", atMs: earlier, openedAtMs: earlier, load1: 50 }));
    await ledger.append(record({ event: "open", atMs: T0, load1: 34 }));
    await ledger.append(
      record({
        event: "ongoing",
        atMs: T0 + 300_000,
        load1: 38,
        peakLoad1: 38,
        agentId: "android",
      }),
    );
    await ledger.append(record({ event: "clear", atMs: T0 + 600_000, load1: 8, peakLoad1: 38 }));

    const incident = await readLatestSaturationIncident({
      paseoHome: home,
      nowMs: T0 + DAY_MS,
      windowMs: 7 * DAY_MS,
    });

    expect(incident).toMatchObject({
      openedAt: new Date(T0).toISOString(),
      clearedAt: new Date(T0 + 600_000).toISOString(),
      durationMs: 600_000,
      peakLoad1: 38,
    });
    expect(incident?.peak.evidence.agentTrees[0]?.agentId).toBe("android");
  });

  test("an incident the machine went down in has no clear record, and reads as never cleared", async () => {
    const ledger = createSaturationLedger({ paseoHome: home, logger });
    await ledger.append(record({ event: "open", atMs: T0, load1: 38 }));
    // A hard power-off mid-write leaves a torn last line.
    await appendFile(saturationLedgerPath(home), '{"version":1,"at":"2026-09-');

    const incident = await readLatestSaturationIncident({
      paseoHome: home,
      nowMs: T0,
      windowMs: DAY_MS,
    });

    expect(incident).toMatchObject({ clearedAt: null, durationMs: 0, peakLoad1: 38 });
  });

  test("the first record after a torn line starts on its own line and is read back", async () => {
    const ledger = createSaturationLedger({ paseoHome: home, logger });
    await ledger.append(record({ event: "open", atMs: T0, load1: 38 }));
    await appendFile(saturationLedgerPath(home), '{"version":1,"at":"2026-09-');

    // The daemon comes back up after the reboot and the incident is still open.
    await ledger.append(record({ event: "ongoing", atMs: T0 + 300_000, load1: 44 }));

    const incident = await readLatestSaturationIncident({
      paseoHome: home,
      nowMs: T0 + 300_000,
      windowMs: DAY_MS,
    });
    expect(incident).toMatchObject({ durationMs: 300_000, peakLoad1: 44 });
  });

  test("ignores an incident older than the window", async () => {
    const ledger = createSaturationLedger({ paseoHome: home, logger });
    await ledger.append(record({ event: "open", atMs: T0, load1: 38 }));

    expect(
      await readLatestSaturationIncident({
        paseoHome: home,
        nowMs: T0 + 8 * DAY_MS,
        windowMs: 7 * DAY_MS,
      }),
    ).toBeUndefined();
  });

  test("rotates past maxBytes, keeps one previous file, and still reads across both", async () => {
    const ledger = createSaturationLedger({ paseoHome: home, logger, maxBytes: 2_000 });
    for (let index = 0; index < 12; index += 1) {
      await ledger.append(
        record({ event: "ongoing", atMs: T0 + index * 300_000, load1: 30 + index }),
      );
    }

    const files = (await readdir(path.dirname(saturationLedgerPath(home)))).sort();
    expect(files).toEqual(["incidents.1.jsonl", "incidents.jsonl"]);
    const current = await readFile(saturationLedgerPath(home), "utf8");
    expect(Buffer.byteLength(current)).toBeLessThanOrEqual(2_000);
    const incident = await readLatestSaturationIncident({
      paseoHome: home,
      nowMs: T0 + 12 * 300_000,
      windowMs: DAY_MS,
    });
    expect(incident?.peakLoad1).toBe(41);
  });

  test("a write that fails is logged once and does not throw", async () => {
    // PASEO_HOME/resource-monitor is a file, so the directory cannot be created.
    await writeFile(path.join(home, "resource-monitor"), "not a directory");
    const ledger = createSaturationLedger({ paseoHome: home, logger });

    await ledger.append(record({ event: "open", atMs: T0, load1: 38 }));
    await ledger.append(record({ event: "ongoing", atMs: T0, load1: 38 }));

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
