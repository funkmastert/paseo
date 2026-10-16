/**
 * The plugin cache that feeds `ClassifierWorld.arenaRanking`, beside
 * `catalogCache`/`poolCache` (U8). U6's daily job writes
 * `$PASEO_HOME/arena-rankings.json`; this cache re-reads it on an interval so
 * an in-memory snapshot stays available to every create without a disk read
 * on the hot path, and re-evaluates staleness (`arena.maxAgeHours`) as that
 * policy value changes, not just once at startup.
 */

import type { ArenaRankingsFile } from "../shared/arena-aliases";
import { loadArenaRankings } from "./arena-rankings";
import { createIntervalPoller, type IntervalPoller } from "./interval-poller";

/** Cheap: a local JSON read, far below the daily write cadence. */
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_AGE_HOURS = 72;

export interface ArenaRankingCache {
  /** Undefined means "today's order" (R8): missing file, stale file, or no successful read yet. */
  get(): ArenaRankingsFile | undefined;
  refresh(): Promise<ArenaRankingsFile | undefined>;
  stop(): void;
}

export function createArenaRankingCache(
  paseoHome: string,
  options: {
    /** Read fresh on every poll, so an operator's `arena.maxAgeHours` edit takes effect without a restart. */
    getMaxAgeHours?: () => number;
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  } = {},
): ArenaRankingCache {
  let current: ArenaRankingsFile | undefined;
  const poller: IntervalPoller<ArenaRankingsFile | undefined> = createIntervalPoller({
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      try {
        current = (await loadArenaRankings(paseoHome, options.getMaxAgeHours?.() ?? DEFAULT_MAX_AGE_HOURS)) ?? undefined;
      } catch {
        current = undefined;
      }
      return current;
    },
  });
  return {
    get: () => current,
    refresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
