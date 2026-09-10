import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createHealthTracker } from "./server/health";
import { createNotifier, type Notifier } from "./server/notify";
import { createPoolCache, type PoolCache } from "./server/pool";
import { createProviderIdCache, createRouter, type AgentCreateRouter, type ProviderIdCache } from "./server/router";
import { createUsagePoller, type FetchUsageFn, type UsagePoller } from "./server/usage-poll";

function isPoolProvider(pool: PoolCache, providerId: string): boolean {
  const { pool: resolved } = pool.get();
  return (
    resolved.workers.some((worker) => worker.providerId === providerId) ||
    resolved.leader?.providerId === providerId
  );
}

export default function contribute(server: PluginServerContext) {
  const health = createHealthTracker();

  let poolCache: PoolCache | null = null;
  let providerIds: ProviderIdCache | null = null;
  let usagePoller: UsagePoller | null = null;
  let notifier: Notifier | null = null;
  let router: AgentCreateRouter | null = null;

  // The server contribution itself has no `paseo` handle (see
  // PluginServerContext); every hook/observer callback receives one through
  // its PluginHookContext, so the pool cache, usage poller, and notifier are
  // started lazily from whichever hook fires first.
  function ensureStarted(paseo: PluginHookContext["paseo"]): void {
    if (poolCache) {
      return;
    }

    poolCache = createPoolCache(paseo);
    providerIds = createProviderIdCache(paseo);
    notifier = createNotifier({ paseo, health });

    // Both caches start empty/fail-open and otherwise wait for their 60s
    // interval tick. Without this, every create in the window after a
    // daemon restart or plugin reload fails open (routes unprotected).
    // Fire-and-forget on a microtask so this hook dispatch never awaits
    // the refresh; the very first create can still race it, but the
    // fail-open window shrinks from ~60s to one RPC round-trip.
    const startedPoolCache = poolCache;
    const startedProviderIds = providerIds;
    queueMicrotask(() => {
      void startedPoolCache.forceRefresh();
      void startedProviderIds.forceRefresh();
    });
    router = createRouter({
      poolCache,
      health,
      providerIds,
      onPoolDry: (episode) => notifier?.notePoolDry(episode),
      onFailOpen: (episode) => notifier?.noteFailOpen(episode),
      onPoolRecovered: () => notifier?.notePoolRecovered(),
    });

    const fetchUsage: FetchUsageFn = async () => {
      const result = await paseo.providers.listUsage();
      return {
        providers: result.providers.map((provider) => ({
          providerId: provider.providerId,
          windows: provider.windows.map((window) => ({
            id: window.id,
            usedPct: window.usedPct ?? null,
            resetsAt: window.resetsAt ?? null,
          })),
        })),
      };
    };
    usagePoller = createUsagePoller(health, { fetchUsage });
  }

  const unregisterCreate = server.before("agent.create", (input, context) => {
    ensureStarted(context.paseo);
    return router?.(input, context) ?? undefined;
  });

  const unregisterTurnEnded = server.on("agent.turn_ended", (event, context) => {
    ensureStarted(context.paseo);
    if (poolCache && isPoolProvider(poolCache, event.agent.provider)) {
      if (event.outcome.kind === "failed") {
        health.reportTurnFailure(event.agent.provider, event.outcome.error.message);
      } else if (event.outcome.kind === "completed") {
        health.noteTurnCompleted(event.agent.provider);
      }
    }
    notifier?.onTurnEnded(event.agent.id);
  });

  const unregisterPermissionRequested = server.on("agent.permission_requested", (event, context) => {
    ensureStarted(context.paseo);
    notifier?.onPermissionRequested(event.agent.id);
  });

  const unregisterPermissionResolved = server.on("agent.permission_resolved", (event, context) => {
    ensureStarted(context.paseo);
    notifier?.onPermissionResolved(event.agent.id);
  });

  const unregisterArchived = server.on("agent.archived", (event, context) => {
    ensureStarted(context.paseo);
    notifier?.onAgentArchived(event.agent.id);
  });

  return () => {
    unregisterCreate();
    unregisterTurnEnded();
    unregisterPermissionRequested();
    unregisterPermissionResolved();
    unregisterArchived();
    poolCache?.stop();
    providerIds?.stop();
    usagePoller?.stop();
    notifier?.stop();
  };
}
