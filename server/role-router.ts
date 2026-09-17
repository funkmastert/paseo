import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import { AGENT_TYPE_LABEL, type RoleRecord } from "../shared/role-policy-schema";
import { applyToolProfile } from "../shared/tool-profiles";
import type { HealthTracker } from "./health";
import { createLogThrottle } from "./log-throttle";
import type { ModelCatalogCache } from "./model-catalog";
import type { PoolCache } from "./pool";
import type { RecentAgentTypes } from "./recent-agent-types";
import type { PolicyCache } from "./role-policy";
import type { ProviderIdCache } from "./router";
import { selectModel } from "./role-availability";
import { resolveLeaderRole, resolveRole } from "./role-resolve";

/** Stands in for `callerAgentId` in notifications about a root agent, which has none. */
const ROOT_AGENT_CALLER = "(root agent)";

export interface DeclaredRoleUnknownEpisode {
  callerAgentId: string;
  value: string;
}

export interface RoleUnavailableEpisode {
  callerAgentId: string;
  roleId: string;
  requestedModel: string;
  /**
   * "no-eligible-model": the role's configured models were all catalog/pool
   * ineligible, so routing fell back to models[0] anyway.
   * "provider-not-registered": the resolved target family isn't a family
   * the provider registry currently knows about (e.g. removed from daemon
   * config since the role was configured) — the rewrite was skipped
   * entirely rather than pointing the request at a dead provider.
   */
  reason: "no-eligible-model" | "provider-not-registered";
}

export interface RoleRouterOptions {
  policyCache: PolicyCache;
  catalogCache: ModelCatalogCache;
  poolCache: PoolCache;
  health: Pick<HealthTracker, "isHealthyFor" | "isLastResortEligible">;
  recentAgentTypes: RecentAgentTypes;
  /**
   * Same provider-registry snapshot the account router (router.ts) uses to
   * validate its own rewrite target. Optional so existing same-family
   * routing (the common case) doesn't require wiring it up; only consulted
   * before a cross-family rewrite. When absent (or not yet loaded), a
   * cross-family rewrite proceeds unchecked, matching prior behavior.
   */
  providerIds?: ProviderIdCache;
  /** Called (deduplicated per caller+value) when a caller declared an unrecognized labels[AGENT_ROLE_LABEL] value. */
  onDeclaredRoleUnknown?: (episode: DeclaredRoleUnknownEpisode) => void;
  /** Called (deduplicated per role, re-armed on recovery) when a role has no eligible model and falls back to models[0]. */
  onRoleUnavailable?: (episode: RoleUnavailableEpisode) => void;
  /**
   * Injectable clock for tests; defaults to Date.now. Drives the throttle on
   * the "unexpected error resolving role" fail-open log, so a role that
   * keeps failing to resolve logs once per minute instead of once per create.
   */
  now?: () => number;
}

export type RoleCreateRouter = (
  input: { request: PluginBeforeRequests["agent.create"] },
  context: PluginHookContext,
) => PluginBeforeRequests["agent.create"] | void;

interface RequestWithRoleFields {
  labels?: Record<string, string>;
  initialPrompt?: string;
  callerAgentId?: string;
}

interface FamilyResolvablePool {
  workers: ReadonlyArray<{ providerId: string }>;
  leader: { providerId: string } | null;
}

type AgentCreateConfig = PluginBeforeRequests["agent.create"]["config"];
type ProviderOptionsValue = AgentCreateConfig["providerOptions"];

/**
 * The `providerOptions` a request should carry once the role's tool profile
 * is merged in, or undefined when the profile restricts nothing (so the
 * request can stay byte-identical).
 *
 * The cast is the same structural read the rest of this file uses: the wire
 * schema for `providerOptions` is free-form JSON, and the profile merge only
 * ever produces string arrays and nested objects.
 */
function enforceToolProfile(
  request: PluginBeforeRequests["agent.create"],
  role: RoleRecord,
): ProviderOptionsValue | undefined {
  return applyToolProfile(request.config.providerOptions, role.toolProfile) as
    | ProviderOptionsValue
    | undefined;
}

/** Applies tool enforcement alone, on the paths that skip the model rewrite. */
function withToolProfile(
  request: PluginBeforeRequests["agent.create"],
  providerOptions: ProviderOptionsValue | undefined,
): PluginBeforeRequests["agent.create"] | void {
  if (!providerOptions) {
    return;
  }
  return { ...request, config: { ...request.config, providerOptions } };
}

/** Renders a selection back into the ref spelling the operator configured, for notifications. */
function formatModelRef(outcome: { provider: string | null; model: string }): string {
  return outcome.provider === null ? outcome.model : `${outcome.provider}/${outcome.model}`;
}

/** Model refs use provider-family ids; a request's current provider may instead be a literal pool-worker/leader entry id. */
function familyOfProvider(pool: FamilyResolvablePool, providerId: string): string {
  if (providerId === "claude") {
    return "claude";
  }
  if (pool.workers.some((worker) => worker.providerId === providerId) || pool.leader?.providerId === providerId) {
    return "claude";
  }
  return providerId;
}

/**
 * `before("agent.create")` handler: resolves the caller's role from
 * labels/title/initialPrompt, selects that role's top eligible model against
 * the live catalog + pool health, and rewrites `config.model` (and
 * `config.provider` only when the selection crosses provider families).
 * and merges the role's tool profile into `config.providerOptions`.
 * Must be registered BEFORE the account-pool's own router — this hook never
 * changes *which account*; the account router (unmodified) still decides that.
 *
 * Unlike the account router, this one resolves EVERY create: an agent-spawned
 * child through the usual tier 1-4 resolution, and a root agent (no
 * `callerAgentId`) to the `leader` role. Every failure mode is a passthrough —
 * this must never block agent creation.
 */
export function createRoleRouter(options: RoleRouterOptions): RoleCreateRouter {
  const declaredUnknownSeen = new Set<string>();
  const unavailableRoleIds = new Set<string>();
  const logThrottle = createLogThrottle({ now: options.now });

  return function routeRoleForCreate(input) {
    try {
      return routeRoleForCreateUnguarded(input, options, declaredUnknownSeen, unavailableRoleIds);
    } catch (error) {
      // Defense-in-depth on the never-block contract: every code path below
      // is meant to fail open already, but a throw anywhere in resolve/select
      // (e.g. requireStandardRole on a corrupt policy) would otherwise
      // propagate straight to createAgent's rejection. Log and pass through
      // instead of blocking the create. Throttled: a role stuck failing to
      // resolve would otherwise log identically on every create.
      logThrottle("unexpected-error", () => {
        console.error(
          "[claude-account-pool] role-router: unexpected error resolving role; passing the request through untouched",
          error,
        );
      });
      return undefined;
    }
  };
}

function routeRoleForCreateUnguarded(
  input: { request: PluginBeforeRequests["agent.create"] },
  options: RoleRouterOptions,
  declaredUnknownSeen: Set<string>,
  unavailableRoleIds: Set<string>,
): PluginBeforeRequests["agent.create"] | void {
  const { request } = input;

  // TYPE NOTE: labels/initialPrompt/callerAgentId aren't on every
  // installed @getpaseo/plugin release's PluginBeforeRequests["agent.create"]
  // type yet; the daemon supplies them at runtime regardless. Read
  // structurally rather than forking the SDK types, mirroring router.ts's
  // callerAgentId note.
  const extended = request as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  const callerAgentId = extended.callerAgentId;
  const policy = options.policyCache.get();

  // A create with no callerAgentId is a ROOT agent — human-, CLI-, app-,
  // schedule- or heartbeat-started. Those used to pass through untouched,
  // which left the one agent that spawns everything else as the only
  // unconstrained one. It now resolves to the `leader` role, which ships
  // unconfigured so this stays a pass-through until it's set up.
  let role: RoleRecord;
  if (callerAgentId) {
    const agentTypeKey = extended.labels?.[AGENT_TYPE_LABEL] ?? request.config.title ?? undefined;
    if (agentTypeKey) {
      options.recentAgentTypes.record(agentTypeKey);
    }

    const resolution = resolveRole(policy, {
      labels: extended.labels,
      title: request.config.title,
      initialPrompt: extended.initialPrompt,
    });

    if (resolution.unknownDeclaredValue !== undefined) {
      const dedupeKey = `${callerAgentId} ${resolution.unknownDeclaredValue}`;
      if (!declaredUnknownSeen.has(dedupeKey)) {
        declaredUnknownSeen.add(dedupeKey);
        options.onDeclaredRoleUnknown?.({ callerAgentId, value: resolution.unknownDeclaredValue });
      }
    }
    role = resolution.role;
  } else {
    role = resolveLeaderRole(policy);
  }
  const episodeCaller = callerAgentId ?? ROOT_AGENT_CALLER;

  // Tool enforcement is independent of model selection: a role can have no
  // configured models (so no rewrite) and still be restricted to reading, or
  // to pure delegation.
  const enforcedProviderOptions = enforceToolProfile(request, role);

  const catalog = options.catalogCache.get();
  const { pool } = options.poolCache.get();
  const outcome = selectModel(role, catalog, pool, options.health);

  if (outcome.outcome === "unconfigured") {
    return withToolProfile(request, enforcedProviderOptions);
  }

  // A bare (account-agnostic) ref chose only a model: leave `config.provider`
  // alone so the account router downstream still picks the account. Only a
  // pinned `provider/model` ref can move the request to another family.
  const requestedFamily = familyOfProvider(pool, request.config.provider);
  const crossesFamily = outcome.provider !== null && outcome.provider !== requestedFamily;

  // Cross-family rewrites point `config.provider` at a family the account
  // router (router.ts) never gets a chance to validate — it only checks
  // claude-family targets against the provider registry. A family removed
  // from daemon config since the role was configured would otherwise
  // produce a request the daemon can never launch. Verify against the
  // same registry snapshot before committing to the switch; same-family
  // selections (the common case) skip this, since that family is already
  // the one in active use.
  if (crossesFamily) {
    const pinnedProvider = outcome.provider as string; // crossesFamily implies a pinned (non-null) provider.
    const registeredProviderIds = options.providerIds?.get();
    if (registeredProviderIds && !registeredProviderIds.has(pinnedProvider)) {
      if (!unavailableRoleIds.has(role.id)) {
        unavailableRoleIds.add(role.id);
        options.onRoleUnavailable?.({
          callerAgentId: episodeCaller,
          roleId: role.id,
          requestedModel: formatModelRef(outcome),
          reason: "provider-not-registered",
        });
      }
      // Recovered, not blocked: skip the model rewrite but keep enforcing the
      // role's tools — a vanished model target is no reason to hand an
      // orchestrator a shell.
      return withToolProfile(request, enforcedProviderOptions);
    }
  }

  if (outcome.outcome === "unavailable") {
    if (!unavailableRoleIds.has(role.id)) {
      unavailableRoleIds.add(role.id);
      options.onRoleUnavailable?.({
        callerAgentId: episodeCaller,
        roleId: role.id,
        requestedModel: formatModelRef(outcome),
        reason: "no-eligible-model",
      });
    }
  } else {
    unavailableRoleIds.delete(role.id); // Re-arm: the role recovered.
  }

  const nextConfig: AgentCreateConfig = { ...request.config, model: outcome.model };
  if (crossesFamily && outcome.provider !== null) {
    nextConfig.provider = outcome.provider as AgentCreateConfig["provider"];
  }
  if (enforcedProviderOptions) {
    nextConfig.providerOptions = enforcedProviderOptions;
  }

  return { ...request, config: nextConfig };
}
