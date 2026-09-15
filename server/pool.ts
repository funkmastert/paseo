import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  EMPTY_POOL,
  PoolConfigError,
  ProviderAccountPoolParamsSchema,
  resolvePool,
  type PoolProviderEntry,
  type ResolvedPool,
} from "../shared/pool-config";
import { createIntervalPoller } from "./interval-poller";
import { createLogThrottle } from "./log-throttle";

/** The subset of PaseoApi this module needs: reading daemon config. */
export type PaseoConfigApi = PluginHandlerContext["paseo"];

export interface PoolLoadResult {
  pool: ResolvedPool;
  /** True when the pool could not be resolved and callers should fail open. */
  failOpen: boolean;
  /** Present when failOpen is true and the cause was an error rather than absent config. */
  error?: string;
}

const FAIL_OPEN_RESULT: PoolLoadResult = { pool: EMPTY_POOL, failOpen: true };

/**
 * Reads daemon config, extracts provider entries carrying
 * `params.accountPool`, and resolves them into an ordered pool. Never
 * throws: malformed or missing pool config yields an empty pool with
 * failOpen set, so callers can proceed without routing.
 */
export async function loadPool(paseo: PaseoConfigApi): Promise<PoolLoadResult> {
  try {
    const { config } = await paseo.config.get();
    const providers = (config.providers ?? {}) as Record<string, Record<string, unknown>>;

    const entries: PoolProviderEntry[] = [];
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      const params = providerConfig?.params;
      if (params === undefined || params === null || typeof params !== "object") {
        continue;
      }
      if (!("accountPool" in params)) {
        continue;
      }

      const parsed = ProviderAccountPoolParamsSchema.safeParse(params);
      if (!parsed.success) {
        return { pool: EMPTY_POOL, failOpen: true, error: parsed.error.message };
      }
      entries.push({ providerId, accountPool: parsed.data.accountPool });
    }

    if (entries.length === 0) {
      return FAIL_OPEN_RESULT;
    }

    const pool = resolvePool(entries);
    return { pool, failOpen: false };
  } catch (error) {
    const message =
      error instanceof PoolConfigError || error instanceof Error ? error.message : String(error);
    return { pool: EMPTY_POOL, failOpen: true, error: message };
  }
}

export interface PoolCacheOptions {
  /** Refresh interval in milliseconds. Defaults to 60_000. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Injectable for tests; defaults to the global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
  /**
   * Minimum ms between two "FAIL-OPEN" daemon-error logs (see below).
   * Default 5 minutes: loud enough to be caught quickly and to prove an
   * outage is ongoing, without matching the 60s poll cadence closely enough
   * to read as routine noise.
   */
  failOpenLogThrottleMs?: number;
  /** Injectable clock for tests; defaults to Date.now. Drives the log throttle above. */
  now?: () => number;
}

export interface PoolCache {
  /** Returns the most recently loaded result. Never triggers a load itself. */
  get(): PoolLoadResult;
  /** Loads immediately, updates the cache, and returns the new result. */
  forceRefresh(): Promise<PoolLoadResult>;
  /** Stops the refresh interval. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * A cached accessor over loadPool() that refreshes on a fixed interval.
 * The cache starts fail-open/empty and stays that way until the first
 * load (interval tick or forceRefresh) resolves.
 */
export function createPoolCache(paseo: PaseoConfigApi, options: PoolCacheOptions = {}): PoolCache {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const failOpenLogThrottleMs = options.failOpenLogThrottleMs ?? 5 * 60_000;
  const logThrottle = createLogThrottle({ windowMs: failOpenLogThrottleMs, now: options.now });

  let current: PoolLoadResult = FAIL_OPEN_RESULT;

  const poller = createIntervalPoller({
    intervalMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const result = await loadPool(paseo);
      // `error` is only set when loadPool() caught a real failure (e.g. a
      // dead daemon transport) rather than the benign case of no pool
      // configured at all (FAIL_OPEN_RESULT / entries.length === 0, neither
      // of which set it). That distinction is exactly what makes this
      // greppable as the incident signal rather than routine "pool not set
      // up on this install" fail-open: a dead daemon connection makes
      // config.get() throw on every tick, so this would otherwise repeat
      // silently for as long as the connection stays down — 20 hours, in
      // the incident that motivated this log.
      if (result.failOpen && result.error) {
        logThrottle("pool-fail-open-daemon-error", () => {
          console.error(
            `[claude-account-pool] pool: FAIL-OPEN — could not read daemon config (${result.error}). Account-pool routing is disabled and every agent.create is passing through unrouted until this clears.`,
          );
        });
      }
      current = result;
      return result;
    },
  });

  return {
    get: () => current,
    forceRefresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
