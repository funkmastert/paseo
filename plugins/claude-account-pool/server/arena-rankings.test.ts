import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// A real ES module namespace is not configurable, so `vi.spyOn(fs, "rename")` cannot work (see
// the "writes an interrupted-write-safe file" test below). Mocking the module itself, with every
// export delegating to the real implementation by default, gives that one test a seam to reject
// `rename` exactly once while every other test in this file keeps using real fs/promises behavior
// unchanged — including inside arena-rankings.ts's own `writeRankingsFile`, the function under test.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import {
  canonicalArenaName,
  loadArenaRankings,
  normalizeBoardRows,
  normalizeRow,
  refreshArenaRankings,
  retryFailedBoards,
  startArenaRankingsPoller,
  type AgentRow,
  type LeaderboardRow,
  type TextRow,
} from "./arena-rankings";

const FIXTURES_DIR = path.join(__dirname, "__fixtures__", "arena");

async function loadFixtureRows(name: string): Promise<LeaderboardRow[]> {
  const content = await fs.readFile(path.join(FIXTURES_DIR, name), "utf-8");
  const data = JSON.parse(content) as { rows: Array<{ row: LeaderboardRow }> };
  return data.rows.map((item) => item.row);
}

describe("canonicalArenaName", () => {
  it("passes through an already-canonical text-board name", () => {
    expect(canonicalArenaName("claude-sonnet-5.5-xhigh")).toBe("claude-sonnet-5.5-xhigh");
  });

  it("canonicalizes an agent-board display name", () => {
    expect(canonicalArenaName("Claude Opus 5.5 (High)")).toBe("claude-opus-5.5-high");
    expect(canonicalArenaName("GPT 6 Astra (Max)")).toBe("gpt-6-astra-max");
    expect(canonicalArenaName("Claude Sonnet 5.5 (Max)")).toBe("claude-sonnet-5.5-max");
  });

  it("does not collapse a harness-suffixed variant onto its base name", () => {
    expect(canonicalArenaName("gpt-5.6-sol-xhigh (codex-harness)")).toBe("gpt-5.6-sol-xhigh-codex-harness");
    expect(canonicalArenaName("gpt-5.6-sol-xhigh (codex-harness)")).not.toBe("gpt-5.6-sol-xhigh");
  });
});

describe("normalizeRow", () => {
  it("maps a text-board row (rating/rating_lower/rating_upper) to our shape", () => {
    const row: TextRow = {
      model_name: "claude-sonnet-5.5-xhigh",
      category: "coding",
      rating: 1476,
      rating_lower: 1460,
      rating_upper: 1492,
      vote_count: 500,
      leaderboard_publish_date: "2026-10-08",
    };
    expect(normalizeRow(row)).toEqual({
      arenaName: "claude-sonnet-5.5-xhigh",
      ours: "claude-sonnet-5-5",
      effort: "xhigh",
      rating: 1476,
      ratingLower: 1460,
      ratingUpper: 1492,
      votes: 500,
    });
  });

  it("maps an agent-board row (score/score_ci_*) to the same shape", () => {
    const row: AgentRow = {
      model_name: "GPT 6 Astra (Max)",
      category: "overall",
      score: 0.131,
      score_ci_lower: 0.107,
      score_ci_upper: 0.155,
      observation_count: 915013,
      leaderboard_publish_date: "2026-10-08",
    };
    expect(normalizeRow(row)).toEqual({
      arenaName: "gpt-6-astra-max",
      ours: "codex/gpt-6-astra",
      effort: "max",
      rating: 0.131,
      ratingLower: 0.107,
      ratingUpper: 0.155,
      votes: 915013,
    });
  });

  it("drops an unknown name rather than fuzzy-matching it", () => {
    const row: TextRow = {
      model_name: "gemini-4-argon-high",
      category: "coding",
      rating: 1500,
      rating_lower: 1490,
      rating_upper: 1510,
      vote_count: 1000,
      leaderboard_publish_date: "2026-10-08",
    };
    expect(normalizeRow(row)).toBeNull();
  });

  it("drops a row below the vote floor", () => {
    const row: TextRow = {
      model_name: "claude-sonnet-5.5-xhigh",
      category: "coding",
      rating: 1476,
      rating_lower: 1460,
      rating_upper: 1492,
      vote_count: 3, // below VOTE_FLOOR (5)
      leaderboard_publish_date: "2026-10-08",
    };
    expect(normalizeRow(row)).toBeNull();
  });

  it("keeps a row right at the vote floor", () => {
    const row: TextRow = {
      model_name: "claude-sonnet-5.5-xhigh",
      category: "coding",
      rating: 1476,
      rating_lower: 1460,
      rating_upper: 1492,
      vote_count: 5,
      leaderboard_publish_date: "2026-10-08",
    };
    expect(normalizeRow(row)).not.toBeNull();
  });
});

describe("normalizeBoardRows against captured fixtures", () => {
  it("maps the text_style_control coding fixture's known rows to the right refs and efforts", async () => {
    const rawRows = await loadFixtureRows("text-style-control-coding.json");
    const { rows, unmatched } = normalizeBoardRows(rawRows);

    const sonnet = rows.find((r) => r.arenaName === "claude-opus-5.5-high");
    expect(sonnet).toMatchObject({ ours: "claude-opus-5-5", effort: "high" });

    const sol = rows.find((r) => r.arenaName === "gpt-6.1-sol-max");
    expect(sol).toMatchObject({ ours: "codex/gpt-6.1-sol", effort: "max" });

    const astra = rows.find((r) => r.arenaName === "gpt-6-astra-max");
    expect(astra).toMatchObject({ ours: "codex/gpt-6-astra", effort: "max" });

    // gemini, kimi, mimo, muse, claude-fable are all unmatched on purpose.
    expect(unmatched).toBeGreaterThan(0);
    expect(rows.length + unmatched).toBe(rawRows.length);
  });

  it("maps the webdev-react fixture's known rows to the right refs and efforts", async () => {
    const rawRows = await loadFixtureRows("webdev-webdev-react.json");
    const { rows, unmatched } = normalizeBoardRows(rawRows);

    const sonnet55 = rows.find((r) => r.arenaName === "claude-sonnet-5.5-xhigh");
    expect(sonnet55).toMatchObject({ ours: "claude-sonnet-5-5", effort: "xhigh" });

    const sol = rows.find((r) => r.arenaName === "gpt-6-sol-max");
    expect(sol).toMatchObject({ ours: "codex/gpt-6-sol", effort: "max" });

    // qwen, gemini, grok, muse, kimi are unmatched.
    expect(unmatched).toBeGreaterThan(0);
    expect(rows.length + unmatched).toBe(rawRows.length);
  });

  it("maps the agent-overall fixture's display-name rows to the right refs and efforts", async () => {
    const rawRows = await loadFixtureRows("agent-overall.json");
    const { rows, unmatched } = normalizeBoardRows(rawRows);

    const opus55 = rows.find((r) => r.arenaName === "claude-opus-5.5-high");
    expect(opus55).toMatchObject({ ours: "claude-opus-5-5", effort: "high" });

    const astra = rows.find((r) => r.arenaName === "gpt-6-astra-max");
    expect(astra).toMatchObject({ ours: "codex/gpt-6-astra", effort: "max" });

    const sonnet55max = rows.find((r) => r.arenaName === "claude-sonnet-5.5-max");
    expect(sonnet55max).toMatchObject({ ours: "claude-sonnet-5-5", effort: "max" });

    // Gemini, Claude Fable, and old Claude Opus 4.8 are unmatched.
    expect(unmatched).toBeGreaterThan(0);
    expect(rows.length + unmatched).toBe(rawRows.length);
  });

  it("normalizes an agent-board row and a text-board row to one shape", async () => {
    const agentRows = await loadFixtureRows("agent-overall.json");
    const textRows = await loadFixtureRows("text-style-control-coding.json");
    const { rows: fromAgent } = normalizeBoardRows(agentRows);
    const { rows: fromText } = normalizeBoardRows(textRows);

    for (const row of [...fromAgent, ...fromText]) {
      expect(row).toHaveProperty("arenaName");
      expect(row).toHaveProperty("ours");
      expect(row).toHaveProperty("effort");
      expect(row).toHaveProperty("rating");
      expect(row).toHaveProperty("ratingLower");
      expect(row).toHaveProperty("ratingUpper");
      expect(row).toHaveProperty("votes");
    }
  });
});

describe("loadArenaRankings", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  it("returns null when the file does not exist", async () => {
    expect(await loadArenaRankings(tempDir)).toBeNull();
  });

  it("returns null when the file is stale (over maxAgeHours)", async () => {
    const staleFile = { fetchedAt: Date.now() - 100 * 60 * 60 * 1000, publishDate: "2026-09-09", boards: {}, unmatched: {} };
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(staleFile), "utf-8");
    expect(await loadArenaRankings(tempDir, 72)).toBeNull();
  });

  it("returns the file when it exists and is fresh", async () => {
    const freshFile = {
      fetchedAt: Date.now() - 1 * 60 * 60 * 1000,
      publishDate: "2026-10-08",
      boards: {
        "agent/overall": [
          { arenaName: "claude-sonnet-5.5-max", ours: "claude-sonnet-5-5", effort: "max", rating: 0.12, ratingLower: 0.11, ratingUpper: 0.13, votes: 150 },
        ],
      },
      unmatched: { "agent/overall": 2 },
      failedBoards: [],
    };
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(freshFile), "utf-8");
    expect(await loadArenaRankings(tempDir, 72)).toEqual(freshFile);
  });

  it("returns null on malformed JSON", async () => {
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), "{not json", "utf-8");
    expect(await loadArenaRankings(tempDir)).toBeNull();
  });

  describe("corruption is distinguishable from a missing file (finding #5)", () => {
    it("logs nothing for a missing file: the expected 'job hasn't run yet' case", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await loadArenaRankings(tempDir);
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it("logs an error for malformed JSON: a genuine corruption bug", async () => {
      await fs.writeFile(path.join(tempDir, "arena-rankings.json"), "{not json", "utf-8");
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await loadArenaRankings(tempDir);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("failed to parse"));
      errors.mockRestore();
    });

    it("logs an error for valid JSON that fails the schema: also a genuine corruption bug", async () => {
      await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify({ not: "the right shape" }), "utf-8");
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await loadArenaRankings(tempDir);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("failed to parse"));
      errors.mockRestore();
    });
  });
});

/**
 * Drives a fake-timers test: starts the call, flushes every scheduled timer, then awaits the
 * result. `retryFailedBoards` reads the rankings file (real fs I/O) before it ever reaches a
 * `setTimeout` — `vi.runAllTimersAsync()` called while zero timers are registered returns
 * immediately, racing ahead of that read and leaving the later backoff timers (registered only
 * once the read resolves) stuck on real wall-clock time. Yielding to the real event loop
 * (`setImmediate`, left un-faked by `toFake` below) until a timer actually exists closes that race.
 */
async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  const resultPromise = fn();
  for (let i = 0; i < 50 && vi.getTimerCount() === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await vi.runAllTimersAsync();
  return resultPromise;
}

describe("refreshArenaRankings", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-test-"));
    originalFetch = global.fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  /** One HF `/rows` page response for every board, so every board id resolves on its first page. */
  function singlePageFetchMock() {
    return vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (offset > 0) {
        return new Response(JSON.stringify({ rows: [], num_rows_total: 1 }), { status: 200 });
      }
      const category = config === "agent" || config === "agent_bash_recovery_steps" ? "overall" : "overall";
      const row =
        config === "agent" || config === "agent_bash_recovery_steps"
          ? { model_name: "Claude Sonnet 5.5 (Max)", category, score: 0.12, score_ci_lower: 0.11, score_ci_upper: 0.13, observation_count: 150, leaderboard_publish_date: "2026-10-08" }
          : { model_name: "claude-sonnet-5.5-high", category, rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-08" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
    });
  }

  it("writes the file atomically on success", async () => {
    global.fetch = singlePageFetchMock() as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    const written = await loadArenaRankings(tempDir);
    expect(written).not.toBeNull();
    expect(written?.publishDate).toBe(new Date().toISOString().slice(0, 10));
    expect(Object.keys(written?.boards ?? {}).length).toBeGreaterThan(0);

    // No leftover temp file.
    const files = await fs.readdir(tempDir);
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("retries a transient error on one board, then succeeds", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls++;
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset"));
      if (offset > 0) {
        return new Response(JSON.stringify({ rows: [], num_rows_total: 1 }), { status: 200 });
      }
      // The very first call ever made fails transiently; every later first-page call succeeds.
      if (calls === 1) {
        throw new Error("transient network error");
      }
      const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-08" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");
    expect(calls).toBeGreaterThan(1); // The retry happened.
  });

  it("persists which boards failed when one config's boards fail entirely but others succeed (finding #6)", async () => {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      if (config === "webdev") {
        throw new Error("persistent network error for webdev");
      }
      const offset = Number(u.searchParams.get("offset"));
      if (offset > 0) {
        return new Response(JSON.stringify({ rows: [], num_rows_total: 1 }), { status: 200 });
      }
      const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-08" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    const written = await loadArenaRankings(tempDir);
    // A degraded day is auditable from the file itself: the failed board ids are persisted,
    // not only logged to a console line that may have rotated out.
    expect(written?.failedBoards).toEqual(expect.arrayContaining(["webdev/webdev-react", "webdev/overall"]));
    expect(written?.boards["webdev/webdev-react"]).toBeUndefined();
  });

  it("keeps the previous file when every board fetch fails", async () => {
    const oldFile = { fetchedAt: Date.now() - 1000 * 60 * 60, publishDate: "2026-10-01", boards: { "agent/overall": [] }, unmatched: {} };
    const filePath = path.join(tempDir, "arena-rankings.json");
    await fs.writeFile(filePath, JSON.stringify(oldFile), "utf-8");

    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("failed");

    const content = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(content).publishDate).toBe("2026-10-01");
  });

  it("writes an interrupted-write-safe file: a mid-write crash leaves the old file whole", async () => {
    const oldFile = { fetchedAt: Date.now() - 1000 * 60 * 60, publishDate: "2026-10-01", boards: {}, unmatched: {}, failedBoards: [] };
    const filePath = path.join(tempDir, "arena-rankings.json");
    await fs.writeFile(filePath, JSON.stringify(oldFile), "utf-8");

    global.fetch = singlePageFetchMock() as unknown as typeof fetch;

    // Exercise the real write path (writeRankingsFile) under a simulated crash between the temp
    // write and the rename that makes it visible, rather than writing an unrelated sibling file
    // that proves nothing about writeRankingsFile's own atomicity.
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("simulated crash before rename"));

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("failed");

    const content = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(content).publishDate).toBe("2026-10-01");

    // Clean up the stray temp file the simulated crash left behind.
    const files = await fs.readdir(tempDir);
    await Promise.all(files.filter((f) => f.includes(".tmp-")).map((f) => fs.unlink(path.join(tempDir, f))));
  });
});

describe("startArenaRankingsPoller", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;
  const noInterval = { setIntervalFn: (() => 0) as unknown as typeof setInterval, clearIntervalFn: (() => undefined) as typeof clearInterval };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-poller-test-"));
    originalFetch = global.fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  it("refreshes once immediately at startup, fire-and-forget", async () => {
    global.fetch = vi.fn().mockImplementation(async () => {
      const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-08" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const poller = startArenaRankingsPoller(tempDir, noInterval);
    // The initial run is fire-and-forget; runOnce() against the same in-flight call lets the test
    // wait for it without asserting anything about timing.
    await runWithFakeTimers(() => poller.runOnce());

    expect(await loadArenaRankings(tempDir)).not.toBeNull();
    poller.stop();
  });

  it("stop() is safe to call without ever having refreshed successfully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const poller = startArenaRankingsPoller(tempDir, noInterval);
    await runWithFakeTimers(() => poller.runOnce());
    expect(() => poller.stop()).not.toThrow();
  });

  it("caps retryOnce at MAX_FAILED_BOARD_RETRY_ATTEMPTS, then a successful daily refresh resets the budget", async () => {
    function failTextStyleControlMock() {
      return vi.fn().mockImplementation(async (url: string) => {
        const config = new URL(url).searchParams.get("config");
        if (config === "text_style_control") {
          throw new Error("still down");
        }
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }) as unknown as typeof fetch;
    }
    function succeedMock() {
      return vi.fn().mockImplementation(async () => {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }) as unknown as typeof fetch;
    }

    // Seed the file with text_style_control's boards failed via the daily refresh.
    global.fetch = failTextStyleControlMock();
    const poller = startArenaRankingsPoller(tempDir, noInterval);
    await runWithFakeTimers(() => poller.runOnce());
    expect((await loadArenaRankings(tempDir))?.failedBoards.length).toBeGreaterThan(0);

    // 3 retry attempts, each actually driven (not short-circuited by the cap).
    global.fetch = failTextStyleControlMock();
    for (let i = 0; i < 3; i++) {
      const result = await runWithFakeTimers(() => poller.retryOnce());
      expect(result.status).not.toBe("capped");
    }

    // A 4th attempt is capped: retryFailedBoards (and fetch) never runs.
    global.fetch = vi.fn(async () => {
      throw new Error("retryOnce should not have called fetch once capped");
    }) as unknown as typeof fetch;
    const fourth = await runWithFakeTimers(() => poller.retryOnce());
    expect(fourth).toEqual({ status: "capped" });

    // A daily refresh — success or failure — resets the attempt budget. Here it succeeds fully,
    // so the file ends up with zero failed boards; retryOnce after it reports "no-failed-boards"
    // (it checked, found nothing to do) rather than "capped" (it never checked at all), proving
    // the counter was actually reset rather than left exhausted.
    global.fetch = succeedMock();
    await runWithFakeTimers(() => poller.runOnce());

    const afterReset = await runWithFakeTimers(() => poller.retryOnce());
    expect(afterReset).toEqual({ status: "no-failed-boards" });

    poller.stop();
  });
});

describe("retryFailedBoards", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-retry-test-"));
    originalFetch = global.fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  const goodBoard = {
    arenaName: "claude-sonnet-5.5-max",
    ours: "claude-sonnet-5-5",
    effort: "max",
    rating: 0.12,
    ratingLower: 0.11,
    ratingUpper: 0.13,
    votes: 150,
  };

  async function seedFile(failedBoards: string[]): Promise<void> {
    await fs.writeFile(
      path.join(tempDir, "arena-rankings.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        publishDate: "2026-10-09",
        boards: { "agent/overall": [goodBoard] },
        unmatched: { "agent/overall": 2 },
        failedBoards,
      }),
      "utf-8",
    );
  }

  it("reports nothing to do when the file has no failed boards", async () => {
    await seedFile([]);
    const result = await runWithFakeTimers(() => retryFailedBoards(tempDir));
    expect(result).toEqual({ status: "no-failed-boards" });
  });

  it("reports nothing to do when there is no file yet", async () => {
    const result = await runWithFakeTimers(() => retryFailedBoards(tempDir));
    expect(result).toEqual({ status: "no-failed-boards" });
  });

  it("retries only the failed board, merges it in, and leaves the good board untouched", async () => {
    await seedFile(["text_style_control/hard_prompts"]);

    const requestedConfigs: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      requestedConfigs.push(new URL(url).searchParams.get("config") ?? "");
      const row = {
        model_name: "claude-sonnet-5.5-high",
        category: "hard_prompts",
        rating: 1500,
        rating_lower: 1490,
        rating_upper: 1510,
        vote_count: 200,
        leaderboard_publish_date: "2026-10-09",
      };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => retryFailedBoards(tempDir));
    expect(result).toEqual({ status: "merged", recovered: ["text_style_control/hard_prompts"], stillFailed: [] });

    // The good board's config is never requested again — only the previously-failed board's config is.
    expect(requestedConfigs.every((c) => c === "text_style_control")).toBe(true);

    const written = await loadArenaRankings(tempDir);
    expect(written?.boards["agent/overall"]).toEqual([goodBoard]); // Untouched.
    expect(written?.boards["text_style_control/hard_prompts"]).toMatchObject([{ ours: "claude-sonnet-5-5", effort: "high" }]);
    expect(written?.failedBoards).toEqual([]);
  });

  it("leaves the file as-is when the retry fails again, and logs the failure", async () => {
    await seedFile(["text_style_control/hard_prompts"]);
    global.fetch = vi.fn().mockRejectedValue(new Error("still down")) as unknown as typeof fetch;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runWithFakeTimers(() => retryFailedBoards(tempDir));
    expect(result).toEqual({ status: "no-recovery", stillFailed: ["text_style_control/hard_prompts"] });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("still failing"));

    const written = await loadArenaRankings(tempDir);
    expect(written?.boards["agent/overall"]).toEqual([goodBoard]);
    expect(written?.failedBoards).toEqual(["text_style_control/hard_prompts"]);
    errors.mockRestore();
  });

  it("drops the merge when the file moved underneath it (a daily refresh committed mid-retry)", async () => {
    await seedFile(["text_style_control/hard_prompts"]);

    const newerFile = {
      fetchedAt: Date.now() + 10_000, // A daily refresh that committed after this retry's read.
      publishDate: "2026-10-10",
      boards: { "agent/overall": [goodBoard] },
      unmatched: { "agent/overall": 0 },
      failedBoards: ["webdev/overall"], // A different failure set than the one this retry is chasing.
    };

    global.fetch = vi.fn().mockImplementation(async () => {
      // Simulate the daily refresh's write landing while this retry's fetch is still in flight.
      await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(newerFile), "utf-8");
      const row = {
        model_name: "claude-sonnet-5.5-high",
        category: "hard_prompts",
        rating: 1500,
        rating_lower: 1490,
        rating_upper: 1510,
        vote_count: 200,
        leaderboard_publish_date: "2026-10-09",
      };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => retryFailedBoards(tempDir));
    expect(result).toEqual({ status: "superseded", stillFailed: [] });

    // The retry's recovered board is dropped entirely — the newer write stands untouched.
    const written = await loadArenaRankings(tempDir);
    expect(written).toEqual(newerFile);
  });
});

describe("HF 429/5xx backoff", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-backoff-test-"));
    originalFetch = global.fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  function okPage() {
    const row = {
      model_name: "claude-sonnet-5.5-high",
      category: "overall",
      rating: 1500,
      rating_lower: 1490,
      rating_upper: 1510,
      vote_count: 200,
      leaderboard_publish_date: "2026-10-09",
    };
    return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
  }

  it("retries a 429 after the first exponential backoff step (5s), not before", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return okPage();
    }) as unknown as typeof fetch;

    const resultPromise = refreshArenaRankings(tempDir);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1); // Still waiting out the 5s backoff.

    await vi.advanceTimersByTimeAsync(1);
    // The retried call (and the rest of the refresh) can now proceed.
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.status).toBe("success");
    expect(calls).toBeGreaterThan(1);
  });

  it("honors a numeric Retry-After header instead of the default backoff", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "2" } });
      }
      return okPage();
    }) as unknown as typeof fetch;

    const resultPromise = refreshArenaRankings(tempDir);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1); // Retry-After said 2s, not the default 5s backoff.

    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.status).toBe("success");
    expect(calls).toBeGreaterThan(1);
  });

  it("backs off on a 5xx the same as a 429", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("internal error", { status: 503 });
      }
      return okPage();
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");
    expect(calls).toBeGreaterThan(1);
  });

  it("honors a future HTTP-date Retry-After, waiting roughly the delta rather than the 5s default", async () => {
    let calls = 0;
    // HTTP-date has no sub-second precision, so toUTCString() can truncate this by up to ~1s —
    // the assertions below leave slack for that instead of pinning an exact millisecond.
    const retryAt = new Date(Date.now() + 2_000);
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": retryAt.toUTCString() } });
      }
      return okPage();
    }) as unknown as typeof fetch;

    const resultPromise = refreshArenaRankings(tempDir);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1); // Not yet — not even a fully-truncated ~1s delta has elapsed.

    await vi.advanceTimersByTimeAsync(2_500);
    // Comfortably past the (possibly truncated) ~2s delta, and well short of the 5s default —
    // proving the date-derived wait was honored instead of the default schedule.
    expect(calls).toBeGreaterThan(1);

    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.status).toBe("success");
  });

  it("clamps a past HTTP-date Retry-After to an immediate retry instead of a negative wait", async () => {
    let calls = 0;
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    global.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": pastDate } });
      }
      return okPage();
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");
    expect(calls).toBeGreaterThan(1); // Clamped to 0ms, not skipped or left negative.
  });

  it("caps an excessive Retry-After: fails that page immediately instead of sleeping it out", async () => {
    // "agent" is the first config fetchAllBoards processes. Every call for it hits a 6-minute
    // Retry-After — past MAX_RETRY_AFTER_MS (5 min) — on every attempt, forever. If the cap
    // didn't apply, fetchHfPage would sleep 6 minutes and retry, growing this count past 1; capped,
    // it throws on the very first 429 without ever sleeping or re-attempting that page.
    let agentCalls = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const config = new URL(url).searchParams.get("config");
      if (config === "agent") {
        agentCalls++;
        return new Response("rate limited", { status: 429, headers: { "retry-after": String(6 * 60) } });
      }
      return okPage();
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));

    expect(agentCalls).toBe(1); // No retry attempted — failed fast instead of sleeping 6 minutes.
    expect(result.status).toBe("success"); // Every other config still succeeded; only "agent" failed.
    const written = await loadArenaRankings(tempDir);
    expect(written?.failedBoards).toContain("agent/overall");
  });
});

describe("fetching a config shared by several categories", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-shared-config-test-"));
    originalFetch = global.fetch;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true }).catch(() => undefined);
  });

  it("reads text_style_control once instead of once per category it serves", async () => {
    // text_style_control backs 5 of the 9 boards KIND_BOARD_PREFERENCE lists (coding, expert,
    // hard_prompts, instruction_following, creative_writing). One page per category, in that
    // dataset order, so the old per-board loop would re-page from offset 0 for every one of them:
    // 1 (coding) + 2 (through hard_prompts) + 3 (through instruction_following) + 4 (through
    // creative_writing) + 5 (through expert) = 15 requests for this config alone. The new
    // config-grouped fetch reads each page exactly once: 5 requests.
    const categoryOrder = ["coding", "hard_prompts", "instruction_following", "creative_writing", "expert"];
    const textStyleControlCalls: number[] = [];
    let otherConfigCalls = 0;

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (config !== "text_style_control") {
        otherConfigCalls++;
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      textStyleControlCalls.push(offset);
      if (offset >= categoryOrder.length) {
        return new Response(JSON.stringify({ rows: [], num_rows_total: categoryOrder.length }), { status: 200 });
      }
      const category = categoryOrder[offset];
      const row = { model_name: "claude-sonnet-5.5-high", category, rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: categoryOrder.length }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    // One request per page of the config, not one full re-scan per category.
    expect(textStyleControlCalls).toEqual([0, 1, 2, 3, 4]);

    const written = await loadArenaRankings(tempDir);
    for (const category of categoryOrder) {
      expect(written?.boards[`text_style_control/${category}`]).toHaveLength(1);
    }
  });

  it("doesn't drop rows when a category's block is interleaved (non-contiguous) in the config", async () => {
    // "coding" rows appear, then "expert" interrupts, then "coding" resumes — violating the
    // documented contiguous-block assumption. An earlier version tracked a "finished" category
    // via the previous row's category changing, which would permanently drop the resumed "coding"
    // rows at offset 2. The fix removed that tracking: every row whose category is wanted gets
    // bucketed regardless of what came before or after it.
    const pages = [
      { category: "coding", name: "claude-sonnet-5.5-high" }, // offset 0
      { category: "expert", name: "claude-opus-5-high" }, // offset 1 — interrupts "coding"
      { category: "coding", name: "claude-opus-5.5-high" }, // offset 2 — "coding" resumes
    ];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (config !== "text_style_control") {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      if (offset >= pages.length) {
        return new Response(JSON.stringify({ rows: [], num_rows_total: pages.length }), { status: 200 });
      }
      const page = pages[offset];
      const row = { model_name: page.name, category: page.category, rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: pages.length }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    const written = await loadArenaRankings(tempDir);
    // Both "coding" rows (offset 0 and the resumed offset 2) survive, not just the first.
    expect(written?.boards["text_style_control/coding"]).toHaveLength(2);
    expect(written?.boards["text_style_control/expert"]).toHaveLength(1);
  });

  it("keeps rows already collected for other categories when a later page in the same config fails", async () => {
    // "coding"'s entire block (2 rows) is read successfully on pages 0-1; page 2 (which would
    // have served "expert") then fails every attempt. The config-level fetch should still credit
    // "coding" with its 2 rows instead of discarding everything the config ever collected.
    const codingRows = [
      { model_name: "claude-sonnet-5.5-high", category: "coding" },
      { model_name: "claude-opus-5-high", category: "coding" },
    ];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (config !== "text_style_control") {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      if (offset < codingRows.length) {
        const page = codingRows[offset];
        const row = { model_name: page.model_name, category: page.category, rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 10 }), { status: 200 });
      }
      // Every later page (would-be "expert" rows) fails every attempt.
      return new Response("internal error", { status: 503 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success"); // Other configs succeeded; text_style_control is partial, not total, failure.

    const written = await loadArenaRankings(tempDir);
    // "coding" (fully read before the failing page) keeps its rows.
    expect(written?.boards["text_style_control/coding"]).toHaveLength(2);
    // "expert" (never reached) is the one marked failed, not "coding".
    expect(written?.failedBoards).toContain("text_style_control/expert");
    expect(written?.failedBoards).not.toContain("text_style_control/coding");
  });

  it("a persistent 429 mid-scan marks every category not yet collected as failed, not as an empty board", async () => {
    // "coding" (offset 0) is read fine; every page from offset 1 on (which would have served
    // "instruction_following") 429s on every attempt, exhausting fetchHfPage's own retries.
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (config !== "text_style_control") {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      if (offset === 0) {
        const row = { model_name: "claude-sonnet-5.5-high", category: "coding", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 10 }), { status: 200 });
      }
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    const written = await loadArenaRankings(tempDir);
    expect(written?.boards["text_style_control/coding"]).toHaveLength(1);
    // "instruction_following" was never reached -- it must be failed, not present with 0 rows.
    expect(written?.boards["text_style_control/instruction_following"]).toBeUndefined();
    expect(written?.failedBoards).toContain("text_style_control/instruction_following");
  });

  it("fetches a wanted category that sits past the old 40-page cap", async () => {
    // "instruction_following"'s only row sits at offset 44 -- past the old 40-page
    // (4,000-row) cap, which never read it at all.
    const INSTRUCTION_FOLLOWING_OFFSET = 44;
    const TOTAL_ROWS = INSTRUCTION_FOLLOWING_OFFSET + 1;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (config !== "text_style_control") {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      if (offset >= TOTAL_ROWS) {
        return new Response(JSON.stringify({ rows: [], num_rows_total: TOTAL_ROWS }), { status: 200 });
      }
      const category = offset === INSTRUCTION_FOLLOWING_OFFSET ? "instruction_following" : "coding";
      const row = { model_name: "claude-sonnet-5.5-high", category, rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: TOTAL_ROWS }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    const written = await loadArenaRankings(tempDir);
    expect(written?.boards["text_style_control/instruction_following"]).toHaveLength(1);
    expect(written?.failedBoards ?? []).not.toContain("text_style_control/instruction_following");
  });

  it("stops paging once offset reaches num_rows_total, without requesting a trailing empty page", async () => {
    // 250 rows at 100/page is 3 requests (offsets 0, 100, 200); a 4th at offset 300 would mean
    // the loop kept going past num_rows_total instead of stopping right at it.
    const TOTAL_ROWS = 250;
    const requestedOffsets: number[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      const offset = Number(u.searchParams.get("offset"));
      if (config !== "text_style_control") {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      requestedOffsets.push(offset);
      const remaining = TOTAL_ROWS - offset;
      const pageSize = Math.min(100, remaining);
      const rows = Array.from({ length: pageSize }, () => ({
        row: { model_name: "claude-sonnet-5.5-high", category: "coding", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" },
      }));
      return new Response(JSON.stringify({ rows, num_rows_total: TOTAL_ROWS }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success");

    expect(requestedOffsets).toEqual([0, 100, 200]);
    const written = await loadArenaRankings(tempDir);
    expect(written?.boards["text_style_control/coding"]).toHaveLength(TOTAL_ROWS);
  });

  it("exhausting the page safety cap without finishing marks every uncollected wanted category failed, not empty", async () => {
    // Every page serves "coding" rows and reports a num_rows_total far beyond what
    // MAX_PAGES_PER_CONFIG (300 pages x 100 rows) can ever reach -- the scan runs out of
    // pages before it runs out of rows. "instruction_following" never appears on any page.
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = new URL(url);
      const config = u.searchParams.get("config");
      if (config !== "text_style_control") {
        const row = { model_name: "claude-sonnet-5.5-high", category: "overall", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
        return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1 }), { status: 200 });
      }
      const row = { model_name: "claude-sonnet-5.5-high", category: "coding", rating: 1500, rating_lower: 1490, rating_upper: 1510, vote_count: 200, leaderboard_publish_date: "2026-10-09" };
      return new Response(JSON.stringify({ rows: [{ row }], num_rows_total: 1_000_000 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runWithFakeTimers(() => refreshArenaRankings(tempDir));
    expect(result.status).toBe("success"); // Other configs still succeeded.

    const written = await loadArenaRankings(tempDir);
    // "coding" was actually collected within the cap -- partial credit, same as any other
    // mid-scan failure.
    expect(written?.boards["text_style_control/coding"]?.length).toBeGreaterThan(0);
    // "instruction_following" was never reached -- failed, not an empty board.
    expect(written?.boards["text_style_control/instruction_following"]).toBeUndefined();
    expect(written?.failedBoards).toContain("text_style_control/instruction_following");
  }, 15_000);
});
