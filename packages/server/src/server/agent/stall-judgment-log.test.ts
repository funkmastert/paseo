import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { STALL_JUDGMENT_LOG_FILE, StallJudgmentLog } from "./stall-judgment-log.js";

const logger = pino({ level: "silent" });
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const DAY = 24 * 60 * 60_000;

function scratchDir(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "stall-judgment-log-")), "jev");
}

describe("the stall judgment log", () => {
  test("appends one versioned JSON line per record, owner-only", async () => {
    const dir = scratchDir();
    const log = new StallJudgmentLog({ dir, logger, now: () => NOW });
    log.append({
      type: "background-wait",
      at: new Date(NOW).toISOString(),
      agentId: "a1",
      action: "resumed",
      quietMinutes: 12,
      quote: "Waiting on CI.",
      detail: null,
    });
    log.append({
      type: "loop-closed",
      at: new Date(NOW).toISOString(),
      agentId: "a1",
      episodeKey: "looping-agent:a1",
      why: "the repeat stopped",
      applied: true,
      minutesOpen: 10,
    });
    await log.flush();
    const file = path.join(dir, STALL_JUDGMENT_LOG_FILE);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ v: 1, type: "background-wait", agentId: "a1" }),
      expect.objectContaining({ v: 1, type: "loop-closed", minutesOpen: 10 }),
    ]);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  test("drops lines older than 30 days at boot", async () => {
    const dir = scratchDir();
    mkdirSync(dir, { recursive: true });
    const old = { v: 1, type: "loop-closed", at: new Date(NOW - 31 * DAY).toISOString() };
    const fresh = { v: 1, type: "loop-closed", at: new Date(NOW - DAY).toISOString() };
    writeFileSync(
      path.join(dir, STALL_JUDGMENT_LOG_FILE),
      `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`,
    );
    const log = new StallJudgmentLog({ dir, logger, now: () => NOW });
    await log.flush();
    const kept = readFileSync(path.join(dir, STALL_JUDGMENT_LOG_FILE), "utf8").trim().split("\n");
    expect(kept.map((line) => JSON.parse(line).at)).toEqual([fresh.at]);
  });
});
