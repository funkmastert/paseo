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

/**
 * How often (and how many times) a daily refresh's `failedBoards` get a
 * short-cycle retry, merged into the existing file without re-fetching the
 * boards that already succeeded. Give up until the next daily refresh after
 * a few attempts rather than hammering a datasets-server that is still
 * rate-limiting us.
 */
const FAILED_BOARD_RETRY_INTERVAL_MS = 45 * 60 * 1000;
const MAX_FAILED_BOARD_RETRY_ATTEMPTS = 3;

/** The minimum vote/observation count to include a row (KTD-10). */
const VOTE_FLOOR = 5;

/** The HF datasets-server API for LMArena (CC-BY-4.0; see docs/arena-ranking.md). */
const HF_DATASETS_API = "https://datasets-server.huggingface.co";
const HF_DATASET = "lmarena-ai/leaderboard-dataset";
const HF_SPLIT = "latest";
/** HF's hard cap on `/rows`' `length` parameter. */
const HF_PAGE_SIZE = 100;
/** Safety cap on pages scanned per dataset config, so a dataset-shape change cannot loop forever. */
const MAX_PAGES_PER_CONFIG = 40;
/** Gap between consecutive HF requests, so a daily refresh doesn't burst the datasets-server. */
const REQUEST_SPACING_MS = 1_500;
/** Backoff schedule for a 429/5xx (or other transient error), honored unless `Retry-After` says otherwise. */
const RETRY_BACKOFFS_MS = [5_000, 15_000, 45_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses `Retry-After` as either delta-seconds or an HTTP date; undefined when neither parses. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

/** A 429 or 5xx from the datasets-server, carrying any `Retry-After` it sent. */
class RetryableHfError extends Error {
  constructor(status: number, config: string, offset: number, readonly retryAfterMs: number | undefined) {
    super(`HF datasets-server returned ${status} for ${config} offset ${offset}`);
  }
}

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

/**
 * One page fetch. Retries on any error up to `RETRY_BACKOFFS_MS.length` extra
 * times, backing off on the schedule — except a 429/5xx with a parseable
 * `Retry-After` waits that long instead, since the server is telling us
 * exactly when it'll accept another request.
 */
async function fetchHfPage(config: string, offset: number): Promise<HfRowsPage> {
  const url = new URL(`${HF_DATASETS_API}/rows`);
  url.searchParams.set("dataset", HF_DATASET);
  url.searchParams.set("config", config);
  url.searchParams.set("split", HF_SPLIT);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(HF_PAGE_SIZE));

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      let resp: Response;
      try {
        resp = await fetch(url.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        throw new RetryableHfError(resp.status, config, offset, parseRetryAfterMs(resp.headers.get("retry-after")));
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
      if (attempt < RETRY_BACKOFFS_MS.length) {
        const retryAfterMs = e instanceof RetryableHfError ? e.retryAfterMs : undefined;
        await sleep(retryAfterMs ?? RETRY_BACKOFFS_MS[attempt]);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Page through one HF config from offset 0, bucketing rows by `category` for
 * every category in `wantedCategories`, and stopping once every wanted
 * category's contiguous block has ended (or the config runs out of rows).
 * Several of our boards share one config — `text_style_control` alone covers
 * five categories — so reading the config once here instead of once per
 * category (the old per-board loop) cuts the request count sharply: the old
 * code re-paged from offset 0 for every category sharing a config,
 * re-reading every earlier category's block each time.
 */
async function fetchConfigCategoryRows(config: string, wantedCategories: ReadonlySet<string>): Promise<Map<string, LeaderboardRow[]>> {
  const collected = new Map<string, LeaderboardRow[]>();
  const finished = new Set<string>();
  let offset = 0;
  let lastCategory: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_CONFIG; page++) {
    if (page > 0) {
      await sleep(REQUEST_SPACING_MS);
    }
    const { rows, num_rows_total } = await fetchHfPage(config, offset);
    if (rows.length === 0) {
      break;
    }
    for (const item of rows) {
      const category = item.row.category;
      if (lastCategory !== undefined && category !== lastCategory && wantedCategories.has(lastCategory)) {
        finished.add(lastCategory); // The previous block ended.
      }
      lastCategory = category;
      if (wantedCategories.has(category) && !finished.has(category)) {
        const bucket = collected.get(category);
        if (bucket) {
          bucket.push(item.row);
        } else {
          collected.set(category, [item.row]);
        }
      }
    }
    offset += rows.length;
    if (offset >= num_rows_total) {
      break;
    }
    if ([...wantedCategories].every((c) => finished.has(c))) {
      break;
    }
  }
  return collected;
}

/**
 * Fetch and normalize a set of `{config}/{category}` boards, grouping by
 * config so each config is read at most once regardless of how many of its
 * categories are wanted. Spaces requests between configs the same way
 * `fetchConfigCategoryRows` spaces pages within one, so a refresh never
 * bursts the datasets-server.
 */
async function fetchBoardsGroupedByConfig(boardIds: readonly string[]): Promise<{
  boards: Record<string, ArenaRankingRow[]>;
  unmatched: Record<string, number>;
  failedBoards: string[];
}> {
  const boards: Record<string, ArenaRankingRow[]> = {};
  const unmatched: Record<string, number> = {};
  const failedBoards: string[] = [];

  const entriesByConfig = new Map<string, Array<{ category: string; boardId: string }>>();
  for (const boardId of boardIds) {
    const slashIndex = boardId.indexOf("/");
    const config = boardId.slice(0, slashIndex);
    const category = boardId.slice(slashIndex + 1);
    const entries = entriesByConfig.get(config);
    if (entries) {
      entries.push({ category, boardId });
    } else {
      entriesByConfig.set(config, [{ category, boardId }]);
    }
  }

  const configs = [...entriesByConfig.keys()];
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const entries = entriesByConfig.get(config);
    if (!entries) {
      continue;
    }
    if (i > 0) {
      await sleep(REQUEST_SPACING_MS);
    }
    try {
      const wantedCategories = new Set(entries.map((e) => e.category));
      const rowsByCategory = await fetchConfigCategoryRows(config, wantedCategories);
      for (const { category, boardId } of entries) {
        const { rows, unmatched: boardUnmatched } = normalizeBoardRows(rowsByCategory.get(category) ?? []);
        boards[boardId] = rows;
        unmatched[boardId] = boardUnmatched;
      }
    } catch (e) {
      console.error(`arena-rankings: failed to fetch config ${config}: ${e instanceof Error ? e.message : e}`);
      for (const { boardId } of entries) {
        failedBoards.push(boardId);
      }
    }
  }

  return { boards, unmatched, failedBoards };
}

/** Fetch and normalize every board KTD-11's table references. */
async function fetchAllBoards(): Promise<{
  boards: Record<string, ArenaRankingRow[]>;
  unmatched: Record<string, number>;
  failedBoards: string[];
}> {
  return fetchBoardsGroupedByConfig(allBoardIds());
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

/**
 * Split by failure kind so a genuine corruption bug is distinguishable in
 * `daemon.log` from the expected "no file yet" case, which logs nothing
 * (KTD-10's debugging contract — a human reading the log after a "rankings
 * never update" report needs to tell "the job hasn't run yet" apart from
 * "every refresh since some date has written something that fails to parse
 * back"). Either way the return contract is unchanged: `null`, R8 fail-open.
 */
async function readRankingsFile(paseoHome: string): Promise<ArenaRankingsFile | null> {
  const targetPath = rankingsFilePath(paseoHome);
  let content: string;
  try {
    content = await fs.readFile(targetPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`arena-rankings: failed to read ${targetPath}: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
  try {
    return ArenaRankingsFileSchema.parse(JSON.parse(content));
  } catch (e) {
    console.error(`arena-rankings: ${targetPath} failed to parse (corrupt or schema mismatch): ${e instanceof Error ? e.message : e}`);
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
      failedBoards,
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
 * Retries only `failedBoards` from the existing file — the boards that
 * already succeeded are never re-fetched — and merges any recovered boards
 * into the file atomically. Returns `"no-failed-boards"` when there is
 * nothing to retry (no file yet, or the last refresh had none), so the
 * poller's retry loop knows to reset its attempt counter.
 */
export async function retryFailedBoards(
  paseoHome: string,
): Promise<
  | { status: "no-failed-boards" }
  | { status: "merged"; recovered: string[]; stillFailed: string[] }
  | { status: "no-recovery"; stillFailed: string[] }
> {
  const file = await readRankingsFile(paseoHome);
  if (!file || file.failedBoards.length === 0) {
    return { status: "no-failed-boards" };
  }

  const { boards, unmatched, failedBoards: stillFailed } = await fetchBoardsGroupedByConfig(file.failedBoards);
  const recovered = file.failedBoards.filter((id) => !stillFailed.includes(id));
  if (recovered.length === 0) {
    return { status: "no-recovery", stillFailed };
  }

  const merged: ArenaRankingsFile = {
    ...file,
    boards: { ...file.boards, ...boards },
    unmatched: { ...file.unmatched, ...unmatched },
    failedBoards: stillFailed,
  };
  await writeRankingsFile(paseoHome, merged);
  return { status: "merged", recovered, stillFailed };
}

/**
 * Starts the daily refresh job, following `jev-availability.ts`'s pattern:
 * one `createIntervalPoller` around the refresh, started at plugin startup
 * and run once immediately (fire-and-forget — a slow first fetch must not
 * delay plugin startup, the same reason `jevAvailability.refresh()` isn't
 * awaited there either). On failure the previous file is kept and the error
 * is logged; nothing here ever throws into the caller.
 *
 * Alongside it, a second poller retries that refresh's `failedBoards` on a
 * shorter interval for a few attempts, merging any recovery into the file
 * (`retryFailedBoards`) so a board that failed once isn't stuck for a full
 * day. The attempt counter resets whenever a daily refresh runs (a fresh
 * baseline of failures) or a retry finds nothing left to retry.
 */
export function startArenaRankingsPoller(
  paseoHome: string,
  options: {
    intervalMs?: number;
    retryIntervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  } = {},
): IntervalPoller<void> {
  let retryAttempts = 0;

  const dailyPoller = createIntervalPoller<void>({
    intervalMs: options.intervalMs ?? REFRESH_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const result = await refreshArenaRankings(paseoHome);
      retryAttempts = 0;
      if (result.status === "failed") {
        console.error(`arena-rankings: daily refresh failed, keeping the previous file: ${result.error}`);
      } else {
        const unmatchedTotal = Object.values(result.unmatched).reduce((sum, n) => sum + n, 0);
        console.log(`arena-rankings: refreshed ${result.boardCount} board(s), ${unmatchedTotal} unmatched row(s) across them`);
      }
    },
  });

  const retryPoller = createIntervalPoller<void>({
    intervalMs: options.retryIntervalMs ?? FAILED_BOARD_RETRY_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      if (retryAttempts >= MAX_FAILED_BOARD_RETRY_ATTEMPTS) {
        return;
      }
      const result = await retryFailedBoards(paseoHome);
      if (result.status === "no-failed-boards") {
        retryAttempts = 0;
        return;
      }
      retryAttempts++;
      if (result.status === "merged") {
        console.log(`arena-rankings: recovered ${result.recovered.length} previously-failed board(s): ${result.recovered.join(", ")}`);
      }
    },
  });

  void dailyPoller.runOnce();

  return {
    runOnce: () => dailyPoller.runOnce(),
    stop: () => {
      dailyPoller.stop();
      retryPoller.stop();
    },
  };
}
