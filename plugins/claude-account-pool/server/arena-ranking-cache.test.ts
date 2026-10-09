import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { createArenaRankingCache } from "./arena-ranking-cache";

const noInterval = { setIntervalFn: (() => 0) as unknown as typeof setInterval, clearIntervalFn: (() => undefined) as typeof clearInterval };

describe("createArenaRankingCache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-ranking-cache-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  it("starts empty until the first refresh", () => {
    const cache = createArenaRankingCache(tempDir, noInterval);
    expect(cache.get()).toBeUndefined();
    cache.stop();
  });

  it("reads the file once refreshed", async () => {
    const file = { fetchedAt: Date.now(), publishDate: "2026-10-08", boards: {}, unmatched: {} };
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(file), "utf-8");

    const cache = createArenaRankingCache(tempDir, noInterval);
    await cache.refresh();
    expect(cache.get()).toEqual(file);
    cache.stop();
  });

  it("returns undefined for a missing file", async () => {
    const cache = createArenaRankingCache(tempDir, noInterval);
    await cache.refresh();
    expect(cache.get()).toBeUndefined();
    cache.stop();
  });

  it("treats a file older than the current maxAgeHours as absent", async () => {
    const stale = { fetchedAt: Date.now() - 100 * 60 * 60 * 1000, publishDate: "2026-10-01", boards: {}, unmatched: {} };
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(stale), "utf-8");

    const cache = createArenaRankingCache(tempDir, { ...noInterval, getMaxAgeHours: () => 72 });
    await cache.refresh();
    expect(cache.get()).toBeUndefined();
    cache.stop();
  });

  it("re-reads getMaxAgeHours on every poll, picking up a live policy edit", async () => {
    const file = { fetchedAt: Date.now() - 80 * 60 * 60 * 1000, publishDate: "2026-10-05", boards: {}, unmatched: {} };
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(file), "utf-8");

    let maxAgeHours = 72;
    const cache = createArenaRankingCache(tempDir, { ...noInterval, getMaxAgeHours: () => maxAgeHours });
    await cache.refresh();
    expect(cache.get()).toBeUndefined(); // 80h old, over the 72h default.

    maxAgeHours = 100;
    await cache.refresh();
    expect(cache.get()).toEqual(file);
    cache.stop();
  });
});
