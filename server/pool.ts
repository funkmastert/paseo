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

  let current: PoolLoadResult = FAIL_OPEN_RESULT;

  const poller = createIntervalPoller({
    intervalMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const result = await loadPool(paseo);
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
