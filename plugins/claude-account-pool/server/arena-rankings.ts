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
import { randomUUID } from "crypto";
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
/**
 * Safety cap on pages scanned per dataset config -- a last-resort circuit breaker against a
 * dataset-shape change that makes `num_rows_total` lie or a page never come back short, not the
 * normal stopping condition (which is `num_rows_total`, or a short/empty page). `text_style_control`
 * alone is ~11,000 rows / ~110 pages today; 300 pages (30,000 rows) leaves 3x headroom for
 * upstream growth before this cap itself becomes the next version of this bug.
 */
const MAX_PAGES_PER_CONFIG = 300;
/** Gap between consecutive HF requests, so a daily refresh doesn't burst the datasets-server. */
const REQUEST_SPACING_MS = 1_500;
/** Backoff schedule for a 429/5xx (or other transient error), honored unless `Retry-After` says otherwise. */
const RETRY_BACKOFFS_MS = [5_000, 15_000, 45_000];
/**
 * Ceiling on how long a `Retry-After` is allowed to stall one page fetch. Beyond this, we don't
 * wait at all — the page fails fast and the board falls to `failedBoards` for the short-cycle
 * retry poller to pick up later, rather than one huge external value (malformed, or an HF
 * multi-hour hint) blocking the whole refresh and, with it, the daily-refresh-triggered reset of
 * the retry poller's own attempt budget.
 */
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

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
      if (e instanceof RetryableHfError && e.retryAfterMs !== undefined && e.retryAfterMs > MAX_RETRY_AFTER_MS) {
        throw e; // Past the cap: fail this page now rather than block on the server's say-so.
      }
      if (attempt < RETRY_BACKOFFS_MS.length) {
        const retryAfterMs = e instanceof RetryableHfError ? e.retryAfterMs : undefined;
        await sleep(retryAfterMs ?? RETRY_BACKOFFS_MS[attempt]);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Page through one HF config from offset 0, bucketing every row whose
 * `category` is in `wantedCategories`, until the config runs out of rows or
 * the page safety cap is hit. Several of our boards share one config —
 * `text_style_control` alone covers five categories — so reading the config
 * once here instead of once per category (the old per-board loop) cuts the
 * request count sharply: the old code re-paged from offset 0 for every
 * category sharing a config, re-reading every earlier category's block each
 * time.
 *
 * This never tries to detect a category's block "ending" to stop early:
 * an earlier version did, by watching for a transition away from the
 * previous row's category, but that silently dropped a category's later
 * rows if it ever reappeared non-contiguously (interleaved with another
 * wanted category) — the whole config is read once in production anyway
 * since every category each config serves is wanted by some kind of work,
 * so the early-stop bought nothing here but a fragile assumption.
 *
 * On a page fetch throwing (after its own retries are exhausted), returns
 * whatever was collected so far instead of discarding it: a category fully
 * read before the failing page stays usable, which keeps a later-page error
 * from being worse than the old per-board code, where one board's failure
 * never touched another's independently-fetched data.
 */
async function fetchConfigCategoryRows(
  config: string,
  wantedCategories: ReadonlySet<string>,
): Promise<{ rowsByCategory: Map<string, LeaderboardRow[]>; error: unknown | undefined }> {
  const collected = new Map<string, LeaderboardRow[]>();
  let offset = 0;
  let reachedEnd = false;

  for (let page = 0; page < MAX_PAGES_PER_CONFIG; page++) {
    if (page > 0) {
      await sleep(REQUEST_SPACING_MS);
    }
    let rows: HfRowsPage["rows"];
    let num_rows_total: number;
    try {
      const pageResult = await fetchHfPage(config, offset);
      rows = pageResult.rows;
      num_rows_total = pageResult.num_rows_total;
    } catch (e) {
      return { rowsByCategory: collected, error: e };
    }
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const item of rows) {
      const category = item.row.category;
      if (wantedCategories.has(category)) {
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
      reachedEnd = true;
      break;
    }
  }
  if (!reachedEnd) {
    // Ran out of allowed pages before the config ran out of rows -- not the normal stopping
    // condition. Reported as an error (even though no page fetch itself threw) so the category
    // this scan never reached is marked failed below, not recorded as an empty board: the whole
    // bug this safety cap otherwise reintroduces at a higher row count is a board silently read
    // as "fetched fine" with 0 rows just because the scan stopped before reaching it.
    return {
      rowsByCategory: collected,
      error: new Error(
        `${config}: hit the ${MAX_PAGES_PER_CONFIG}-page safety cap before reaching the end (stopped at offset ${offset})`,
      ),
    };
  }
  return { rowsByCategory: collected, error: undefined };
}

/**
 * Fetch and normalize a set of `{config}/{category}` boards, grouping by
 * config so each config is read at most once regardless of how many of its
 * categories are wanted. Spaces requests between configs the same way
 * `fetchConfigCategoryRows` spaces pages within one, so a refresh never
 * bursts the datasets-server.
 *
 * A board whose category has no collected rows AND the config scan hit an
 * error is marked failed; a board with collected rows is normalized and
 * kept even if the same config scan errored on a later page (partial credit
 * — see `fetchConfigCategoryRows`). A board with no collected rows and no
 * error is a legitimately empty board, same as before this fix.
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
    const wantedCategories = new Set(entries.map((e) => e.category));
    const { rowsByCategory, error } = await fetchConfigCategoryRows(config, wantedCategories);
    if (error) {
      console.error(`arena-rankings: failed to fetch config ${config}: ${error instanceof Error ? error.message : error}`);
    }
    for (const { category, boardId } of entries) {
      const categoryRows = rowsByCategory.get(category);
      if (categoryRows === undefined && error) {
        failedBoards.push(boardId);
        continue;
      }
      const { rows, unmatched: boardUnmatched } = normalizeBoardRows(categoryRows ?? []);
      boards[boardId] = rows;
      unmatched[boardId] = boardUnmatched;
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

/**
 * Write the rankings file atomically: write to a temp sibling, then rename over the target. The
 * temp path is unique per call (not just per-process) — the daily refresh and the failed-board
 * retry both call this from the same process, and a shared `pid`-only name let their writes
 * collide on the same temp file if they ever overlapped.
 */
async function writeRankingsFile(paseoHome: string, file: ArenaRankingsFile): Promise<void> {
  const targetPath = rankingsFilePath(paseoHome);
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
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
 *
 * Re-reads the file immediately before writing and merges onto *that* copy,
 * not the one read at the start: a daily refresh can commit while the retry
 * fetch (which can take a while — up to `MAX_PAGES_PER_CONFIG` pages, each
 * with its own retries) is in flight. If the file moved (`fetchedAt`
 * changed) since this retry started, the daily write already supersedes
 * whatever this retry would merge, so the retry's result is dropped rather
 * than clobbering it — a plain read-then-write has no way to detect that.
 * `startArenaRankingsPoller` additionally serializes the daily and retry
 * runs so in the normal case this branch is unreachable; it only matters for
 * a caller that invokes this directly, as the retry poller's exposed
 * `retryOnce` does for tests.
 */
export async function retryFailedBoards(
  paseoHome: string,
): Promise<
  | { status: "no-failed-boards" }
  | { status: "merged"; recovered: string[]; stillFailed: string[] }
  | { status: "no-recovery"; stillFailed: string[] }
  | { status: "superseded"; stillFailed: string[] }
> {
  const file = await readRankingsFile(paseoHome);
  if (!file || file.failedBoards.length === 0) {
    return { status: "no-failed-boards" };
  }
  const retryStartedFromFetchedAt = file.fetchedAt;

  const { boards, unmatched, failedBoards: stillFailed } = await fetchBoardsGroupedByConfig(file.failedBoards);
  const recovered = file.failedBoards.filter((id) => !stillFailed.includes(id));
  if (recovered.length === 0) {
    console.error(`arena-rankings: retry found ${stillFailed.length} board(s) still failing: ${stillFailed.join(", ")}`);
    return { status: "no-recovery", stillFailed };
  }

  const latest = await readRankingsFile(paseoHome);
  if (!latest || latest.fetchedAt !== retryStartedFromFetchedAt) {
    console.error(`arena-rankings: retry recovered ${recovered.length} board(s) but the file moved underneath it; dropping the merge`);
    return { status: "superseded", stillFailed };
  }

  const merged: ArenaRankingsFile = {
    ...latest,
    boards: { ...latest.boards, ...boards },
    unmatched: { ...latest.unmatched, ...unmatched },
    failedBoards: stillFailed,
  };
  await writeRankingsFile(paseoHome, merged);
  return { status: "merged", recovered, stillFailed };
}

/**
 * Serializes calls through a shared tail promise: each call waits for the
 * previous one to settle (success or failure) before it starts. Used so the
 * daily refresh and the failed-board retry — two independent
 * `createIntervalPoller`s against the same file — never run at once, which
 * is what makes `retryFailedBoards`'s own re-check-before-write (the
 * `"superseded"` path) unreachable in practice rather than just handled.
 */
function createRunLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** Everything `retryFailedBoards` can report, plus `"capped"` for when the attempt budget is spent. */
type FailedBoardRetryResult = Awaited<ReturnType<typeof retryFailedBoards>> | { status: "capped" };

/**
 * Owns the retry poller's attempt budget (`MAX_FAILED_BOARD_RETRY_ATTEMPTS`)
 * so it's a plain, directly testable unit instead of logic buried in an
 * interval callback's closure — `startArenaRankingsPoller` wires this into
 * the retry interval and also exposes it as `retryOnce` for tests to drive
 * the cap and the reset behavior without waiting on real timers.
 */
function createFailedBoardRetryer(paseoHome: string): { runOnce: () => Promise<FailedBoardRetryResult>; reset: () => void } {
  let attempts = 0;
  return {
    async runOnce(): Promise<FailedBoardRetryResult> {
      if (attempts >= MAX_FAILED_BOARD_RETRY_ATTEMPTS) {
        return { status: "capped" };
      }
      const result = await retryFailedBoards(paseoHome);
      if (result.status === "no-failed-boards") {
        attempts = 0;
        return result;
      }
      attempts++;
      if (result.status === "merged") {
        console.log(`arena-rankings: recovered ${result.recovered.length} previously-failed board(s): ${result.recovered.join(", ")}`);
      }
      return result;
    },
    reset(): void {
      attempts = 0;
    },
  };
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
 * baseline of failures) or a retry finds nothing left to retry. The two
 * pollers run through a shared lock (`createRunLock`) so they never touch
 * the file at the same time.
 */
export function startArenaRankingsPoller(
  paseoHome: string,
  options: {
    intervalMs?: number;
    retryIntervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  } = {},
): IntervalPoller<void> & { retryOnce: () => Promise<FailedBoardRetryResult> } {
  const withLock = createRunLock();
  const retryer = createFailedBoardRetryer(paseoHome);

  const dailyPoller = createIntervalPoller<void>({
    intervalMs: options.intervalMs ?? REFRESH_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: () =>
      withLock(async () => {
        const result = await refreshArenaRankings(paseoHome);
        retryer.reset();
        if (result.status === "failed") {
          console.error(`arena-rankings: daily refresh failed, keeping the previous file: ${result.error}`);
        } else {
          const unmatchedTotal = Object.values(result.unmatched).reduce((sum, n) => sum + n, 0);
          console.log(`arena-rankings: refreshed ${result.boardCount} board(s), ${unmatchedTotal} unmatched row(s) across them`);
        }
      }),
  });

  const retryPoller = createIntervalPoller<void>({
    intervalMs: options.retryIntervalMs ?? FAILED_BOARD_RETRY_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: () => withLock(() => retryer.runOnce()).then(() => undefined),
  });

  void dailyPoller.runOnce();

  return {
    runOnce: () => dailyPoller.runOnce(),
    retryOnce: () => withLock(() => retryer.runOnce()),
    stop: () => {
      dailyPoller.stop();
      retryPoller.stop();
    },
  };
}
