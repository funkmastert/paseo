import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SaturationLedgerRecord } from "../../agent/saturation-ledger.js";
import { saturationCheck } from "./saturation.js";
import { type Fixture, makeContext, makeFixture } from "./test-support.js";

const OPENED = Date.parse("2026-09-24T20:39:00.000Z");

function record(event: SaturationLedgerRecord["event"], atMs: number, load1: number) {
  const value: SaturationLedgerRecord = {
    version: 1,
    at: new Date(atMs).toISOString(),
    event,
    openedAt: new Date(OPENED).toISOString(),
    peakLoad1: load1,
    load: { kind: "loadavg", cores: 16, load1, load5: 30, load15: 20 },
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
          agentId: "a1",
          title: "Fix orders API",
          cwd: "/Users/t/backend-net",
          cpuPercent: 439,
          rssBytes: 2 * 1024 ** 3,
          topCommands: [
            {
              pid: 9,
              name: "dotnet",
              command: "dotnet VBCSCompiler.dll",
              cpuPercent: 439,
              rssBytes: 1,
            },
          ],
        },
      ],
      otherProcesses: [],
    },
  };
  return JSON.stringify(value);
}

describe("resource.saturation", () => {
  let fx: Fixture;

  afterEach(() => {
    rmSync(fx.home, { recursive: true, force: true });
  });

  function writeLedger(lines: string[]): void {
    const dir = path.join(fx.paseoHome, "resource-monitor");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "incidents.jsonl"), `${lines.join("\n")}\n`);
  }

  test("is ok with no ledger at all", async () => {
    fx = makeFixture();

    const [result] = await saturationCheck.run(makeContext(fx), 0);

    expect(result).toMatchObject({ status: "ok", title: "No CPU saturation in the last 7 days" });
  });

  test("reports the latest incident: when, how long, the peak and the agent trees", async () => {
    fx = makeFixture();
    writeLedger([
      record("open", OPENED, 34),
      record("ongoing", OPENED + 300_000, 38),
      record("clear", OPENED + 1_620_000, 9),
    ]);

    const [result] = await saturationCheck.run(
      makeContext(fx, {}, { now: () => OPENED + 2 * 3_600_000 }),
      0,
    );

    expect(result).toMatchObject({
      status: "warn",
      title: "CPU saturated 2 h ago, peak load 38.0 on 16 cores",
    });
    expect(result?.detail).toContain("lasted 27 min");
    expect(result?.detail).toContain("Agent Fix orders API (a1, /Users/t/backend-net): 439% CPU");
    expect(result?.detail).toContain("dotnet 439%");
    expect(result?.fix).toContain("incidents.jsonl");
  });

  test("an incident with no clear record says the machine went down during it", async () => {
    fx = makeFixture();
    writeLedger([record("open", OPENED, 38)]);

    const [result] = await saturationCheck.run(
      makeContext(fx, {}, { now: () => OPENED + 3_600_000 }),
      0,
    );

    expect(result?.detail).toContain("never cleared");
  });

  test("ignores an incident more than 7 days old", async () => {
    fx = makeFixture();
    writeLedger([record("open", OPENED, 38)]);

    const [result] = await saturationCheck.run(
      makeContext(fx, {}, { now: () => OPENED + 8 * 86_400_000 }),
      0,
    );

    expect(result?.status).toBe("ok");
  });
});
