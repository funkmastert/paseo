import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UsageHistoryStore,
  type AccountWindowSampleInput,
  type UsageHistoryLimits,
} from "./usage-history-store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);
const silentLogger = { warn: () => undefined };

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-history-"));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function createStore(limits?: Partial<UsageHistoryLimits>): UsageHistoryStore {
  return new UsageHistoryStore({ rootDir, logger: silentLogger, limits });
}

function window(atMs: number, usedPct: number, windowId = "five_hour"): AccountWindowSampleInput {
  return {
    providerId: "claude-personal",
    windowId,
    label: windowId,
    atMs,
    usedPct,
    resetsAtMs: T0 + 5 * HOUR,
  };
}

describe("account windows", () => {
  it("records each distinct provider fetch once, even when the sweep reads it many times", async () => {
    const store = createStore();
    await store.record({ nowMs: T0, accounts: [window(T0, 10)], agents: [] });
    // The 60s sweep re-reads the same cached snapshot: same fetchedAt, so no new reading.
    await store.record({ nowMs: T0 + MINUTE, accounts: [window(T0, 10)], agents: [] });
    await store.record({ nowMs: T0 + 2 * MINUTE, accounts: [window(T0, 10)], agents: [] });
    await store.record({
      nowMs: T0 + 5 * MINUTE,
      accounts: [window(T0 + 5 * MINUTE, 10)],
      agents: [],
    });

    const [series] = await store.readAccountSeries();
    expect(series?.samples.map((sample) => sample.atMs)).toEqual([T0, T0 + 5 * MINUTE]);
  });

  it("keeps a flat window's readings, because flat is a finding the projection reports", async () => {
    const store = createStore();
    for (let index = 0; index < 5; index += 1) {
      const atMs = T0 + index * 5 * MINUTE;
      await store.record({ nowMs: atMs, accounts: [window(atMs, 42)], agents: [] });
    }
    const [series] = await store.readAccountSeries();
    expect(series?.samples).toHaveLength(5);
  });

  it("survives a restart", async () => {
    const first = createStore();
    await first.record({ nowMs: T0, accounts: [window(T0, 10, "weekly")], agents: [] });
    await first.close();

    const second = createStore();
    const [series] = await second.readAccountSeries();
    expect(series).toMatchObject({ providerId: "claude-personal", windowId: "weekly" });
    expect(series?.samples).toEqual([{ atMs: T0, usedPct: 10, resetsAtMs: T0 + 5 * HOUR }]);
  });

  it("starts over from a file it cannot parse instead of blocking the recorder", async () => {
    await fs.writeFile(path.join(rootDir, "accounts.json"), "{ not json", "utf8");
    const store = createStore();
    await store.record({ nowMs: T0, accounts: [window(T0, 10)], agents: [] });
    await store.close();
    const [series] = await createStore().readAccountSeries();
    expect(series?.samples).toHaveLength(1);
  });
});

describe("agent spend", () => {
  it("records only when the weighted total advances, so an idle agent costs no rows", async () => {
    const store = createStore();
    await store.record({ nowMs: T0, accounts: [], agents: [{ agentId: "a1", totalTokens: 100 }] });
    await store.record({
      nowMs: T0 + MINUTE,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 100 }],
    });
    await store.record({
      nowMs: T0 + 2 * MINUTE,
      accounts: [],
      agents: [
        { agentId: "a1", totalTokens: 100 },
        { agentId: "idle", totalTokens: 0 },
      ],
    });
    expect(await store.readAgentSpend("idle", 10)).toBeNull();
    const spend = await store.readAgentSpend("a1", 10);
    expect(spend?.points).toEqual([{ atMs: T0, weightedTokens: 100 }]);
    expect(spend?.totalWeightedTokens).toBe(100);
  });

  it("holds the line flat through a quiet stretch so a burst draws as a burst", async () => {
    const store = createStore();
    await store.record({ nowMs: T0, accounts: [], agents: [{ agentId: "a1", totalTokens: 100 }] });
    await store.record({
      nowMs: T0 + HOUR,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 900 }],
    });
    const spend = await store.readAgentSpend("a1", 10);
    expect(spend?.points).toEqual([
      { atMs: T0, weightedTokens: 100 },
      { atMs: T0 + HOUR - MINUTE, weightedTokens: 100 },
      { atMs: T0 + HOUR, weightedTokens: 900 },
    ]);
  });

  it("stays cumulative when the live counter starts over (agent closed and loaded again)", async () => {
    const store = createStore();
    await store.record({ nowMs: T0, accounts: [], agents: [{ agentId: "a1", totalTokens: 500 }] });
    await store.record({
      nowMs: T0 + MINUTE,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 800 }],
    });
    // The counter is zeroed and grows again from nothing.
    await store.record({
      nowMs: T0 + 2 * MINUTE,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 50 }],
    });
    const spend = await store.readAgentSpend("a1", 10);
    expect(spend?.points.map((point) => point.weightedTokens)).toEqual([500, 800, 850]);
  });

  it("stays cumulative across a daemon restart, which zeroes every live counter", async () => {
    const first = createStore();
    await first.record({ nowMs: T0, accounts: [], agents: [{ agentId: "a1", totalTokens: 500 }] });
    await first.close();

    const second = createStore();
    await second.record({
      nowMs: T0 + HOUR,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 120 }],
    });
    const spend = await second.readAgentSpend("a1", 10);
    expect(spend?.totalWeightedTokens).toBe(620);
    expect(spend?.points.at(-1)).toEqual({ atMs: T0 + HOUR, weightedTokens: 620 });
  });

  it("does not count a live agent twice when the cache is flushed and evicted around it", async () => {
    const store = new UsageHistoryStore({ rootDir, logger: silentLogger, flushIntervalMs: 0 });
    await store.record({ nowMs: T0, accounts: [], agents: [{ agentId: "a1", totalTokens: 500 }] });
    // Flushes on every sweep. The live agent must stay cached across them: reloading it from disk
    // would fold a counter that never restarted into the offset.
    await store.record({
      nowMs: T0 + MINUTE,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 700 }],
    });
    await store.record({
      nowMs: T0 + 2 * MINUTE,
      accounts: [],
      agents: [{ agentId: "a1", totalTokens: 900 }],
    });
    expect((await store.readAgentSpend("a1", 10))?.totalWeightedTokens).toBe(900);
  });

  it("downsamples to the requested number of points, keeping both ends", async () => {
    const store = createStore();
    for (let index = 1; index <= 50; index += 1) {
      await store.record({
        nowMs: T0 + index * MINUTE,
        accounts: [],
        agents: [{ agentId: "a1", totalTokens: index * 10 }],
      });
    }
    const spend = await store.readAgentSpend("a1", 8);
    expect(spend?.points).toHaveLength(8);
    expect(spend?.points[0]?.weightedTokens).toBe(10);
    expect(spend?.points.at(-1)?.weightedTokens).toBe(500);
  });

  it("rejects an agent id that could name a path", async () => {
    const store = createStore();
    await store.record({
      nowMs: T0,
      accounts: [],
      agents: [{ agentId: "../../etc/passwd", totalTokens: 10 }],
    });
    expect(await store.readAgentSpend("../../etc/passwd", 10)).toBeNull();
    await store.close();
    await expect(fs.readdir(path.join(rootDir, "agents"))).rejects.toThrow();
  });
});

describe("bounded retention", () => {
  it("expires readings older than retention and thins the ones older than a day", async () => {
    const store = createStore({ retentionDays: 8 });
    const now = T0 + 10 * DAY;
    const accounts: AccountWindowSampleInput[] = [];
    // Nine days of readings every five minutes.
    for (let atMs = now - 9 * DAY; atMs <= now; atMs += 5 * MINUTE) {
      accounts.push(window(atMs, 10));
    }
    await store.record({ nowMs: now, accounts, agents: [] });
    await store.prune(now);

    const [series] = await store.readAccountSeries();
    const samples = series?.samples ?? [];
    expect(samples[0]?.atMs ?? 0).toBeGreaterThanOrEqual(now - 8 * DAY);
    const recent = samples.filter((sample) => sample.atMs >= now - DAY);
    expect(recent).toHaveLength(DAY / (5 * MINUTE) + 1);
    const older = samples.filter((sample) => sample.atMs < now - DAY);
    for (let index = 1; index < older.length; index += 1) {
      expect(older[index]!.atMs - older[index - 1]!.atMs).toBeGreaterThanOrEqual(15 * MINUTE);
    }
    // 8 days at five minutes would be 2304 rows; thinning is what keeps the series under a
    // small ceiling however long the daemon runs.
    expect(samples.length).toBeLessThan(1_000);
  });

  it("caps a series at its hard limit", async () => {
    const store = createStore({ maxSamplesPerAccountSeries: 20 });
    const accounts: AccountWindowSampleInput[] = [];
    for (let index = 0; index < 100; index += 1) accounts.push(window(T0 + index * MINUTE, index));
    await store.record({ nowMs: T0 + 100 * MINUTE, accounts, agents: [] });
    const [series] = await store.readAccountSeries();
    expect(series?.samples).toHaveLength(20);
    expect(series?.samples.at(-1)?.usedPct).toBe(99);
  });

  it("caps the number of account series, keeping the most recently updated", async () => {
    const store = createStore({ maxAccountSeries: 2 });
    await store.record({
      nowMs: T0,
      accounts: [window(T0, 1, "a"), window(T0, 1, "b"), window(T0, 1, "c")],
      agents: [],
    });
    const series = await store.readAccountSeries();
    expect(series.map((entry) => entry.windowId).sort()).toEqual(["a", "b"]);
  });

  it("thins an agent's older half instead of stopping history when its file fills", async () => {
    const store = createStore({ maxSamplesPerAgentSeries: 40 });
    for (let index = 1; index <= 200; index += 1) {
      await store.record({
        nowMs: T0 + index * MINUTE,
        accounts: [],
        agents: [{ agentId: "a1", totalTokens: index }],
      });
    }
    const spend = await store.readAgentSpend("a1", 1_000);
    expect(spend?.points.length).toBeLessThanOrEqual(40);
    // The whole life is still there: first point early, last point is the latest.
    expect(spend?.points[0]?.atMs).toBeLessThan(T0 + 60 * MINUTE);
    expect(spend?.points.at(-1)?.weightedTokens).toBe(200);
  });

  it("deletes agent files past retention and beyond the count cap", async () => {
    const store = createStore({ retentionDays: 8, maxAgentSeries: 2 });
    const agentsDir = path.join(rootDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const now = Date.now();
    const files: Array<[string, number]> = [
      ["ancient", now - 30 * DAY],
      ["oldest-kept-out", now - 3 * DAY],
      ["newer", now - 2 * DAY],
      ["newest", now - DAY],
    ];
    for (const [agentId, mtimeMs] of files) {
      const filePath = path.join(agentsDir, `${agentId}.json`);
      await fs.writeFile(
        filePath,
        JSON.stringify({ v: 1, agentId, offset: 0, lastRaw: 0, samples: [[1, 1]] }),
      );
      await fs.utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
    }
    await store.prune(now);
    expect((await fs.readdir(agentsDir)).sort()).toEqual(["newer.json", "newest.json"]);
  });

  it("a long, busy history stays under a small on-disk ceiling", async () => {
    const store = createStore();
    const now = T0 + 30 * DAY;
    // Three accounts x three windows, a month of five-minute fetches, and 40 agents.
    for (let day = 30; day >= 0; day -= 1) {
      const accounts: AccountWindowSampleInput[] = [];
      const agents = [];
      for (let slot = 0; slot < DAY / (5 * MINUTE); slot += 1) {
        const atMs = now - day * DAY + slot * 5 * MINUTE;
        if (atMs > now) break;
        for (const provider of ["a", "b", "c"]) {
          for (const windowId of ["five_hour", "weekly", "weekly_model_fable"]) {
            accounts.push({ ...window(atMs, slot % 100, windowId), providerId: provider });
          }
        }
      }
      for (let index = 0; index < 40; index += 1) {
        agents.push({ agentId: `agent-${index}`, totalTokens: (30 - day) * 1_000 + index + 1 });
      }
      await store.record({ nowMs: now - day * DAY + DAY - 1, accounts, agents });
    }
    await store.prune(now);
    await store.close();

    let bytes = 0;
    for (const file of [
      "accounts.json",
      ...(await fs.readdir(path.join(rootDir, "agents"))).map((name) => `agents/${name}`),
    ]) {
      bytes += (await fs.stat(path.join(rootDir, file))).size;
    }
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
