import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenUsageStore, type UsageBooking } from "./token-usage-store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T12:30:00.000Z");

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "token-usage-store-"));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function booking(overrides: Partial<UsageBooking> = {}): UsageBooking {
  return {
    atMs: NOW,
    provider: "claude",
    model: "claude-opus-5-5",
    role: "leader",
    input: 10,
    cacheWrite: 100,
    cacheRead: 1_000,
    output: 20,
    responses: 1,
    ...overrides,
  };
}

function newStore(limits?: ConstructorParameters<typeof TokenUsageStore>[0]["limits"]) {
  return new TokenUsageStore({ rootDir, logger: { warn: vi.fn() }, limits });
}

describe("TokenUsageStore", () => {
  it("sums one row per provider, model and role, weighted, heaviest first", async () => {
    const store = newStore();
    await store.load();
    store.add(booking());
    store.add(booking({ atMs: NOW - HOUR }));
    store.add(booking({ role: "worker", output: 1_000 }));
    store.add(booking({ provider: "codex", model: "gpt-fake-5", role: "outside" }));
    store.add(booking({ responses: 0, output: 5, input: 0, cacheWrite: 0, cacheRead: 0 }));

    expect(store.query(0)).toEqual([
      {
        provider: "claude",
        model: "claude-opus-5-5",
        role: "worker",
        input: 10,
        cacheWrite: 100,
        cacheRead: 1_000,
        output: 1_000,
        weighted: 10 + 125 + 100 + 5_000,
        responses: 1,
      },
      {
        provider: "claude",
        model: "claude-opus-5-5",
        role: "leader",
        input: 20,
        cacheWrite: 200,
        cacheRead: 2_000,
        output: 45,
        weighted: 20 + 250 + 200 + 225,
        responses: 2,
      },
      {
        provider: "codex",
        model: "gpt-fake-5",
        role: "outside",
        input: 10,
        cacheWrite: 100,
        cacheRead: 1_000,
        output: 20,
        weighted: 10 + 125 + 100 + 100,
        responses: 1,
      },
    ]);
  });

  it("counts only the hours from the range start", async () => {
    const store = newStore();
    await store.load();
    store.add(booking({ atMs: NOW }));
    store.add(booking({ atMs: NOW - 2 * DAY }));
    store.add(booking({ atMs: NOW - 10 * DAY }));
    const responsesFrom = (startMs: number) =>
      store.query(startMs).reduce((sum, row) => sum + row.responses, 0);

    expect(responsesFrom(NOW - DAY)).toBe(1);
    expect(responsesFrom(NOW - 7 * DAY)).toBe(2);
    expect(responsesFrom(NOW - 30 * DAY)).toBe(3);
    // A bucket is the hour a response landed in: the range start's own hour is included whole.
    expect(responsesFrom(Math.floor(NOW / HOUR) * HOUR)).toBe(1);
  });

  it("round-trips buckets, scan state and sessions through disk", async () => {
    const store = newStore();
    await store.load();
    store.markRecordingSince(NOW - HOUR);
    store.markBackfillDone(NOW);
    store.add(booking());
    store.setFile("/fake/a.jsonl", {
      provider: "claude",
      offset: 10,
      size: 10,
      mtimeMs: NOW,
      firstId: "m1",
      newestMs: NOW,
      recent: [["m1", 1, 2, 3, 4]],
    });
    store.recordSession({
      sessionId: "s1",
      agentId: "agent-1",
      parentAgentId: null,
      lastSeenMs: NOW,
    });
    await store.flush(NOW);

    const reloaded = newStore();
    await reloaded.load();

    expect(reloaded.query(0)).toEqual(store.query(0));
    expect(reloaded.getFile("/fake/a.jsonl")).toEqual(store.getFile("/fake/a.jsonl"));
    expect(reloaded.listSessions()).toEqual(store.listSessions());
    expect(reloaded.getRecordingSinceMs()).toBe(NOW - HOUR);
    expect(reloaded.getBackfillDoneAtMs()).toBe(NOW);
  });

  it("replaces a file that will not parse instead of throwing", async () => {
    await fs.writeFile(path.join(rootDir, "state.json"), "{ not json");
    await fs.writeFile(path.join(rootDir, "sessions.json"), JSON.stringify({ v: 2 }));
    const warn = vi.fn();
    const store = new TokenUsageStore({ rootDir, logger: { warn } });

    await store.load();
    store.add(booking());
    await store.flush(NOW);

    expect(warn).toHaveBeenCalledTimes(2);
    const written = JSON.parse(await fs.readFile(path.join(rootDir, "state.json"), "utf8"));
    expect(written.v).toBe(1);
    expect(written.buckets.map((bucket: unknown[]) => bucket.slice(0, 2))).toEqual([
      [Math.floor(NOW / HOUR) * HOUR, "claude"],
    ]);
  });

  it("drops buckets, file entries and sessions past retention, and stale recent ids", async () => {
    const store = newStore();
    await store.load();
    store.add(booking({ atMs: NOW - 32 * DAY }));
    store.add(booking({ atMs: NOW - 30 * DAY }));
    store.setFile("/fake/old.jsonl", {
      provider: "claude",
      offset: 1,
      size: 1,
      mtimeMs: NOW - 32 * DAY,
    });
    store.setFile("/fake/idle.jsonl", {
      provider: "claude",
      offset: 1,
      size: 1,
      mtimeMs: NOW - 2 * DAY,
      recent: [["m1", 1, 1, 1, 1]],
    });
    store.recordSession({
      sessionId: "s-old",
      agentId: "a",
      parentAgentId: null,
      lastSeenMs: NOW - 40 * DAY,
    });

    store.prune(NOW);

    expect(store.query(0).reduce((sum, row) => sum + row.responses, 0)).toBe(1);
    expect(store.getFile("/fake/old.jsonl")).toBeUndefined();
    expect(store.getFile("/fake/idle.jsonl")?.recent).toBeUndefined();
    expect(store.listSessions()).toEqual([]);
  });

  it("caps buckets, distinct models, files and sessions", async () => {
    const store = newStore({ maxBuckets: 2, maxModelsPerProvider: 2, maxFiles: 1, maxSessions: 1 });
    await store.load();
    store.add(booking({ atMs: NOW - 2 * HOUR, model: "m-a" }));
    store.add(booking({ atMs: NOW - HOUR, model: "m-b" }));
    store.add(booking({ atMs: NOW, model: "m-c" }));
    store.setFile("/fake/1.jsonl", { provider: "claude", offset: 0, size: 0, mtimeMs: NOW - HOUR });
    // At the cap, a second new file is refused rather than evicting the first (#7): an evicted
    // file would look unseen to the scanner and get re-read from byte 0, double-counting it.
    store.setFile("/fake/2.jsonl", { provider: "claude", offset: 0, size: 0, mtimeMs: NOW });
    store.recordSession({
      sessionId: "s1",
      agentId: "a",
      parentAgentId: null,
      lastSeenMs: NOW - HOUR,
    });
    store.recordSession({ sessionId: "s2", agentId: "b", parentAgentId: "a", lastSeenMs: NOW });

    // The oldest hour gave way, and the third distinct model was booked as unknown.
    expect(
      store
        .query(0)
        .map((row) => row.model)
        .sort(),
    ).toEqual(["m-b", "unknown"]);
    expect(store.listFiles().map(([filePath]) => filePath)).toEqual(["/fake/1.jsonl"]);
    expect(store.listSessions().map((entry) => entry.sessionId)).toEqual(["s2"]);
  });

  it("refuses a new file at the files cap, leaving the existing entry untouched, and warns once", async () => {
    const warn = vi.fn();
    const store = new TokenUsageStore({ rootDir, logger: { warn }, limits: { maxFiles: 1 } });
    await store.load();
    const original = { provider: "claude" as const, offset: 500, size: 500, mtimeMs: NOW - HOUR };
    store.setFile("/fake/1.jsonl", original);

    store.setFile("/fake/2.jsonl", { provider: "claude", offset: 0, size: 0, mtimeMs: NOW });
    store.setFile("/fake/3.jsonl", { provider: "claude", offset: 0, size: 0, mtimeMs: NOW });

    expect(store.getFile("/fake/1.jsonl")).toEqual(original);
    expect(store.getFile("/fake/2.jsonl")).toBeUndefined();
    expect(store.getFile("/fake/3.jsonl")).toBeUndefined();
    expect(store.listFiles().map(([filePath]) => filePath)).toEqual(["/fake/1.jsonl"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("maybeFlush skips inside the debounce interval, and writes once it has passed", async () => {
    const store = new TokenUsageStore({
      rootDir,
      logger: { warn: vi.fn() },
      flushIntervalMs: HOUR,
    });
    await store.load();
    await store.flush(NOW); // establishes lastFlushMs with nothing dirty yet
    store.add(booking({ atMs: NOW }));

    await store.maybeFlush(NOW + HOUR - 1);
    await expect(fs.readFile(path.join(rootDir, "state.json"), "utf8")).rejects.toThrow(/ENOENT/);

    await store.maybeFlush(NOW + HOUR);
    const state = JSON.parse(await fs.readFile(path.join(rootDir, "state.json"), "utf8"));
    expect(state.buckets).toHaveLength(1);
  });

  it("writes nothing on close when it never loaded", async () => {
    const store = newStore();
    await store.close();

    await expect(fs.readdir(rootDir)).resolves.toEqual([]);
  });
});
