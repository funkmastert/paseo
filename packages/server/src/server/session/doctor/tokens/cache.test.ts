import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateTranscriptLines,
  cacheCheck,
  cacheLifetimeInUse,
  measureCacheLifetime,
  summarizeTurns,
} from "./cache.js";
import { makeContext, makeFixture, writeConfig, type Fixture } from "../test-support.js";
import type { TokenAuditRow } from "./types.js";

const NOW = Date.UTC(2026, 8, 24, 20, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface LineSpec {
  id: string;
  ts: number;
  session?: string;
  cwd?: string;
  sidechain?: boolean;
  input?: number;
  read?: number;
  create?: number;
  out?: number;
  oneHour?: number;
  fiveMin?: number;
  /** Leave `usage.cache_creation` out, as older transcripts do. */
  noSplit?: boolean;
  model?: string;
}

function line(spec: LineSpec): string {
  const create = spec.create ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: spec.input ?? 0,
    cache_creation_input_tokens: create,
    cache_read_input_tokens: spec.read ?? 0,
    output_tokens: spec.out ?? 0,
  };
  if (!spec.noSplit) {
    usage["cache_creation"] = {
      ephemeral_1h_input_tokens: spec.oneHour ?? create - (spec.fiveMin ?? 0),
      ephemeral_5m_input_tokens: spec.fiveMin ?? 0,
    };
  }
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(spec.ts).toISOString(),
    sessionId: spec.session ?? "sess-a",
    cwd: spec.cwd ?? "/work/app",
    isSidechain: spec.sidechain ?? false,
    message: { id: spec.id, model: spec.model ?? "claude-opus-5-5", usage },
  });
}

function projectsDir(fixture: Fixture): string {
  return path.join(fixture.home, ".claude", "projects");
}

function writeTranscript(
  fixture: Fixture,
  relative: string,
  lines: string[],
  mtime: number = NOW,
): string {
  const file = path.join(projectsDir(fixture), relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

function rowByKey(rows: TokenAuditRow[], key: string): TokenAuditRow {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`no row ${key}; have ${rows.map((r) => r.key).join(", ")}`);
  return found;
}

/**
 * Three sessions with hand-computed totals:
 *   input 12, cache read 261,100, cache creation 62,500, output 680 => 324,292 tokens.
 */
function writeThreeSessions(fixture: Fixture): void {
  const t = NOW - HOUR;
  writeTranscript(
    fixture,
    "-work-a/sess-1.jsonl",
    [
      line({ id: "m1", ts: t, session: "sess-1", input: 2, read: 100, create: 900, out: 10 }),
      line({
        id: "m2",
        ts: t + 1000,
        session: "sess-1",
        input: 3,
        read: 1000,
        create: 100,
        out: 20,
      }),
    ],
    NOW - 3 * HOUR,
  );
  writeTranscript(
    fixture,
    "-work-b/sess-2.jsonl",
    [
      line({ id: "m1", ts: t, session: "sess-2", input: 1, create: 60_000, out: 100 }),
      line({
        id: "m2",
        ts: t + 1000,
        session: "sess-2",
        input: 1,
        read: 60_000,
        create: 500,
        fiveMin: 500,
        out: 50,
      }),
    ],
    NOW - 2 * HOUR,
  );
  writeTranscript(
    fixture,
    "-work-c/sess-3.jsonl",
    [
      line({
        id: "m1",
        ts: t,
        session: "sess-3",
        cwd: "/work/big",
        input: 5,
        read: 200_000,
        create: 1000,
        out: 500,
      }),
    ],
    NOW - HOUR,
  );
}

describe("aggregateTranscriptLines", () => {
  it("counts one message id once and keeps the line with the most output", () => {
    const sessions = aggregateTranscriptLines([
      line({ id: "m1", ts: NOW, input: 1, read: 10, out: 5 }),
      line({ id: "m1", ts: NOW, input: 1, read: 10, out: 50 }),
      line({ id: "m1", ts: NOW, input: 1, read: 10, out: 20 }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.turns).toHaveLength(1);
    expect(sessions[0]?.turns[0]?.output).toBe(50);
  });

  it("lets the later line win a tie on output tokens", () => {
    const [session] = aggregateTranscriptLines([
      line({ id: "m1", ts: NOW, input: 1, out: 7 }),
      line({ id: "m1", ts: NOW, input: 9, out: 7 }),
    ]);
    expect(session?.turns).toHaveLength(1);
    expect(session?.turns[0]?.input).toBe(9);
  });

  it("skips synthetic, all-zero, non-assistant and unparseable lines", () => {
    const sessions = aggregateTranscriptLines([
      line({ id: "s", ts: NOW, input: 5, model: "<synthetic>" }),
      line({ id: "z", ts: NOW }),
      JSON.stringify({ type: "user", message: { usage: { input_tokens: 5 } } }),
      '{not json but has "usage" and "type":"assistant"',
      line({ id: "ok", ts: NOW, input: 1 }),
    ]);
    expect(sessions[0]?.turns).toHaveLength(1);
  });

  it("excludes turns whose own timestamp is outside the window", () => {
    const sessions = aggregateTranscriptLines(
      [
        line({ id: "old", ts: NOW - 10 * DAY, input: 1 }),
        line({ id: "new", ts: NOW - DAY, input: 2 }),
      ],
      { since: NOW - 7 * DAY },
    );
    expect(sessions[0]?.turns.map((t) => t.input)).toEqual([2]);
  });

  it("marks lines from subagent files as sidechain", () => {
    const parsed = aggregateTranscriptLines([line({ id: "m1", ts: NOW, input: 1 })]);
    expect(parsed[0]?.turns[0]?.isSidechain).toBe(false);
    const sidechain = aggregateTranscriptLines([
      line({ id: "m1", ts: NOW, input: 1, sidechain: true }),
    ]);
    expect(sidechain[0]?.turns[0]?.isSidechain).toBe(true);
  });
});

describe("summarizeTurns", () => {
  const turns = aggregateTranscriptLines([
    line({ id: "a", ts: NOW - 3000, input: 2, read: 100, create: 900, out: 10 }),
    line({ id: "b", ts: NOW - 2000, input: 3, read: 1000, create: 100, out: 20 }),
    line({ id: "c", ts: NOW - 1000, sidechain: true, input: 1, read: 999_999, out: 1 }),
    line({ id: "d", ts: NOW - 500, input: 1, create: 60_000, fiveMin: 10_000, out: 100 }),
  ])[0]?.turns as NonNullable<ReturnType<typeof aggregateTranscriptLines>[number]>["turns"];

  it("totals the four token kinds and their percent shares", () => {
    const s = summarizeTurns(turns);
    expect(s.input).toBe(7);
    expect(s.cacheRead).toBe(1100 + 999_999);
    expect(s.cacheCreation).toBe(61_000);
    expect(s.output).toBe(131);
    const shareSum = s.shares.cacheRead + s.shares.cacheCreation + s.shares.input + s.shares.output;
    expect(Math.abs(shareSum - 100)).toBeLessThan(0.3);
  });

  it("reads first and last context from the main thread only", () => {
    const s = summarizeTurns(turns);
    expect(s.firstContext).toBe(2 + 100 + 900);
    // The sidechain turn is the newest but does not count; the last main turn is "d".
    expect(s.lastContext).toBe(1 + 0 + 60_000);
  });

  it("falls back to sidechain turns when a session has no main thread", () => {
    const s = summarizeTurns(
      aggregateTranscriptLines([line({ id: "x", ts: NOW, sidechain: true, input: 4, read: 6 })])[0]
        ?.turns ?? [],
    );
    expect(s.firstContext).toBe(10);
    expect(s.lastContext).toBe(10);
  });

  it("counts rebuild turns above 50K written and the tokens they wrote", () => {
    const s = summarizeTurns(turns);
    expect(s.rebuildTurns).toBe(1);
    expect(s.rebuildTokens).toBe(60_000);
  });

  it("splits cache creation between 1h and 5m, and reports the rest as unsplit", () => {
    const s = summarizeTurns(turns);
    expect(s.fiveMin).toBe(10_000);
    expect(s.oneHour).toBe(900 + 100 + 50_000);
    expect(s.unsplit).toBe(0);
    const old = summarizeTurns(
      aggregateTranscriptLines([line({ id: "y", ts: NOW, create: 300, noSplit: true })])[0]
        ?.turns ?? [],
    );
    expect(old.unsplit).toBe(300);
    expect(old.oneHour + old.fiveMin).toBe(0);
  });
});

describe("cacheLifetimeInUse", () => {
  it("names the lifetime that was written", () => {
    expect(cacheLifetimeInUse(100, 0)).toBe("1h");
    expect(cacheLifetimeInUse(0, 100)).toBe("5m");
    expect(cacheLifetimeInUse(100, 1)).toBe("mixed");
    expect(cacheLifetimeInUse(0, 0)).toBe("UNKNOWN");
  });
});

describe("cacheCheck", () => {
  it("has the id and item the audit expects", () => {
    expect(cacheCheck.id).toBe("tokens.cache");
    expect(cacheCheck.item).toBe("cache");
    expect(cacheCheck.timeoutMs).toBe(240_000);
  });

  it("matches hand-computed numbers on a three-session fixture", async () => {
    const fixture = makeFixture();
    writeThreeSessions(fixture);
    const ctx = makeContext(fixture, {}, { now: () => NOW });
    const rows = await cacheCheck.measure(ctx, NOW + 60_000);

    const fleet = rowByKey(rows, "cache:fleet-7d");
    expect(fleet.metrics).toMatchObject({
      "cache.readShare": 80.5,
      "cache.creationShare": 19.3,
      "cache.inputShare": 0,
      "cache.outputShare": 0.2,
      "cache.lastTurnContextMedian": 60_501,
      "cache.sessionsOver200k": 1,
      "cache.rebuildTurns": 1,
    });
    expect(fleet.evidence).toContain("3 sessions, 5 turns");
    expect(fleet.evidence).toContain("1 of 3 sessions (33.3%)");
    expect(fleet.evidence).toContain("wrote 60,000 tokens, 96% of all cache writes");
    expect(fleet.evidence).toContain("1h 62,000, 5m 500");
    expect(fleet.evidence).toContain("read 3 of 3 files");
    expect(fleet.severity).toBe("AMBER");

    const over = rowByKey(rows, "cache:fleet-7d:over-200k");
    expect(over.severity).toBe("AMBER");
    expect(over.evidence).toContain("sess-3 (big): 201,005 tokens");
  });

  it("reports the newest session by file mtime with its context and lifetime split", async () => {
    const fixture = makeFixture();
    writeThreeSessions(fixture);
    const ctx = makeContext(fixture, {}, { now: () => NOW });
    const rows = await cacheCheck.measure(ctx, NOW + 60_000);
    const newest = rowByKey(rows, "cache:newest-session");
    // sess-3's file has the newest mtime, and its last-turn context is above 200K.
    expect(newest.finding).toContain("sess-3");
    expect(newest.finding).toContain("/work/big");
    expect(newest.severity).toBe("AMBER");
    expect(newest.evidence).toContain("first-turn context 201,005 tokens");
    expect(newest.evidence).toContain("last-turn context 201,005 tokens");
    expect(newest.evidence).toContain("1h 1,000, 5m 0");
    expect(newest.metrics).toMatchObject({
      "cache.readShare": 99.3,
      "cache.creationShare": 0.5,
      "cache.lastTurnContext": 201_005,
    });
  });

  it("is GREEN when nothing is above 200K and rebuilds are a minor share of the writes", async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, "-w/s.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s", input: 1, read: 1000, create: 2000, out: 5 }),
      line({
        id: "m2",
        ts: NOW - HOUR + 1,
        session: "s",
        input: 1,
        read: 3000,
        create: 200,
        out: 5,
      }),
    ]);
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(rows.map((r) => r.key)).toEqual(["cache:newest-session", "cache:fleet-7d"]);
    expect(rows.every((r) => r.severity === "GREEN")).toBe(true);
  });

  it("includes subagent transcripts in the spend without counting their messages twice", async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, "-w/s1.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s1", input: 1, read: 10, out: 5 }),
      line({ id: "m1", ts: NOW - HOUR, session: "s1", input: 1, read: 10, out: 5 }),
    ]);
    writeTranscript(fixture, "-w/s1/subagents/agent-1.jsonl", [
      line({
        id: "sub1",
        ts: NOW - HOUR,
        session: "s1",
        sidechain: true,
        input: 1,
        read: 100,
        out: 5,
      }),
    ]);
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    const fleet = rowByKey(rows, "cache:fleet-7d");
    expect(fleet.evidence).toContain("1 sessions, 2 turns");
    expect(fleet.evidence).toContain("read 2 of 2 files");
    expect(rowByKey(rows, "cache:newest-session").evidence).toContain("2 turns");
  });

  it("excludes turns outside the window and files not touched in the window", async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, "-w/mixed.jsonl", [
      line({ id: "old", ts: NOW - 10 * DAY, session: "mixed", input: 999, read: 999_999 }),
      line({ id: "new", ts: NOW - DAY, session: "mixed", input: 1, read: 9 }),
    ]);
    writeTranscript(
      fixture,
      "-w/stale.jsonl",
      [line({ id: "s1", ts: NOW - DAY, session: "stale", input: 1, read: 1 })],
      NOW - 20 * DAY,
    );
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    const fleet = rowByKey(rows, "cache:fleet-7d");
    expect(fleet.evidence).toContain("1 sessions, 1 turns");
    expect(fleet.evidence).toContain("read 1 of 1 files");
  });

  it("reads windowDays from agents.tokenAudit.windowDays", async () => {
    const fixture = makeFixture();
    writeConfig(fixture, { agents: { tokenAudit: { windowDays: 30 } } });
    writeTranscript(
      fixture,
      "-w/s.jsonl",
      [line({ id: "m1", ts: NOW - 20 * DAY, session: "s", input: 1, read: 9 })],
      NOW - 20 * DAY,
    );
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(rowByKey(rows, "cache:fleet-7d").finding).toContain("last 30d");
  });

  it("does not count a symlinked duplicate directory twice", async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, "-w/s.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s", input: 1, read: 9, out: 1 }),
    ]);
    symlinkSync(path.join(projectsDir(fixture), "-w"), path.join(projectsDir(fixture), "-w-copy"));
    // An account's projects/ resolves to the shared dir too.
    const account = path.join(fixture.home, ".claude-work");
    mkdirSync(account, { recursive: true });
    symlinkSync(projectsDir(fixture), path.join(account, "projects"));
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    const fleet = rowByKey(rows, "cache:fleet-7d");
    expect(fleet.evidence).toContain("1 sessions, 1 turns");
    expect(fleet.evidence).toContain("read 1 of 1 files");
  });

  it("resolves a symlinked projects dir to its real path", async () => {
    const fixture = makeFixture();
    const real = path.join(fixture.home, "shared-projects");
    writeTranscript(fixture, "../../shared-projects/-w/s.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s", input: 1, read: 9, out: 1 }),
    ]);
    rmSync(projectsDir(fixture), { recursive: true, force: true });
    symlinkSync(real, projectsDir(fixture));
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(rowByKey(rows, "cache:fleet-7d").evidence).toContain("1 sessions, 1 turns");
  });

  it("stops at the deadline and reports partial coverage", async () => {
    const fixture = makeFixture();
    for (let i = 0; i < 10; i += 1) {
      writeTranscript(
        fixture,
        `-w/s${i}.jsonl`,
        [line({ id: `m${i}`, ts: NOW - HOUR, session: `s${i}`, input: 1, read: 9, out: 1 })],
        NOW - i * 1000,
      );
    }
    let calls = 0;
    // The clock is fine for the listing and the first few files, then passes the deadline.
    const now = () => {
      calls += 1;
      return calls > 12 ? NOW + 10 * HOUR : NOW;
    };
    const rows = await cacheCheck.measure(makeContext(fixture, {}, { now }), NOW + HOUR);
    const evidence = rowByKey(rows, "cache:fleet-7d").evidence;
    const match = /read (\d+) of 10 files \(stopped at the deadline\)/.exec(evidence);
    expect(match).not.toBeNull();
    const read = Number(match?.[1]);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(10);
  });

  it("returns UNKNOWN, not zeros, when the projects dir is unreadable", async () => {
    const fixture = makeFixture();
    rmSync(projectsDir(fixture), { recursive: true, force: true });
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item: "cache",
      key: "cache:newest-session",
      severity: "UNKNOWN",
    });
    expect(rows[0]?.evidence).toMatch(/^UNKNOWN: cannot read /);
    expect(rows[0]?.metrics).toBeUndefined();
  });

  it("returns UNKNOWN when there are no transcripts in the window", async () => {
    const fixture = makeFixture();
    const rows = await cacheCheck.measure(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.severity).toBe("UNKNOWN");
    expect(rows[0]?.key).toBe("cache:newest-session");
  });
});

describe("measureCacheLifetime", () => {
  it("reports a 1h lifetime when only 1h writes exist", async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, "-w/s.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s", create: 5000, out: 1 }),
    ]);
    const result = await measureCacheLifetime(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(result).toEqual({ lifetimeMs: 3_600_000, oneHourTokens: 5000, fiveMinTokens: 0 });
  });

  it("reports a 5m lifetime when only 5m writes exist", async () => {
    const fixture = makeFixture();
    writeTranscript(fixture, "-w/s.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s", create: 5000, fiveMin: 5000, out: 1 }),
    ]);
    const result = await measureCacheLifetime(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(result).toEqual({ lifetimeMs: 300_000, oneHourTokens: 0, fiveMinTokens: 5000 });
  });

  it("gives the lifetime most tokens used when both were written, and none when nothing was", async () => {
    const fixture = makeFixture();
    const empty = await measureCacheLifetime(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(empty.lifetimeMs).toBeNull();
    writeTranscript(fixture, "-w/s.jsonl", [
      line({ id: "m1", ts: NOW - HOUR, session: "s", create: 5000, fiveMin: 100, out: 1 }),
    ]);
    const mixed = await measureCacheLifetime(
      makeContext(fixture, {}, { now: () => NOW }),
      NOW + 60_000,
    );
    expect(mixed).toEqual({ lifetimeMs: 3_600_000, oneHourTokens: 4900, fiveMinTokens: 100 });
  });
});
