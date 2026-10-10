import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { AwayReplyDecisionFile, type AwayReplyDecisionLine } from "./decision-file.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-09-29T12:00:00Z");

function dir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "away-reply-file-"));
  roots.push(root);
  return path.join(root, "jev");
}

function skip(at: number, reason = "excluded-merge"): AwayReplyDecisionLine {
  return {
    type: "skip",
    at: new Date(at).toISOString(),
    agentId: "a",
    title: null,
    episode: "turn-ended",
    episodeKey: "a:turn:1",
    dryRun: true,
    reason,
  };
}

describe("AwayReplyDecisionFile", () => {
  it("appends one owner-only JSON line per decision", async () => {
    const file = new AwayReplyDecisionFile({ dir: dir(), logger: pino({ level: "silent" }) });
    file.append(skip(NOW));
    file.append(skip(NOW, "tyler-said-hold"));
    await file.flush();
    const lines = readFileSync(file.path, "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { v: 1, type: "skip", reason: "excluded-merge" },
      { v: 1, type: "skip", reason: "tyler-said-hold" },
    ]);
    if (process.platform !== "win32") {
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file.path)).mode & 0o777).toBe(0o700);
    }
  });

  it("drops lines older than 14 days at boot", async () => {
    const target = dir();
    mkdirSync(target, { recursive: true });
    const old = JSON.stringify({ v: 1, ...skip(NOW - 15 * 24 * 60 * 60_000) });
    const recent = JSON.stringify({ v: 1, ...skip(NOW - 60_000) });
    writeFileSync(path.join(target, "away-reply-decisions.jsonl"), `${old}\n${recent}\n`);
    const file = new AwayReplyDecisionFile({
      dir: target,
      logger: pino({ level: "silent" }),
      now: () => NOW,
    });
    await file.flush();
    expect(readFileSync(file.path, "utf8")).toBe(`${recent}\n`);
  });

  it("rotates once past 4 MB, keeping one old file", async () => {
    const file = new AwayReplyDecisionFile({ dir: dir(), logger: pino({ level: "silent" }) });
    const big = skip(NOW, "x".repeat(100_000));
    for (let index = 0; index < 45; index += 1) file.append(big);
    await file.flush();
    const rotated = path.join(path.dirname(file.path), "away-reply-decisions.1.jsonl");
    expect(statSync(rotated).size).toBeGreaterThan(3_000_000);
    expect(statSync(file.path).size).toBeLessThan(4_000_000);
  });
});
