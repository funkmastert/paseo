import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import type { AccountIdentity } from "./account-identity";
import type { HealthTracker } from "./health";
import { rankByHeadroom } from "./headroom";
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
  /** Injectable clock for tests; defaults to Date.now. Drives the refresh-failure log throttle. */
  now?: () => number;
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
  const logThrottle = createLogThrottle({ now: options.now });

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
        // Throttled (not per-tick): a dead daemon connection makes this
        // throw every interval tick indefinitely (see the pool cache's own
        // FAIL-OPEN log in pool.ts, which shares this root cause), and an
        // unthrottled log here is exactly the noise that let a 20-hour
        // outage go unnoticed rather than the loud signal it needs to be.
        logThrottle("provider-snapshot-refresh-failed", () => {
          console.error(
            "[claude-account-pool] router: FAIL-OPEN RISK — failed to refresh provider snapshot; pool routing may be using a stale/missing snapshot until this clears",
            error,
          );
        });
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

/**
 * The pool has come down to one account, and it is now serving both leaders and their children.
 *
 * Worth saying out loud exactly once, because it is the moment the thing the pool exists for
 * stops being true: from here a single cap takes down every agent at once, and the only fixes
 * are ones a person has to make (sign another account in, raise a limit, or stop).
 */
export interface PoolCollapsedEpisode {
  callerAgentId: string;
  requestedModel: string;
  /** The one account still usable, and the entry this spawn was placed on. */
  targetProviderId: string;
  /** Every pool entry that resolves to that same account — more than one means duplicate logins. */
  sharedProviderIds: string[];
  /** Pool entries that are out, with the reset each is waiting on when one is known. */
  exhaustedProviderIds: string[];
}

/** Nothing in the pool can run anything. No target exists, so no spawn can succeed. */
export interface PoolExhaustedEpisode {
  callerAgentId: string;
  requestedModel: string;
  exhaustedProviderIds: string[];
  /** Earliest known reset across the pool, or null when nothing reported one. */
  earliestResetAt: Date | null;
}

/**
 * Thrown out of the create hook when every pooled account is capped.
 *
 * The alternative is to pass the request through, which places the child on a dead account
 * where it fails on its first turn — and a leader that reads that failure as "that one didn't
 * work, try another" spawns the next one straight into the same wall. Refusing costs one clear
 * error instead of an unbounded loop, and the text names the reset so the caller knows whether
 * to wait or to stop. Human-created agents never reach this code (the router only acts on
 * creates that carry a callerAgentId), so this can never lock Tyler out of his own daemon.
 */
export class PoolExhaustedError extends Error {}

export interface FailOpenEpisode {
  callerAgentId: string;
  reason: string;
  targetProviderId?: string;
}

export interface RouterOptions {
  poolCache: PoolCache;
  health: Pick<
    HealthTracker,
    | "isHealthyFor"
    | "isLastResortEligible"
    | "isHealthyForAllWindows"
    | "describeWindow"
    | "windowIds"
  >;
  providerIds: ProviderIdCache;
  /**
   * Same-account grouping, so two entries on one login count as one account when deciding
   * whether the pool has collapsed. Optional: without it every entry counts as its own account,
   * which is what the pool assumed before.
   */
  accountIdentity?: Pick<AccountIdentity, "accountKey" | "countAccounts" | "siblings">;
  /**
   * Refuse the create when no pooled account can run it, rather than passing it through onto a
   * capped one. Defaults to true; see PoolExhaustedError for why.
   */
  refuseWhenExhausted?: boolean;
  /** Called when routing fell back to the leader because every worker was unhealthy. */
  onPoolDry?: (episode: PoolDryEpisode) => void;
  /** Called (once per episode, per leader, downstream) when one account is serving the whole pool. */
  onPoolCollapsed?: (episode: PoolCollapsedEpisode) => void;
  /** Called when nothing in the pool is usable. */
  onPoolExhausted?: (episode: PoolExhaustedEpisode) => void;
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

type LadderHealth = RouterOptions["health"];

/** Every pool entry id, workers then leader, in a stable order. */
function poolMemberIds(pool: { workers: readonly { providerId: string }[]; leader: { providerId: string } | null }): string[] {
  const ids = pool.workers.map((worker) => worker.providerId);
  if (pool.leader) {
    ids.push(pool.leader.providerId);
  }
  return ids;
}

/**
 * The soonest any of these accounts gets budget back, across every capped window. Null when
 * nothing reported a reset time — an account can be capped with no known
 * reset (a monthly spend cap never appears in the utilization windows at all), and saying
 * nothing is better than inventing a time.
 */
function earliestReset(health: LadderHealth, providerIds: readonly string[]): Date | null {
  let earliest: Date | null = null;
  for (const providerId of providerIds) {
    for (const window of health.windowIds(providerId)) {
      const state = health.describeWindow(providerId, window);
      if (state?.status !== "capped" || !state.resetsAt) continue;
      if (earliest === null || state.resetsAt.getTime() < earliest.getTime()) {
        earliest = state.resetsAt;
      }
    }
  }
  return earliest;
}

/** The refusal text an agent sees. Names the accounts and the wait, so the caller can decide. */
function describeExhaustedPool(health: LadderHealth, providerIds: readonly string[]): string {
  const reset = earliestReset(health, providerIds);
  const when = reset ? `The earliest window reset is ${reset.toISOString()}.` : "No account reported a reset time.";
  return (
    `Account pool: every Claude account is out of budget (${providerIds.join(", ")}), so this agent was not created. ` +
    `${when} Do not retry this spawn on another provider — they share the same exhausted pool. ` +
    `Stop delegating and tell the user, who can sign another account in or raise a limit.`
  );
}

export type AgentCreateRouter = (
  input: { request: PluginBeforeRequests["agent.create"] },
  context: PluginHookContext,
) => PluginBeforeRequests["agent.create"] | void;

/**
 * `before("agent.create")` handler: rewrites `config.provider` for agent-spawned claude-family
 * children onto the pooled account with the most usable headroom, preferring a worker.
 *
 * Isolation is a preference, not a rule. Keeping children off the leader's account is the whole
 * point of the pool and stays the normal case, but when no worker can run the request the leader
 * account serves everything rather than nothing running at all. Only a pool where *nothing* is
 * usable stops a spawn.
 *
 * Human-created requests (no callerAgentId), non-claude-family requests, and every failure mode
 * other than a fully exhausted pool are passthrough.
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

    // Selection ladder. Tiers rank isolation and health; headroom ranks within a tier, so the
    // account with the most room left absorbs the next spawn instead of whichever one the
    // operator happened to number first:
    //   1. a worker healthy for the requested model — or, when no model was requested, healthy
    //      on every window we've observed (a model-scoped cap can't be matched against an
    //      unknown model, so it must disqualify);
    //   2. a worker that is drained but not capped — still isolation, still no pool-dry episode;
    //   3. the leader, if it can run anything. Isolation is gone at this point, so this raises a
    //      pool-dry episode, and a collapse episode when the pool is down to one account;
    //   4. nothing. The pool is exhausted and the create is refused.
    //
    // 1 is kept above 2 rather than merged into one headroom ranking: a drained worker has less
    // room than a healthy one by definition, and letting a score put a nearly-capped account
    // ahead of a healthy one would trade the pool's purpose for a rounding difference.
    const modelId = request.config.model ?? "";
    const nowMs = now();
    const isHealthy = (providerId: string): boolean =>
      modelId
        ? options.health.isHealthyFor(providerId, modelId)
        : options.health.isHealthyForAllWindows(providerId);
    const rank = <T extends { providerId: string; priority: number }>(candidates: readonly T[]): T[] =>
      rankByHeadroom(candidates, options.health, modelId, nowMs);

    const healthyWorkers = rank(pool.workers.filter((worker) => isHealthy(worker.providerId)));
    const drainedWorkers = rank(
      pool.workers.filter(
        (worker) =>
          !isHealthy(worker.providerId) && options.health.isLastResortEligible(worker.providerId),
      ),
    );
    const worker = healthyWorkers[0] ?? drainedWorkers[0];
    // The leader carries no configured priority; it is a tier of one, so any number does.
    const leaderUsable =
      pool.leader !== null &&
      (isHealthy(pool.leader.providerId) || options.health.isLastResortEligible(pool.leader.providerId));

    let targetProviderId: string;
    let poolDry: PoolDryEpisode | undefined;
    if (worker) {
      targetProviderId = worker.providerId;
    } else if (pool.leader && leaderUsable) {
      targetProviderId = pool.leader.providerId;
      poolDry = { callerAgentId, requestedModel: modelId, leaderProviderId: targetProviderId };
    } else if (!pool.leader) {
      // A pool with no leader entry and no usable worker isn't exhausted so much as unfinished:
      // there is no configured last resort to fall to. Fail open as before rather than refuse.
      options.onFailOpen?.({ callerAgentId, reason: "no-healthy-worker-and-no-leader" });
      return;
    } else {
      const poolProviderIds = poolMemberIds(pool);
      options.onPoolExhausted?.({
        callerAgentId,
        requestedModel: modelId,
        exhaustedProviderIds: poolProviderIds,
        earliestResetAt: earliestReset(options.health, poolProviderIds),
      });
      if (options.refuseWhenExhausted ?? true) {
        throw new PoolExhaustedError(describeExhaustedPool(options.health, poolProviderIds));
      }
      options.onFailOpen?.({ callerAgentId, reason: "every-pool-account-capped" });
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

    // Counted over accounts, not entries: two provider entries signed into one login report the
    // same windows and share one budget, so treating them as two survivors is exactly how a
    // collapse stays quiet. Reported wherever the target landed, leader or worker — a leader
    // account that died and left one worker holding everything is the same loss of isolation as
    // the other way round.
    const usable = poolMemberIds(pool).filter(
      (providerId) => isHealthy(providerId) || options.health.isLastResortEligible(providerId),
    );
    const identity = options.accountIdentity;
    const usableAccounts = identity ? identity.countAccounts(usable) : new Set(usable).size;
    if (usableAccounts === 1) {
      options.onPoolCollapsed?.({
        callerAgentId,
        requestedModel: modelId,
        targetProviderId,
        sharedProviderIds: identity ? identity.siblings(targetProviderId).filter((id) => usable.includes(id)) : [targetProviderId],
        exhaustedProviderIds: poolMemberIds(pool).filter((providerId) => !usable.includes(providerId)),
      });
    }

    return {
      ...request,
      config: { ...request.config, provider: targetProviderId },
    };
  };
}
