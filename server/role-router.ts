import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import { AGENT_TYPE_LABEL, MODEL_OVERRIDDEN_LABEL, type RoleModelPolicy, type RoleRecord } from "../shared/role-policy-schema";
import { applyToolProfile, DEFAULT_TOOL_PROFILE, type ToolProfile } from "../shared/tool-profiles";
import type { HealthTracker } from "./health";
import { createLogThrottle } from "./log-throttle";
import type { ModelCatalogCache } from "./model-catalog";
import type { PoolCache } from "./pool";
import type { RecentAgentTypes } from "./recent-agent-types";
import type { PolicyCache } from "./role-policy";
import type { ProviderIdCache } from "./router";
import { evaluateRequestedModel, familyOfProvider, formatModelRef, selectModel } from "./role-availability";
import { resolveLeaderRole, resolveRole, type ResolveRoleTier } from "./role-resolve";

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

export interface ToolProfileWithheldEpisode {
  callerAgentId: string;
  roleId: string;
  /** The tier the role was resolved at — always 3 or 4 when this fires. */
  tier: ResolveRoleTier;
}

export interface ExplicitModelOverriddenEpisode {
  callerAgentId: string;
  roleId: string;
  /** The `provider/model` the caller explicitly asked for. */
  requestedRef: string;
  /** What policy ran instead, spelled the same way. */
  effectiveRef: string;
  /**
   * "not-approved": the requested ref was never one of the role's configured
   * entries — the role forbids it outright.
   * "not-currently-selectable": the requested ref IS one of the role's
   * configured entries, but isn't selectable right now (catalog-missing, no
   * viable pool member, or gated by the Fable budget threshold) — the
   * caller asked for something approved that just isn't available.
   */
  reason: "not-approved" | "not-currently-selectable";
}

export interface RoleRouterOptions {
  policyCache: PolicyCache;
  catalogCache: ModelCatalogCache;
  poolCache: PoolCache;
  health: Pick<HealthTracker, "isHealthyFor" | "isLastResortEligible" | "windowUtilization">;
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
  /**
   * Called (deduplicated per caller+role) when a role's tool profile was
   * withheld because the role came from tier-3/4 classification rather than
   * explicit evidence (a label, a mapping, or the deterministic leader tier),
   * and `enforceToolsOnClassifiedRoles` is off. Only fires when the withheld
   * profile would actually have restricted something — an already-unrestricted
   * role has nothing to withhold.
   */
  onToolProfileWithheld?: (episode: ToolProfileWithheldEpisode) => void;
  /** Called (deduplicated per role, re-armed on recovery) when a role has no eligible model and falls back to models[0]. */
  onRoleUnavailable?: (episode: RoleUnavailableEpisode) => void;
  /** Called (deduplicated per caller+role+requestedRef) when an explicitly requested model wasn't in the resolved role's pool and policy overrode it. */
  onExplicitModelOverridden?: (episode: ExplicitModelOverriddenEpisode) => void;
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

type AgentCreateConfig = PluginBeforeRequests["agent.create"]["config"];
type ProviderOptionsValue = AgentCreateConfig["providerOptions"];

/**
 * The `providerOptions` a request should carry once a tool profile is merged
 * in, or undefined when the profile restricts nothing (so the request can
 * stay byte-identical). Takes the profile directly rather than a role, since
 * the caller may need to substitute `DEFAULT_TOOL_PROFILE` for a role whose
 * own profile isn't backed by enough evidence to enforce — see
 * `toolProfileIsEvidenceBased` below.
 *
 * The cast is the same structural read the rest of this file uses: the wire
 * schema for `providerOptions` is free-form JSON, and the profile merge only
 * ever produces string arrays and nested objects.
 */
function enforceToolProfile(
  request: PluginBeforeRequests["agent.create"],
  toolProfile: ToolProfile,
): ProviderOptionsValue | undefined {
  return applyToolProfile(request.config.providerOptions, toolProfile) as ProviderOptionsValue | undefined;
}

/**
 * Whether a role's own tool profile may be enforced, or must be withheld in
 * favor of `DEFAULT_TOOL_PROFILE` (unrestricted).
 *
 * A guessed role may still choose a model — a wrong guess there costs a
 * little quality. Tool restriction from a wrong guess is worse: it can
 * silently strip Write/Edit/Bash from an agent mid-task, discovered only when
 * it tries to use them. So tool enforcement demands a higher standard of
 * evidence than model selection does:
 *   - tier 1 (explicit `paseo.agent-type` mapping) and tier 2 (explicit
 *     `paseo.agent-role` label) are the caller stating its role outright.
 *   - `tier === undefined` is the deterministic leader tier: a root agent
 *     (no `callerAgentId`) genuinely IS the leader, no classification
 *     involved (see `resolveLeaderRole`'s own doc comment).
 *   - tier 3 (seed/vocabulary text classification) and tier 4 (the bare
 *     default) are both guesses from free text — an implementation prompt
 *     that happens to contain "check" or "verify" classifies as `reviewer`
 *     by tier 3 exactly as readily as a real review task does. Those tiers
 *     may still pick a model; they may not take tools away, unless the
 *     operator has explicitly opted in via `enforceToolsOnClassifiedRoles`.
 */
function toolProfileIsEvidenceBased(tier: ResolveRoleTier | undefined, policy: RoleModelPolicy): boolean {
  if (tier === undefined || tier === 1 || tier === 2) {
    return true;
  }
  return policy.enforceToolsOnClassifiedRoles === true;
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
 *
 * Model selection and tool enforcement are gated on different evidence
 * standards. Every tier gets to influence which model runs — a wrong guess
 * there just costs some quality. Only tier 1/2 (an explicit label or mapping)
 * and the deterministic leader tier get to influence which TOOLS run — a
 * wrong guess there can silently strip Write/Edit/Bash from an agent already
 * mid-task, exactly what shipped and broke in production. See
 * `toolProfileIsEvidenceBased` below.
 */
export function createRoleRouter(options: RoleRouterOptions): RoleCreateRouter {
  const declaredUnknownSeen = new Set<string>();
  const unavailableRoleIds = new Set<string>();
  const overriddenSeen = new Set<string>();
  const toolProfileWithheldSeen = new Set<string>();
  const logThrottle = createLogThrottle({ now: options.now });

  return function routeRoleForCreate(input) {
    try {
      return routeRoleForCreateUnguarded(
        input,
        options,
        declaredUnknownSeen,
        unavailableRoleIds,
        overriddenSeen,
        toolProfileWithheldSeen,
      );
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
  overriddenSeen: Set<string>,
  toolProfileWithheldSeen: Set<string>,
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
  let tier: ResolveRoleTier | undefined;
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
    tier = resolution.tier;
  } else {
    // Deterministic, not classified: `tier` stays undefined, which
    // `toolProfileIsEvidenceBased` treats as evidence on its own.
    role = resolveLeaderRole(policy);
  }
  const episodeCaller = callerAgentId ?? ROOT_AGENT_CALLER;

  // A guessed role (tier 3/4) may still pick a model below; it may not take
  // tools away unless the operator opted in. Withholding only matters — and
  // only gets logged — when the role's own profile would actually have
  // restricted something.
  let toolProfile: ToolProfile = role.toolProfile;
  if (!toolProfileIsEvidenceBased(tier, policy) && role.toolProfile.kind !== "unrestricted") {
    const dedupeKey = `${episodeCaller} ${role.id}`;
    if (!toolProfileWithheldSeen.has(dedupeKey)) {
      toolProfileWithheldSeen.add(dedupeKey);
      options.onToolProfileWithheld?.({ callerAgentId: episodeCaller, roleId: role.id, tier: tier as ResolveRoleTier });
    }
    toolProfile = DEFAULT_TOOL_PROFILE;
  }

  // Tool enforcement is independent of model selection: a role can have no
  // configured models (so no rewrite) and still be restricted to reading, or
  // to pure delegation.
  const enforcedProviderOptions = enforceToolProfile(request, toolProfile);

  const catalog = options.catalogCache.get();
  const { pool } = options.poolCache.get();

  // Model refs use provider-family ids; a request's current provider may
  // instead be a literal pool-worker/leader entry id. Used below both for a
  // pinned selection's crossesFamily check and for the caller's own
  // explicit request, if any.
  const requestedFamily = familyOfProvider(pool, request.config.provider);

  // Precedence: an explicitly requested model wins when it's a member of the
  // resolved role's own pool AND currently selectable — the same bar ordered
  // selection holds every other candidate to (catalog presence, a viable
  // pool member, the Fable budget gate). Honoring a configured-but-capped
  // model would spawn the agent onto an account with no budget left, which
  // is the exact failure this exists to prevent. Anything else (including
  // "nothing requested") falls through to normal selection below; when that
  // means overriding a real request, the override must be visible rather
  // than silent (onExplicitModelOverridden + a label on the created agent),
  // never just a silent model swap.

  const requestedModel = request.config.model;
  const requestedRef = requestedModel ? `${request.config.provider}/${requestedModel}` : undefined;
  let explicitOverrideReason: ExplicitModelOverriddenEpisode["reason"] | undefined;
  if (requestedModel && role.models.length > 0) {
    const evaluation = evaluateRequestedModel(role, requestedFamily, requestedModel, catalog, pool, options.health, {
      modelBudgetThresholdPct: policy.modelBudgetThresholdPct,
    });
    if (evaluation.eligible) {
      return withToolProfile(request, enforcedProviderOptions);
    }
    explicitOverrideReason = evaluation.configured ? "not-currently-selectable" : "not-approved";
  }

  const outcome = selectModel(role, catalog, pool, options.health, {
    modelBudgetThresholdPct: policy.modelBudgetThresholdPct,
  });

  if (outcome.outcome === "unconfigured") {
    return withToolProfile(request, enforcedProviderOptions);
  }

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

  if (!explicitOverrideReason) {
    return { ...request, config: nextConfig };
  }

  // The caller's explicit request didn't win — either it was never approved
  // for this role, or it was approved but isn't selectable right now — and
  // policy ran instead. Visible, not silent: logged once per
  // (caller, role, requested ref), and recorded on the agent itself so the
  // UI can show "model chosen by policy" instead of a quiet swap.
  const overriddenDedupeKey = `${episodeCaller} ${role.id} ${requestedRef}`;
  if (!overriddenSeen.has(overriddenDedupeKey)) {
    overriddenSeen.add(overriddenDedupeKey);
    options.onExplicitModelOverridden?.({
      callerAgentId: episodeCaller,
      roleId: role.id,
      requestedRef: requestedRef as string,
      effectiveRef: formatModelRef(outcome),
      reason: explicitOverrideReason,
    });
  }
  return {
    ...request,
    config: nextConfig,
    labels: { ...extended.labels, [MODEL_OVERRIDDEN_LABEL]: requestedRef as string },
  };
}
