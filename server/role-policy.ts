import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  DEFAULT_POLICY,
  RoleModelPolicySchema,
  migrateRoleModelPolicy,
  type RoleModelPolicy,
} from "../shared/role-policy-schema";
import { createIntervalPoller } from "./interval-poller";
import { poolLeaderProviderIdFromConfig, type DaemonConfig } from "./pool";

/** The subset of PaseoApi this module needs: reading daemon config. */
export type PaseoConfigApi = PluginHandlerContext["paseo"];

export interface PolicyLoadResult {
  policy: RoleModelPolicy;
  /** True when the stored config existed but failed schema validation (or the read itself failed). */
  malformed: boolean;
  error?: string;
}

/**
 * Reads the top-level `agentModelPolicy` daemon-config key. Missing key ->
 * DEFAULT_POLICY (all roles unconfigured = behaviorally no policy, not a
 * failure). Present-but-malformed, or the config RPC itself rejecting ->
 * fail closed: keep serving `previous` (the last good in-memory policy) so
 * routing stays a pass-through and the hook never crashes or wipes state.
 *
 * An older stored document is migrated in memory on every read and never
 * written back here; only an intentional save through the settings RPC
 * persists the current schema version.
 */
export async function loadRolePolicy(
  paseo: PaseoConfigApi,
  previous: RoleModelPolicy = DEFAULT_POLICY,
): Promise<PolicyLoadResult> {
  try {
    const { config } = await paseo.config.get();
    const raw = (config as Record<string, unknown>).agentModelPolicy;
    if (raw === undefined) {
      return { policy: DEFAULT_POLICY, malformed: false };
    }

    const migrated = migrateRoleModelPolicy(raw, {
      poolLeaderProviderId: poolLeaderProviderIdFromConfig(config as DaemonConfig),
    });
    const parsed = RoleModelPolicySchema.safeParse(migrated);
    if (!parsed.success) {
      return { policy: previous, malformed: true, error: parsed.error.message };
    }
    return { policy: parsed.data, malformed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { policy: previous, malformed: true, error: message };
  }
}

export interface PolicyCacheOptions {
  /** Refresh interval in milliseconds. Defaults to 60_000, matching the pool cache. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Injectable for tests; defaults to the global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
}

export interface PolicyCache {
  /** Returns the most recently loaded policy. Never triggers a load itself. */
  get(): RoleModelPolicy;
  /** True when the last load attempt found a malformed key and is serving stale/default state. */
  isMalformed(): boolean;
  lastError(): string | undefined;
  /** Loads immediately, updates the cache, and returns the new policy. */
  forceRefresh(): Promise<RoleModelPolicy>;
  /** Stops the refresh interval. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * A cached accessor over loadRolePolicy() that refreshes on a fixed
 * interval, mirroring server/pool.ts. Starts at DEFAULT_POLICY and stays
 * there until the first load (interval tick or forceRefresh) resolves.
 */
export function createPolicyCache(paseo: PaseoConfigApi, options: PolicyCacheOptions = {}): PolicyCache {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  let current: RoleModelPolicy = DEFAULT_POLICY;
  let malformed = false;
  let error: string | undefined;

  const poller = createIntervalPoller({
    intervalMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const result = await loadRolePolicy(paseo, current);
      current = result.policy;
      malformed = result.malformed;
      error = result.error;
      return result;
    },
  });

  return {
    get: () => current,
    isMalformed: () => malformed,
    lastError: () => error,
    forceRefresh: async () => {
      await poller.runOnce();
      return current;
    },
    stop: () => poller.stop(),
  };
}
