import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createAccountIdentity } from "./server/account-identity";
import { createHealthTracker } from "./server/health";
import { createModelCatalogCache, type ModelCatalogCache } from "./server/model-catalog";
import { createNotifier, type Notifier } from "./server/notify";
import { createParentToolProfiles, type ParentToolProfiles } from "./server/parent-profiles";
import { createPoolCache, type PoolCache } from "./server/pool";
import { createRecentAgentTypes, type RecentAgentTypes } from "./server/recent-agent-types";
import { createPolicyCache, type PolicyCache } from "./server/role-policy";
import { createRoleModelPolicyRpcHandlers } from "./server/role-policy-rpc-handlers";
import { createRoleRouter, type RoleCreateRouter } from "./server/role-router";
import { createProviderIdCache, createRouter, type AgentCreateRouter, type ProviderIdCache } from "./server/router";
import { createUsagePoller, type FetchUsageFn, type UsagePoller } from "./server/usage-poll";
import { roleModelPolicyRpc } from "./shared/role-policy-rpc";
import { AGENT_TYPE_LABEL, rolePolicyFamilies } from "./shared/role-policy-schema";

function isPoolProvider(pool: PoolCache, providerId: string): boolean {
  const { pool: resolved } = pool.get();
  return (
    resolved.workers.some((worker) => worker.providerId === providerId) ||
    resolved.leader?.providerId === providerId
  );
}

export default function contribute(server: PluginServerContext) {
  const health = createHealthTracker();
  // Long-lived alongside the health tracker: both are fed by the same usage poll, and both
  // start empty after a reload rather than being rebuilt per hook dispatch.
  const accountIdentity = createAccountIdentity();

  let poolCache: PoolCache | null = null;
  let providerIds: ProviderIdCache | null = null;
  let usagePoller: UsagePoller | null = null;
  let notifier: Notifier | null = null;
  let parentProfiles: ParentToolProfiles | null = null;
  let router: AgentCreateRouter | null = null;
  let policyCache: PolicyCache | null = null;
  let catalogCache: ModelCatalogCache | null = null;
  let recentAgentTypes: RecentAgentTypes | null = null;
  let roleRouter: RoleCreateRouter | null = null;
  let roleModelPolicyRpcHandlers: ReturnType<typeof createRoleModelPolicyRpcHandlers> | null = null;

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
    policyCache = createPolicyCache(paseo);
    const startedPolicyCache = policyCache;
    catalogCache = createModelCatalogCache(paseo, () => rolePolicyFamilies(startedPolicyCache.get()));
    recentAgentTypes = createRecentAgentTypes();
    parentProfiles = createParentToolProfiles(paseo);

    // Both caches start empty/fail-open and otherwise wait for their 60s
    // interval tick. Without this, every create in the window after a
    // daemon restart or plugin reload fails open (routes unprotected).
    // Fire-and-forget on a microtask so this hook dispatch never awaits
    // the refresh; the very first create can still race it, but the
    // fail-open window shrinks from ~60s to one RPC round-trip.
    const startedPoolCache = poolCache;
    const startedProviderIds = providerIds;
    const startedCatalogCache = catalogCache;
    const startedParentProfiles = parentProfiles;
    queueMicrotask(() => {
      void startedPoolCache.forceRefresh();
      void startedProviderIds.forceRefresh();
      // Warmed unconditionally, before any role is known to be restricted:
      // the agents whose restrictions matter most are the ones already
      // running when the operator activates a policy change, and a plugin
      // reload is exactly what activating one does.
      void startedParentProfiles.warm();
      // The catalog's families depend on the policy, so warm the policy
      // first — otherwise the very first catalog refresh sees no families
      // and every role starts UNAVAILABLE until the next 60s tick.
      void startedPolicyCache.forceRefresh().then(() => startedCatalogCache.forceRefresh());
    });
    roleRouter = createRoleRouter({
      policyCache,
      catalogCache,
      poolCache,
      health,
      recentAgentTypes,
      providerIds,
      parentProfiles,
      onDeclaredRoleUnknown: (episode) =>
        console.error(
          `[claude-account-pool] role-router: caller "${episode.callerAgentId}" declared unknown role "${episode.value}"; falling through to automatic classification`,
        ),
      onDeclaredTaskClassUnknown: (episode) =>
        console.error(
          `[claude-account-pool] role-router: caller "${episode.callerAgentId}" declared unknown task class "${episode.value}" (expected mechanical/standard/hard); falling through to automatic classification`,
        ),
      onToolProfileWithheld: (episode) =>
        console.error(
          `[claude-account-pool] role-router: role "${episode.roleId}" was resolved by tier-${episode.tier} classification for caller "${episode.callerAgentId}", not an explicit label/mapping; its tool profile was withheld (model selection still applies) — label the agent with paseo.agent-type or paseo.agent-role to enforce it`,
        ),
      onParentProfileUnresolved: (episode) =>
        console.error(
          episode.failedSafe
            ? `[claude-account-pool] role-router: caller "${episode.callerAgentId}" is not in the agent directory, so what it was restricted to is unknowable; role "${episode.roleId}"'s child was given the read-only floor rather than a clean profile`
            : `[claude-account-pool] role-router: the agent directory has not loaded yet, so caller "${episode.callerAgentId}"'s restrictions are unknown; role "${episode.roleId}"'s child inherits nothing this time`,
        ),
      onRoleUnavailable: (episode) => {
        const pool = episode.taskClass ? `${episode.taskClass} pool` : "pool";
        console.error(
          episode.reason === "provider-not-registered"
            ? `[claude-account-pool] role-router: role "${episode.roleId}"'s resolved provider is not registered with the daemon for caller "${episode.callerAgentId}" (wanted "${episode.requestedModel}"); passing the request through untouched`
            : `[claude-account-pool] role-router: role "${episode.roleId}" has no eligible model in its ${pool} for caller "${episode.callerAgentId}"; falling back to its top configured model "${episode.requestedModel}"`,
        );
      },
      onExplicitModelOverridden: (episode) => {
        const pool = episode.taskClass ? `role "${episode.roleId}"'s ${episode.taskClass} pool` : `role "${episode.roleId}"'s pool`;
        console.error(
          episode.reason === "not-approved"
            ? `[claude-account-pool] role-router: caller "${episode.callerAgentId}" explicitly requested "${episode.requestedRef}", which is not in ${pool}; policy overrode it to "${episode.effectiveRef}"`
            : `[claude-account-pool] role-router: caller "${episode.callerAgentId}" explicitly requested "${episode.requestedRef}", which ${pool} approves but isn't currently selectable (catalog-missing, no viable pool member, or budget-gated); policy overrode it to "${episode.effectiveRef}"`,
        );
      },
    });
    roleModelPolicyRpcHandlers = createRoleModelPolicyRpcHandlers({
      policyCache,
      catalogCache,
      poolCache,
      health,
      recentAgentTypes,
    });
    router = createRouter({
      poolCache,
      health,
      providerIds,
      accountIdentity,
      onPoolDry: (episode) => notifier?.notePoolDry(episode),
      onPoolCollapsed: (episode) => {
        notifier?.notePoolCollapsed(episode);
        console.error(
          `[claude-account-pool] router: pool collapsed onto a single account "${episode.targetProviderId}" (shared entries: ${episode.sharedProviderIds.join(", ")}; out of budget: ${episode.exhaustedProviderIds.join(", ") || "none"}) — budget isolation is gone until another account has capacity`,
        );
      },
      onPoolExhausted: (episode) => {
        notifier?.notePoolExhausted(episode);
        console.error(
          `[claude-account-pool] router: every pooled account is out of budget (${episode.exhaustedProviderIds.join(", ")}); refusing the spawn from caller "${episode.callerAgentId}" rather than starting it on a dead account (earliest reset: ${episode.earliestResetAt?.toISOString() ?? "unknown"})`,
        );
      },
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
    usagePoller = createUsagePoller(health, { fetchUsage, accountIdentity });

    // Same blind-start problem as the caches above: the poller's own
    // interval is 5 minutes, so without this the health tracker has no
    // usage readings at all — every account looks healthy — for up to 5
    // minutes after every plugin start or reload.
    const startedUsagePoller = usagePoller;
    queueMicrotask(() => {
      void startedUsagePoller.pollOnce();
    });
  }

  // Two separate registrations, not one handler calling both: `before`
  // handlers for one event run sequentially in registration order, each
  // output feeding the next input (packages/server/.../plugins/lifecycle/index.ts).
  // Registering the role hook first means it only ever rewrites
  // config.model/config.provider; the account router still runs second,
  // unmodified, and picks the account for whatever model the role hook left
  // in place.
  const unregisterRoleCreate = server.before("agent.create", (input, context) => {
    ensureStarted(context.paseo);
    return roleRouter?.(input, context) ?? undefined;
  });
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

  const unregisterCreated = server.on("agent.created", (event, context) => {
    ensureStarted(context.paseo);
    notifier?.onAgentCreated(event.agent.id);
    // The free half of the parent-restriction map: every agent created while
    // this plugin is running records what the create hook denied it, straight
    // off the labels the hook wrote. See server/parent-profiles.ts.
    parentProfiles?.note(event.agent.id, event.agent.labels);
    // Also feeds recentAgentTypes for human-created leaders, which never
    // pass through the role router (no callerAgentId) but should still show
    // up in the settings UI's mapping-name autocomplete. Idempotent against
    // the role router's own feed for agent-spawned children.
    const agentTypeKey = event.agent.labels?.[AGENT_TYPE_LABEL] ?? event.agent.title ?? undefined;
    if (agentTypeKey) {
      recentAgentTypes?.record(agentTypeKey);
    }
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

  // Settings-screen RPC surface. Each handler ensures the shared caches
  // exist first — a settings screen can open before any agent.create/agent.*
  // event has ever fired this plugin process.
  server.handle(roleModelPolicyRpc.read, (input, context) => {
    ensureStarted(context.paseo);
    return roleModelPolicyRpcHandlers!.read(input, context);
  });
  server.handle(roleModelPolicyRpc.write, (input, context) => {
    ensureStarted(context.paseo);
    return roleModelPolicyRpcHandlers!.write(input, context);
  });
  server.handle(roleModelPolicyRpc.listModels, (input, context) => {
    ensureStarted(context.paseo);
    return roleModelPolicyRpcHandlers!.listModels(input, context);
  });
  server.handle(roleModelPolicyRpc.recentAgentTypes, (input, context) => {
    ensureStarted(context.paseo);
    return roleModelPolicyRpcHandlers!.recentAgentTypes(input, context);
  });
  server.handle(roleModelPolicyRpc.explain, (input, context) => {
    ensureStarted(context.paseo);
    return roleModelPolicyRpcHandlers!.explain(input, context);
  });

  return () => {
    unregisterRoleCreate();
    unregisterCreate();
    unregisterTurnEnded();
    unregisterPermissionRequested();
    unregisterPermissionResolved();
    unregisterCreated();
    unregisterArchived();
    poolCache?.stop();
    providerIds?.stop();
    usagePoller?.stop();
    notifier?.stop();
    policyCache?.stop();
    catalogCache?.stop();
    parentProfiles?.stop();
  };
}
