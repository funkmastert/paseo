import { fileURLToPath } from "node:url";
import type { PluginBeforeRequests, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { createAccountIdentity } from "./server/account-identity";
import { startClassifierToolServer, type ClassifierToolServer } from "./server/classifier-tool";
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

/**
 * Upper bound on how long an `agent.create` dispatch will wait for the
 * post-reload cache warm-up before proceeding anyway. Bounded so a stuck
 * daemon RPC can't block agent creation forever — after this, routing falls
 * back to whatever state loaded (the previous fire-and-forget behavior).
 */
const STARTUP_WARM_TIMEOUT_MS = 5000;

/**
 * The MCP server name the classifier tool is injected under. Namespaced so
 * an operator reading an agent's config can tell where it came from, and so
 * it can never collide with a server the caller configured itself.
 */
const CLASSIFIER_MCP_SERVER = "paseo-agent-policy";

/** The stdio shim the daemon spawns per agent. See server/classifier-tool.ts for why it is a separate process. */
const CLASSIFIER_MCP_ENTRY = fileURLToPath(new URL("./mcp/agent-model-policy.mjs", import.meta.url));

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
  let classifierTool: ClassifierToolServer | null = null;
  // Resolves once the post-reload warm-up (below) has settled or timed out.
  // Non-null only while a warm-up is in flight; `poolCache` truthy is the
  // steady-state fast path once it's done. Shared so a create dispatched
  // while a turn_ended/RPC-triggered warm-up is already running waits on
  // that SAME warm-up instead of starting a second one.
  let startingPromise: Promise<void> | null = null;

  // The server contribution itself has no `paseo` handle (see
  // PluginServerContext); every hook/observer callback receives one through
  // its PluginHookContext, so the pool cache, usage poller, and notifier are
  // started lazily from whichever hook fires first.
  //
  // Returns a promise that resolves once the initial warm-up has settled (or
  // timed out) so a `before("agent.create")` dispatch can await it: the
  // caches below all start at fail-open defaults (DEFAULT_POLICY, an empty
  // pool, a cold catalog) immediately after every plugin reload or daemon
  // restart, and nothing else populates them before the warm-up below runs.
  // A caller that only needs the cache OBJECTS to exist (they're assigned
  // synchronously, before any awaiting) can ignore the return value, exactly
  // as before.
  function ensureStarted(paseo: PluginHookContext["paseo"]): Promise<void> {
    if (poolCache) {
      return Promise.resolve();
    }
    if (startingPromise) {
      return startingPromise;
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
    const startedPoolCache = poolCache;
    const startedProviderIds = providerIds;
    const startedCatalogCache = catalogCache;
    const startedParentProfiles = parentProfiles;
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
        const why =
          episode.reason === "not-approved"
            ? `which is not in ${pool}`
            : episode.missingFromCatalog
              ? `which ${pool} approves but the provider's model catalog doesn't list, and it isn't in agentModelPolicy.allowUnlistedModels (add "${episode.requestedRef.slice(episode.requestedRef.indexOf("/") + 1)}" there if the provider does accept it)`
              : `which ${pool} approves but isn't currently selectable (no viable pool member, or budget-gated)`;
        console.error(
          `[claude-account-pool] role-router: caller "${episode.callerAgentId}" explicitly requested "${episode.requestedRef}", ${why}; policy overrode it to "${episode.effectiveRef}"`,
        );
      },
      onUnadvertisedModelAllowed: (episode) => {
        const pool = episode.taskClass ? `role "${episode.roleId}"'s ${episode.taskClass} pool` : `role "${episode.roleId}"'s pool`;
        const how =
          episode.source === "explicit"
            ? `caller "${episode.callerAgentId}" explicitly requested "${episode.ref}"; ${pool} approves it`
            : `${pool} selected "${episode.ref}" as its default for caller "${episode.callerAgentId}"`;
        console.error(
          `[claude-account-pool] role-router: UNVERIFIED MODEL — ${how}, and the provider's model catalog does not list it. Letting it run because agentModelPolicy.allowUnlistedModels names it. If the agent fails at launch, the provider rejected the id; remove it from allowUnlistedModels`,
        );
      },
    });
    // The agent-facing half of the classifier. The socket opens whether or
    // not the policy exposes the tool — it is unref'd, answers one question,
    // and costs nothing idle, whereas opening it lazily would mean an agent
    // created in the seconds after a policy change found nothing listening.
    classifierTool = startClassifierToolServer({
      world: () => ({
        policy: startedPolicyCache.get(),
        catalog: startedCatalogCache.get(),
        pool: startedPoolCache.get().pool,
        health,
        nowMs: Date.now(),
      }),
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

    // Deferred onto a microtask so THIS dispatch (whichever hook happened to
    // be first) never synchronously calls into `paseo` — callers that don't
    // await the returned promise (the `on(...)` event handlers below) see
    // exactly the same fire-and-forget timing as before. `before("agent.create")`
    // dispatches, unlike those, DO await this: see the registration below for
    // why a create can no longer outrun the warm-up the way an event observer
    // safely can.
    startingPromise = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const warmed = Promise.all([
          startedPoolCache.forceRefresh().catch(() => undefined),
          startedProviderIds.forceRefresh().catch(() => undefined),
          // Warmed unconditionally, before any role is known to be restricted:
          // the agents whose restrictions matter most are the ones already
          // running when the operator activates a policy change, and a plugin
          // reload is exactly what activating one does.
          startedParentProfiles.warm().catch(() => undefined),
          // The catalog's families depend on the policy, so warm the policy
          // first — otherwise the very first catalog refresh sees no families
          // and every role starts UNAVAILABLE until the next 60s tick.
          startedPolicyCache
            .forceRefresh()
            .then(() => startedCatalogCache.forceRefresh())
            .catch(() => undefined),
          startedUsagePoller.pollOnce().catch(() => undefined),
        ]).then(() => undefined);
        const timedOut = new Promise<void>((resolveTimeout) => {
          const timer = setTimeout(resolveTimeout, STARTUP_WARM_TIMEOUT_MS);
          // Never the reason the process stays alive.
          (timer as unknown as { unref?: () => void }).unref?.();
        });
        void Promise.race([warmed, timedOut]).then(() => {
          // Once settled, `poolCache` truthy already short-circuits every
          // future call; clearing this just drops the now-pointless reference.
          startingPromise = null;
          resolve();
        });
      });
    });
    return startingPromise;
  }

  async function refreshPolicyForCreate(): Promise<void> {
    if (!policyCache) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STARTUP_WARM_TIMEOUT_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([policyCache.forceRefresh().then(() => undefined, () => undefined), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Two separate registrations, not one handler calling both: `before`
  // handlers for one event run sequentially in registration order, each
  // output feeding the next input (packages/server/.../plugins/lifecycle/index.ts).
  // Registering the role hook first means it only ever rewrites
  // config.model/config.provider; the account router still runs second,
  // unmodified, and picks the account for whatever model the role hook left
  // in place.
  //
  // Both AWAIT ensureStarted(), unlike the `on(...)` observers below: an
  // observer only needs the cache OBJECTS to exist (assigned synchronously),
  // but these two decide enforcement and routing from what the caches
  // CONTAIN. Without awaiting, the very first `agent.create` dispatched
  // after every plugin reload or daemon restart is GUARANTEED to run against
  // still-default state — not a race that can go either way, but a certainty,
  // since forceRefresh() is only even scheduled (onto a microtask) by this
  // same call to ensureStarted(). A restrictive role's tool profile silently
  // stops applying for exactly that one request. Bounded by
  // STARTUP_WARM_TIMEOUT_MS so a stuck daemon RPC still can't block agent
  // creation forever.
  const unregisterRoleCreate = server.before("agent.create", async (input, context) => {
    await ensureStarted(context.paseo);
    // Re-read the policy on every create rather than trusting the 60s tick: an
    // operator who edits agentModelPolicy expects the NEXT spawn to see it, and
    // a create landing seconds after the edit was routed by the stale policy
    // (the allowlist looked ignored while `role-model-policy.read`, which
    // bypasses the cache, showed it). Creates are rare and the read is a local
    // RPC. It cannot throw (loadRolePolicy keeps the last good policy on any
    // failure) and is bounded so a stuck daemon can't stall spawning.
    await refreshPolicyForCreate();
    return roleRouter?.(input, context) ?? undefined;
  });
  const unregisterCreate = server.before("agent.create", async (input, context) => {
    await ensureStarted(context.paseo);
    return router?.(input, context) ?? undefined;
  });

  // Third registration, and deliberately not folded into the role hook: WHICH
  // tools an agent gets is a different question from what the agent should
  // be, and the role hook returns early on half a dozen paths that must not
  // also mean "no policy tool". Off unless the operator turns it on.
  const unregisterClassifierTool = server.before("agent.create", async (input, context) => {
    await ensureStarted(context.paseo);
    if (!classifierTool || policyCache?.get().exposeClassifierTool !== true) {
      return undefined;
    }
    const { request } = input;
    const mcpServers = {
      ...(request.config.mcpServers ?? {}),
      [CLASSIFIER_MCP_SERVER]: {
        type: "stdio" as const,
        command: process.execPath,
        args: [CLASSIFIER_MCP_ENTRY],
        env: { PASEO_CLASSIFIER_SOCKET: classifierTool.socketPath },
      },
    };
    return {
      ...request,
      config: { ...request.config, mcpServers },
    } as PluginBeforeRequests["agent.create"];
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
    unregisterClassifierTool();
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
    classifierTool?.close();
  };
}
