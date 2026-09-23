import type { PluginHookContext } from "@getpaseo/plugin/server";
import { createIntervalPoller } from "./interval-poller";

/** The subset of PaseoApi this module needs: listing a provider's models. */
export type ProvidersModelsApi = Pick<PluginHookContext["paseo"], "providers">;

export type ModelCatalog = ReadonlyMap<string, ReadonlySet<string>>;

export interface ModelCatalogCacheOptions {
  /** Refresh interval in milliseconds. Defaults to 60_000, matching the pool cache. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Injectable for tests; defaults to the global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
}

export interface ModelCatalogCache {
  /** Returns the most recently loaded catalog. Never triggers a load itself. */
  get(): ModelCatalog;
  /** Loads immediately, updates the cache, and returns the new catalog. */
  forceRefresh(): Promise<ModelCatalog>;
  /** Stops the refresh interval. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const EMPTY_CATALOG: ModelCatalog = new Map();

/**
 * A cached `Map<family, Set<modelId>>` over `providers.listModels`,
 * refreshed on a fixed interval. `getFamilies` is read fresh on every poll
 * rather than frozen at construction, so a role added to the live policy
 * picks up its family's catalog on the next tick without a plugin reload.
 * A transient failure for one family keeps that family's last-known set
 * rather than dropping it — matches createProviderIdCache's fail-soft shape.
 */
export function createModelCatalogCache(
  paseo: ProvidersModelsApi,
  getFamilies: () => readonly string[],
  options: ModelCatalogCacheOptions = {},
): ModelCatalogCache {
  let current: ModelCatalog = EMPTY_CATALOG;

  const poller = createIntervalPoller({
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const families = getFamilies();
      const next = new Map<string, ReadonlySet<string>>();
      for (const family of families) {
        try {
          // TYPE NOTE: family ids come from free-form daemon config (role
          // policy model refs), not necessarily one of the SDK's known
          // AgentProvider literals. Read/call structurally rather than
          // narrowing to that union.
          const result = await paseo.providers.listModels(
            family as Parameters<typeof paseo.providers.listModels>[0],
          );
          next.set(family, new Set((result.models ?? []).map((model) => model.id)));
        } catch (error) {
          console.error(
            `[claude-account-pool] model-catalog: failed to refresh models for provider "${family}"`,
            error,
          );
          const previous = current.get(family);
          if (previous) {
            next.set(family, previous);
          }
        }
      }
      current = next;
      return current;
    },
  });

  return {
    get: () => current,
    forceRefresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
