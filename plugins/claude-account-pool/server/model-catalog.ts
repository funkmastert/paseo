import type { PluginHookContext } from "@getpaseo/plugin/server";
import { createIntervalPoller } from "./interval-poller";

/** The subset of PaseoApi this module needs: listing a provider's models. */
export type ProvidersModelsApi = Pick<PluginHookContext["paseo"], "providers">;

export type ModelCatalog = ReadonlyMap<string, ReadonlySet<string>>;

/** One model's advertised thinking-effort options, from the same `listModels` poll that builds `ModelCatalog`. */
export interface ModelThinkingOptions {
  /** Empty for a model that advertises no thinking options at all (e.g. Haiku). */
  optionIds: readonly string[];
  /** Absent when the model advertises no default — never invented. */
  defaultOptionId?: string;
}

/** `Map<family, Map<modelId, options>>` — same shape and same fail-soft-per-family semantics as `ModelCatalog`. */
export type ThinkingCatalog = ReadonlyMap<string, ReadonlyMap<string, ModelThinkingOptions>>;

/** The subset of a `listModels` result entry this cache reads. Structural — the daemon's `AgentModelDefinition`, and nothing else, satisfies this. */
interface ThinkingCapableModel {
  id: string;
  thinkingOptions?: ReadonlyArray<{ id: string; isDefault?: boolean }>;
  defaultThinkingOptionId?: string;
}

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
  /** Returns the most recently loaded thinking catalog, built from the same poll as `get()`. Never triggers a load itself. */
  getThinking(): ThinkingCatalog;
  /** Loads immediately, updates the cache, and returns the new catalog. */
  forceRefresh(): Promise<ModelCatalog>;
  /** Stops the refresh interval. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const EMPTY_CATALOG: ModelCatalog = new Map();
const EMPTY_THINKING_CATALOG: ThinkingCatalog = new Map();

/**
 * One model's `ModelThinkingOptions`, from its `listModels` entry.
 * `defaultThinkingOptionId` wins when present; otherwise the option carrying
 * `isDefault` (mirrors `normalizeAgentModelDefinition` in
 * packages/server/src/server/agent/agent-sdk-types.ts, which this plugin
 * cannot import — it is a daemon-internal module, not a published one).
 */
function thinkingOptionsOf(model: ThinkingCapableModel): ModelThinkingOptions {
  const options = model.thinkingOptions ?? [];
  const optionIds = options.map((option) => option.id);
  const defaultOptionId = model.defaultThinkingOptionId ?? options.find((option) => option.isDefault)?.id;
  return defaultOptionId !== undefined ? { optionIds, defaultOptionId } : { optionIds };
}

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
  let currentThinking: ThinkingCatalog = EMPTY_THINKING_CATALOG;

  const poller = createIntervalPoller({
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const families = getFamilies();
      const next = new Map<string, ReadonlySet<string>>();
      const nextThinking = new Map<string, ReadonlyMap<string, ModelThinkingOptions>>();
      for (const family of families) {
        try {
          // TYPE NOTE: family ids come from free-form daemon config (role
          // policy model refs), not necessarily one of the SDK's known
          // AgentProvider literals. Read/call structurally rather than
          // narrowing to that union.
          const result = await paseo.providers.listModels(
            family as Parameters<typeof paseo.providers.listModels>[0],
          );
          const models = (result.models ?? []) as readonly ThinkingCapableModel[];
          next.set(family, new Set(models.map((model) => model.id)));
          nextThinking.set(family, new Map(models.map((model) => [model.id, thinkingOptionsOf(model)])));
        } catch (error) {
          console.error(
            `[claude-account-pool] model-catalog: failed to refresh models for provider "${family}"`,
            error,
          );
          const previous = current.get(family);
          if (previous) {
            next.set(family, previous);
          }
          const previousThinking = currentThinking.get(family);
          if (previousThinking) {
            nextThinking.set(family, previousThinking);
          }
        }
      }
      current = next;
      currentThinking = nextThinking;
      return current;
    },
  });

  return {
    get: () => current,
    getThinking: () => currentThinking,
    forceRefresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
