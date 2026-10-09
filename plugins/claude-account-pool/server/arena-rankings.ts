/**
 * Daily fetch of the LMArena leaderboard from Hugging Face datasets-server.
 * Normalizes names through the alias table and caches to disk atomically (U6).
 *
 * The file holds every board KTD-11's table references (keyed by `{config}/
 * {category}`), not one row set per kind of work: picking which board serves
 * a kind, and whether it has enough usable candidates, is the classifier's
 * job (U8), not this job's. This file stays data; the classifier never waits
 * on the network (R8, KTD-10).
 *
 * The HF datasets-server `/rows` endpoint caps `length` at 100 and has no
 * reliable server-side category filter, so a board is read by paging from
 * offset 0 and collecting rows while `category` matches, stopping once a
 * collected run ends (categories are stored as contiguous blocks).
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  allBoardIds,
  arenaAliasFor,
  type ArenaRankingRow,
  type ArenaRankingsFile,
  ArenaRankingsFileSchema,
} from "../shared/arena-aliases";
import { createIntervalPoller, type IntervalPoller } from "./interval-poller";

/** How often the job refreshes the file (KTD-10: "one refresh a day"). */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The minimum vote/observation count to include a row (KTD-10). */
const VOTE_FLOOR = 5;

/** The HF datasets-server API for LMArena (CC-BY-4.0; see docs/arena-ranking.md). */
const HF_DATASETS_API = "https://datasets-server.huggingface.co";
const HF_DATASET = "lmarena-ai/leaderboard-dataset";
const HF_SPLIT = "latest";
/** HF's hard cap on `/rows`' `length` parameter. */
const HF_PAGE_SIZE = 100;
/** Safety cap on pages scanned per board, so a dataset-shape change cannot loop forever. */
const MAX_PAGES_PER_BOARD = 40;

export interface TextRow {
  model_name: string;
  category: string;
  rating: number;
  rating_lower: number;
  rating_upper: number;
  vote_count: number;
  leaderboard_publish_date: string;
}

export interface AgentRow {
  model_name: string;
  category: string;
  score: number;
  score_ci_lower: number;
  score_ci_upper: number;
  observation_count: number;
  session_count?: number;
  leaderboard_publish_date: string;
}

export type LeaderboardRow = TextRow | AgentRow;

function isAgentRow(row: LeaderboardRow): row is AgentRow {
  return "score" in row;
}

/**
 * The agent board names models with a display string ("Claude Opus 5.5
 * (High)"); text and webdev boards already use our alias table's lowercase,
 * dash-joined form ("claude-opus-5.5-high"). Canonicalizing both to the same
 * shape — lowercase, parens dropped, spaces to dashes — lets one alias table
 * serve every board without a second, display-name table to keep in sync.
 * A harness-suffixed variant ("gpt-5.6-sol-xhigh (codex-harness)") still
 * fails to match on purpose: that is a different, uncredited configuration
 * (KTD-10, exact match only).
 */
export function canonicalArenaName(modelName: string): string {
  return modelName
    .toLowerCase()
    .replace(/[()]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Normalize one raw leaderboard row to our shape, or null when it is
 * unmatched (no exact alias) or below the vote floor. Pure; the fixture
 * tests call this directly without any network involved.
 */
export function normalizeRow(row: LeaderboardRow): ArenaRankingRow | null {
  const arenaName = canonicalArenaName(row.model_name);
  const alias = arenaAliasFor(arenaName);
  if (!alias) {
    return null;
  }

  const votes = isAgentRow(row) ? row.observation_count : row.vote_count;
  if (votes < VOTE_FLOOR) {
    return null;
  }

  const rating = isAgentRow(row) ? row.score : row.rating;
  const ratingLower = isAgentRow(row) ? row.score_ci_lower : row.rating_lower;
  const ratingUpper = isAgentRow(row) ? row.score_ci_upper : row.rating_upper;

  return { arenaName, ours: alias.ref, effort: alias.effort, rating, ratingLower, ratingUpper, votes };
}

/**
 * Normalize a whole board's raw rows: matched rows plus a count of the
 * unmatched ones (dropped, never guessed — KTD-10). Pure.
 */
export function normalizeBoardRows(rawRows: readonly LeaderboardRow[]): { rows: ArenaRankingRow[]; unmatched: number } {
  const rows: ArenaRankingRow[] = [];
  let unmatched = 0;
  for (const raw of rawRows) {
    const normalized = normalizeRow(raw);
    if (normalized) {
      rows.push(normalized);
    } else {
      unmatched++;
    }
  }
  return { rows, unmatched };
}

interface HfRowsPage {
  rows: Array<{ row: LeaderboardRow }>;
  num_rows_total: number;
}

/** One page fetch, with one retry and a short backoff on a transient error. */
async function fetchHfPage(config: string, offset: number): Promise<HfRowsPage> {
  const url = new URL(`${HF_DATASETS_API}/rows`);
  url.searchParams.set("dataset", HF_DATASET);
  url.searchParams.set("config", config);
  url.searchParams.set("split", HF_SPLIT);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(HF_PAGE_SIZE));

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      let resp: Response;
      try {
        resp = await fetch(url.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) {
        throw new Error(`HF datasets-server returned ${resp.status} for ${config} offset ${offset}`);
      }
      const data = (await resp.json()) as Partial<HfRowsPage>;
      if (!Array.isArray(data.rows) || typeof data.num_rows_total !== "number") {
        throw new Error(`Unexpected HF response shape for ${config} offset ${offset}`);
      }
      return { rows: data.rows, num_rows_total: data.num_rows_total };
    } catch (e) {
      lastError = e;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Page through one HF config from offset 0, collecting rows whose `category`
 * matches, and stopping once a collected run ends — categories sit in
 * contiguous blocks, so this never needs to know where a block starts.
 */
async function fetchBoardRawRows(config: string, category: string): Promise<LeaderboardRow[]> {
  const collected: LeaderboardRow[] = [];
  let collecting = false;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES_PER_BOARD; page++) {
    const { rows, num_rows_total } = await fetchHfPage(config, offset);
    if (rows.length === 0) {
      break;
    }
    for (const item of rows) {
      if (item.row.category === category) {
        collecting = true;
        collected.push(item.row);
      } else if (collecting) {
        return collected; // The category's contiguous block ended.
      }
    }
    offset += rows.length;
    if (offset >= num_rows_total) {
      break;
    }
  }
  return collected;
}

/** Fetch and normalize one `{config}/{category}` board. */
async function fetchBoard(boardId: string): Promise<{ rows: ArenaRankingRow[]; unmatched: number }> {
  const slashIndex = boardId.indexOf("/");
  const config = boardId.slice(0, slashIndex);
  const category = boardId.slice(slashIndex + 1);
  const rawRows = await fetchBoardRawRows(config, category);
  return normalizeBoardRows(rawRows);
}

/** Fetch and normalize every board KTD-11's table references. */
async function fetchAllBoards(): Promise<{
  boards: Record<string, ArenaRankingRow[]>;
  unmatched: Record<string, number>;
  failedBoards: string[];
}> {
  const boards: Record<string, ArenaRankingRow[]> = {};
  const unmatched: Record<string, number> = {};
  const failedBoards: string[] = [];

  for (const boardId of allBoardIds()) {
    try {
      const { rows, unmatched: boardUnmatched } = await fetchBoard(boardId);
      boards[boardId] = rows;
      unmatched[boardId] = boardUnmatched;
    } catch (e) {
      console.error(`arena-rankings: failed to fetch board ${boardId}: ${e instanceof Error ? e.message : e}`);
      failedBoards.push(boardId);
    }
  }

  return { boards, unmatched, failedBoards };
}

function rankingsFilePath(paseoHome: string): string {
  return path.join(paseoHome, "arena-rankings.json");
}

/** Write the rankings file atomically: write to a temp sibling, then rename over the target. */
async function writeRankingsFile(paseoHome: string, file: ArenaRankingsFile): Promise<void> {
  const targetPath = rankingsFilePath(paseoHome);
  const tempPath = `${targetPath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tempPath, targetPath);
}

async function readRankingsFile(paseoHome: string): Promise<ArenaRankingsFile | null> {
  try {
    const content = await fs.readFile(rankingsFilePath(paseoHome), "utf-8");
    return ArenaRankingsFileSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * One refresh of the arena rankings, called daily by the plugin's poller.
 * On success, writes the file atomically with today's publish date and every
 * board's rows and unmatched count. On total failure (every board's fetch
 * threw), the previous file is left untouched — the classifier's own
 * freshness check retires it (KTD-10, "Failure").
 */
export async function refreshArenaRankings(
  paseoHome: string,
): Promise<{ status: "success"; boardCount: number; unmatched: Record<string, number> } | { status: "failed"; error: string }> {
  try {
    const { boards, unmatched, failedBoards } = await fetchAllBoards();
    const boardIds = Object.keys(boards);
    if (boardIds.length === 0) {
      return { status: "failed", error: `every board fetch failed: ${failedBoards.join(", ")}` };
    }

    const file: ArenaRankingsFile = {
      fetchedAt: Date.now(),
      publishDate: new Date().toISOString().slice(0, 10),
      boards,
      unmatched,
    };

    await writeRankingsFile(paseoHome, file);
    if (failedBoards.length > 0) {
      console.error(`arena-rankings: ${failedBoards.length} board(s) failed and are absent from today's file: ${failedBoards.join(", ")}`);
    }
    return { status: "success", boardCount: boardIds.length, unmatched };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Load the rankings file from disk, if it exists and is fresh. Returns null
 * on missing, stale, or unparseable file — every caller treats that as
 * "today's order" (R8).
 */
export async function loadArenaRankings(paseoHome: string, maxAgeHours = 72): Promise<ArenaRankingsFile | null> {
  const file = await readRankingsFile(paseoHome);
  if (!file) {
    return null;
  }
  const ageHours = (Date.now() - file.fetchedAt) / (1000 * 60 * 60);
  if (ageHours > maxAgeHours) {
    return null;
  }
  return file;
}

/**
 * Starts the daily refresh job, following `jev-availability.ts`'s pattern:
 * one `createIntervalPoller` around the refresh, started at plugin startup
 * and run once immediately (fire-and-forget — a slow first fetch must not
 * delay plugin startup, the same reason `jevAvailability.refresh()` isn't
 * awaited there either). On failure the previous file is kept and the error
 * is logged; nothing here ever throws into the caller.
 */
export function startArenaRankingsPoller(
  paseoHome: string,
  options: { intervalMs?: number; setIntervalFn?: typeof setInterval; clearIntervalFn?: typeof clearInterval } = {},
): IntervalPoller<void> {
  const poller = createIntervalPoller<void>({
    intervalMs: options.intervalMs ?? REFRESH_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const result = await refreshArenaRankings(paseoHome);
      if (result.status === "failed") {
        console.error(`arena-rankings: daily refresh failed, keeping the previous file: ${result.error}`);
      } else {
        const unmatchedTotal = Object.values(result.unmatched).reduce((sum, n) => sum + n, 0);
        console.log(`arena-rankings: refreshed ${result.boardCount} board(s), ${unmatchedTotal} unmatched row(s) across them`);
      }
    },
  });
  void poller.runOnce();
  return poller;
}
