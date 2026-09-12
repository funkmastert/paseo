import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { HealthTracker } from "./health";
import { createIntervalPoller } from "./interval-poller";
import { createLogThrottle } from "./log-throttle";
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

  let current: ReadonlySet<string> | null = null;

  const poller = createIntervalPoller({
    intervalMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      try {
        const snapshot = await paseo.providers.snapshot();
        current = new Set(snapshot.entries.map((entry) => entry.provider));
      } catch (error) {
        console.error("[claude-account-pool] router: failed to refresh provider snapshot", error);
      }
      return current;
    },
  });

  return {
    get: () => current,
    forceRefresh: () => poller.runOnce(),
    stop: () => poller.stop(),
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
  health: Pick<HealthTracker, "isHealthyFor" | "isLastResortEligible" | "isHealthyForAllWindows">;
  providerIds: ProviderIdCache;
  /** Called when routing fell back to the leader because every worker was unhealthy. */
  onPoolDry?: (episode: PoolDryEpisode) => void;
  /** Called whenever routing fails open (never throws or blocks creation). */
  onFailOpen?: (episode: FailOpenEpisode) => void;
  /** Called when the pool cache transitions from fail-open back to a loaded pool. */
  onPoolRecovered?: () => void;
  /**
   * Minimum ms between forceRefresh() calls triggered by observing a
   * fail-open pool on a create. Defaults to 5000. Keeps recovery from a
   * transient config-read failure driven by traffic, not only the 60s
   * cache timer, without hammering the daemon on a busy fail-open pool.
   */
  failOpenRefreshThrottleMs?: number;
  /**
   * Injectable clock for tests; defaults to Date.now. Also drives the
   * per-target-provider throttle on the "missing from provider snapshot"
   * fail-open log, so a burst of creates against the same dead target logs
   * once per minute instead of once per request.
   */
  now?: () => number;
}

export type AgentCreateRouter = (
  input: { request: PluginBeforeRequests["agent.create"] },
  context: PluginHookContext,
) => PluginBeforeRequests["agent.create"] | void;

/**
 * `before("agent.create")` handler: rewrites `config.provider` for
 * agent-spawned claude-family children to a healthy pool worker, then to a
 * drained-but-not-capped worker, then to the pool's leader as a last
 * resort. Human-created requests (no callerAgentId), non-claude-family
 * requests, and every failure mode are passthrough — this must never block
 * agent creation.
 */
export function createRouter(options: RouterOptions): AgentCreateRouter {
  let wasFailOpen = false;
  let lastFailOpenRefreshAt = -Infinity;
  const throttleMs = options.failOpenRefreshThrottleMs ?? 5000;
  const now = options.now ?? Date.now;
  const logThrottle = createLogThrottle({ now });

  return function routeAgentCreate(input) {
    const { request } = input;

    const { pool, failOpen: poolFailOpen } = options.poolCache.get();
    if (poolFailOpen) {
      wasFailOpen = true;
      const nowMs = now();
      if (nowMs - lastFailOpenRefreshAt >= throttleMs) {
        lastFailOpenRefreshAt = nowMs;
        void options.poolCache.forceRefresh();
        void options.providerIds.forceRefresh();
      }
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

    // Only claude-family requests are pool members. A codex/gpt/etc. child
    // spawned by an agent must pass through untouched — no rewrite, and no
    // fail-open event, since the pool was never in play for it.
    const requestedProvider = request.config.provider;
    const isClaudeFamily =
      requestedProvider === "claude" ||
      pool.workers.some((worker) => worker.providerId === requestedProvider) ||
      pool.leader?.providerId === requestedProvider;
    if (!isClaudeFamily) {
      return;
    }

    if (poolFailOpen) {
      options.onFailOpen?.({ callerAgentId, reason: "pool-unconfigured" });
      return;
    }

    // Selection ladder (workers are priority-sorted, so `find` yields the top
    // eligible one):
    //   1. healthy for the requested model — or, when no model was requested,
    //      healthy on every window we've observed (a model-scoped cap can't be
    //      matched against an unknown model, so it must disqualify);
    //   2. last-resort eligible (drained but not capped) — no pool-dry episode;
    //   3. the leader, with a pool-dry episode.
    const modelId = request.config.model ?? "";
    const worker =
      pool.workers.find((candidate) =>
        modelId
          ? options.health.isHealthyFor(candidate.providerId, modelId)
          : options.health.isHealthyForAllWindows(candidate.providerId),
      ) ?? pool.workers.find((candidate) => options.health.isLastResortEligible(candidate.providerId));

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
      logThrottle(`target-missing:${targetProviderId}`, () => {
        console.error(
          `[claude-account-pool] router: target provider "${targetProviderId}" is not in the provider snapshot; passing the request through untouched`,
        );
      });
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
