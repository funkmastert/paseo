import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { HealthTracker } from "./health";
import type { PoolCache } from "./pool";

/** The subset of PaseoApi this module needs: reading the provider snapshot. */
export type ProviderSnapshotApi = Pick<PluginHookContext["paseo"], "providers">;

export interface ProviderIdCacheOptions {
  /** Refresh interval in milliseconds. Defaults to 60_000, matching the pool cache. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Injectable for tests; defaults to the global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
}

export interface ProviderIdCache {
  /** Null until the first snapshot load resolves. */
  get(): ReadonlySet<string> | null;
  /** Loads immediately, updates the cache, and returns the new ids (or the last-known ids on failure). */
  forceRefresh(): Promise<ReadonlySet<string> | null>;
  /** Stops the refresh interval. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_PROVIDER_ID_INTERVAL_MS = 60_000;

/**
 * A cached set of registered provider ids, refreshed on a fixed interval
 * alongside the pool cache. The router validates every rewrite target
 * against this cache so it never rewrites `config.provider` to an id the
 * provider registry doesn't actually know about.
 */
export function createProviderIdCache(
  paseo: ProviderSnapshotApi,
  options: ProviderIdCacheOptions = {},
): ProviderIdCache {
  const intervalMs = options.intervalMs ?? DEFAULT_PROVIDER_ID_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let current: ReadonlySet<string> | null = null;
  let pending: Promise<ReadonlySet<string> | null> | null = null;

  async function load(): Promise<ReadonlySet<string> | null> {
    try {
      const snapshot = await paseo.providers.snapshot();
      current = new Set(snapshot.entries.map((entry) => entry.provider));
    } catch (error) {
      console.error("[claude-account-pool] router: failed to refresh provider snapshot", error);
    }
    return current;
  }

  function refresh(): Promise<ReadonlySet<string> | null> {
    if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  const timer = setIntervalFn(() => {
    void refresh();
  }, intervalMs);

  return {
    get: () => current,
    forceRefresh: refresh,
    stop: () => clearIntervalFn(timer),
  };
}

export interface PoolDryEpisode {
  callerAgentId: string;
  requestedModel: string;
  leaderProviderId: string;
}

export interface FailOpenEpisode {
  callerAgentId: string;
  reason: string;
  targetProviderId?: string;
}

export interface RouterOptions {
  poolCache: PoolCache;
  health: Pick<HealthTracker, "isHealthyFor">;
  providerIds: ProviderIdCache;
  /** Called when routing fell back to the leader because every worker was unhealthy. */
  onPoolDry?: (episode: PoolDryEpisode) => void;
  /** Called whenever routing fails open (never throws or blocks creation). */
  onFailOpen?: (episode: FailOpenEpisode) => void;
  /** Called when the pool cache transitions from fail-open back to a loaded pool. */
  onPoolRecovered?: () => void;
}

export type AgentCreateRouter = (
  input: { request: PluginBeforeRequests["agent.create"] },
  context: PluginHookContext,
) => PluginBeforeRequests["agent.create"] | void;

/**
 * `before("agent.create")` handler: rewrites `config.provider` for
 * agent-spawned children to a healthy pool worker, falling back to the
 * pool's leader as a last resort. Human-created requests (no callerAgentId)
 * and every failure mode are passthrough — this must never block agent
 * creation.
 */
export function createRouter(options: RouterOptions): AgentCreateRouter {
  let wasFailOpen = false;

  return function routeAgentCreate(input) {
    const { request } = input;

    const { pool, failOpen: poolFailOpen } = options.poolCache.get();
    if (poolFailOpen) {
      wasFailOpen = true;
    } else if (wasFailOpen) {
      wasFailOpen = false;
      options.onPoolRecovered?.();
    }

    // TYPE NOTE: the daemon supplies callerAgentId on agent.create requests at
    // runtime (managed CLI/agent-spawned creates); the installed
    // @getpaseo/plugin types don't declare it on PluginBeforeRequests["agent.create"]
    // yet. Read it structurally rather than forking the SDK types.
    const callerAgentId = (request as { callerAgentId?: string }).callerAgentId;
    if (!callerAgentId) {
      return; // Human-created leaders, and schedule/heartbeat creates: untouched.
    }

    if (poolFailOpen) {
      options.onFailOpen?.({ callerAgentId, reason: "pool-unconfigured" });
      return;
    }

    const modelId = request.config.model ?? "";
    const worker = pool.workers.find((candidate) => options.health.isHealthyFor(candidate.providerId, modelId));

    let targetProviderId: string;
    let poolDry: PoolDryEpisode | undefined;
    if (worker) {
      targetProviderId = worker.providerId;
    } else if (pool.leader) {
      targetProviderId = pool.leader.providerId;
      poolDry = { callerAgentId, requestedModel: modelId, leaderProviderId: targetProviderId };
    } else {
      options.onFailOpen?.({ callerAgentId, reason: "no-healthy-worker-and-no-leader" });
      return;
    }

    const providerIds = options.providerIds.get();
    if (providerIds === null || !providerIds.has(targetProviderId)) {
      console.error(
        `[claude-account-pool] router: target provider "${targetProviderId}" is not in the provider snapshot; passing the request through untouched`,
      );
      options.onFailOpen?.({
        callerAgentId,
        reason: "target-missing-from-provider-snapshot",
        targetProviderId,
      });
      return;
    }

    if (poolDry) {
      options.onPoolDry?.(poolDry);
    }

    return {
      ...request,
      config: { ...request.config, provider: targetProviderId },
    };
  };
}
