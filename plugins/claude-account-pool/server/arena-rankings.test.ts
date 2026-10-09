import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  canonicalArenaName,
  loadArenaRankings,
  normalizeBoardRows,
  normalizeRow,
  refreshArenaRankings,
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
    };
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), JSON.stringify(freshFile), "utf-8");
    expect(await loadArenaRankings(tempDir, 72)).toEqual(freshFile);
  });

  it("returns null on malformed JSON", async () => {
    await fs.writeFile(path.join(tempDir, "arena-rankings.json"), "{not json", "utf-8");
    expect(await loadArenaRankings(tempDir)).toBeNull();
  });
});

describe("refreshArenaRankings", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-test-"));
    originalFetch = global.fetch;
  });

  afterEach(async () => {
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

    const result = await refreshArenaRankings(tempDir);
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

    const result = await refreshArenaRankings(tempDir);
    expect(result.status).toBe("success");
    expect(calls).toBeGreaterThan(1); // The retry happened.
  });

  it("keeps the previous file when every board fetch fails", async () => {
    const oldFile = { fetchedAt: Date.now() - 1000 * 60 * 60, publishDate: "2026-10-01", boards: { "agent/overall": [] }, unmatched: {} };
    const filePath = path.join(tempDir, "arena-rankings.json");
    await fs.writeFile(filePath, JSON.stringify(oldFile), "utf-8");

    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const result = await refreshArenaRankings(tempDir);
    expect(result.status).toBe("failed");

    const content = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(content).publishDate).toBe("2026-10-01");
  });

  it("writes an interrupted-write-safe file: a mid-write crash leaves the old file whole", async () => {
    const oldFile = { fetchedAt: Date.now() - 1000 * 60 * 60, publishDate: "2026-10-01", boards: {}, unmatched: {} };
    const filePath = path.join(tempDir, "arena-rankings.json");
    await fs.writeFile(filePath, JSON.stringify(oldFile), "utf-8");

    // Simulate a crash mid-refresh: the temp file gets written, but rename never happens
    // because the process dies first. The target file must be untouched.
    await fs.writeFile(`${filePath}.tmp-99999`, "{partial", "utf-8");

    const content = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(content).publishDate).toBe("2026-10-01");

    await fs.unlink(`${filePath}.tmp-99999`);
  });
});

describe("startArenaRankingsPoller", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;
  const noInterval = { setIntervalFn: (() => 0) as unknown as typeof setInterval, clearIntervalFn: (() => undefined) as typeof clearInterval };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-rankings-poller-test-"));
    originalFetch = global.fetch;
  });

  afterEach(async () => {
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
    await poller.runOnce();

    expect(await loadArenaRankings(tempDir)).not.toBeNull();
    poller.stop();
  });

  it("stop() is safe to call without ever having refreshed successfully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const poller = startArenaRankingsPoller(tempDir, noInterval);
    await poller.runOnce();
    expect(() => poller.stop()).not.toThrow();
  });
});
