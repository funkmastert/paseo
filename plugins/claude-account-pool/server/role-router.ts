import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import {
  AGENT_TYPE_LABEL,
  MODEL_OVERRIDDEN_LABEL,
  TOOLS_DENIED_LABEL,
  UNADVERTISED_MODEL_LABEL,
  classModels,
  type RoleModelPolicy,
  type RoleRecord,
  type TaskClassId,
} from "../shared/role-policy-schema";
import { restrictionNotice } from "../shared/restriction-notice";
import {
  applyToolProfile,
  DEFAULT_TOOL_PROFILE,
  profileDeniedTools,
  serializeDeniedTools,
  type ToolProfile,
} from "../shared/tool-profiles";
import type { HealthTracker } from "./health";
import { createLogThrottle } from "./log-throttle";
import type { ModelCatalogCache } from "./model-catalog";
import type { PoolCache } from "./pool";
import type { RecentAgentTypes } from "./recent-agent-types";
import type { PolicyCache } from "./role-policy";
import type { ProviderIdCache } from "./router";
import { evaluateRequestedModel, familyOfProvider, formatModelRef, selectModel } from "./role-availability";
import type { ParentToolProfiles } from "./parent-profiles";
import { resolveLeaderRole, resolveRole, resolveTaskClass, type ResolveRoleTier } from "./role-resolve";

/** Stands in for `callerAgentId` in notifications about a root agent, which has none. */
const ROOT_AGENT_CALLER = "(root agent)";

export interface DeclaredRoleUnknownEpisode {
  callerAgentId: string;
  value: string;
}

/** Fired when labels[paseo.task-class] didn't match mechanical/standard/hard. Mirrors DeclaredRoleUnknownEpisode. */
export interface DeclaredTaskClassUnknownEpisode {
  callerAgentId: string;
  value: string;
}

export interface RoleUnavailableEpisode {
  callerAgentId: string;
  roleId: string;
  requestedModel: string;
  /** The pool that was exhausted — undefined ("standard") means role.models itself. */
  taskClass?: TaskClassId;
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

export interface ParentProfileUnresolvedEpisode {
  callerAgentId: string;
  roleId: string;
  /**
   * "directory-cold": no agent-directory sweep has succeeded yet (plugin just
   * started). Fails OPEN — there is no directory for the parent to be absent
   * from, and this is the same posture every other cache here takes before
   * its first refresh.
   * "not-in-directory": a sweep DID succeed and the caller wasn't in it, even
   * though a live agent is by definition making this create. That is a
   * genuinely unknowable parent, so it fails SAFE.
   */
  reason: "directory-cold" | "not-in-directory";
  /** Whether the child was given the read-only floor as a result. */
  failedSafe: boolean;
}

export interface ExplicitModelOverriddenEpisode {
  callerAgentId: string;
  roleId: string;
  /** The `provider/model` the caller explicitly asked for. */
  requestedRef: string;
  /** What policy ran instead, spelled the same way. */
  effectiveRef: string;
  /** The task class the request was evaluated against — undefined ("standard") means role.models. */
  taskClass?: TaskClassId;
  /**
   * "not-approved": the requested ref was never one of the role's configured
   * entries — the role forbids it outright.
   * "not-currently-selectable": the requested ref IS one of the role's
   * configured entries, but isn't selectable right now (catalog-missing, no
   * viable pool member, or gated by the Fable budget threshold) — the
   * caller asked for something approved that just isn't available.
   */
  reason: "not-approved" | "not-currently-selectable";
  /**
   * True when the refusal is specifically that the model is absent from the
   * advertised catalog and not in `allowUnlistedModels` — the one refusal an
   * operator can lift. Lets the log say how, instead of leaving them to
   * guess whether the model is capped or merely unadvertised.
   */
  missingFromCatalog?: boolean;
}

export interface UnadvertisedModelAllowedEpisode {
  callerAgentId: string;
  roleId: string;
  /**
   * "explicit": the caller named a model the catalog doesn't list.
   * "pool": ordered selection picked an unlisted pool entry as the role's
   * default. Both are honored only because `allowUnlistedModels` names the id.
   */
  source: "explicit" | "pool";
  /** The `provider/model` (or bare model) that will run and that the catalog doesn't list. */
  ref: string;
  /** The task class the request was evaluated against — undefined ("standard") means role.models. */
  taskClass?: TaskClassId;
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
  /** Called (deduplicated per caller+value) when a caller declared an unrecognized labels[paseo.task-class] value. */
  onDeclaredTaskClassUnknown?: (episode: DeclaredTaskClassUnknownEpisode) => void;
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
   * Called (deduplicated per caller+role+class+ref+source) when a model absent
   * from the advertised catalog is going to run because the operator listed it
   * in `allowUnlistedModels` — an explicit request or a pool default. The
   * provider never confirmed it; this is the only record, beyond the label on
   * the agent, that it was let through.
   */
  onUnadvertisedModelAllowed?: (episode: UnadvertisedModelAllowedEpisode) => void;
  /**
   * The parent-restriction map that makes profile inheritance possible.
   * Optional: without it the router behaves exactly as it did before
   * inheritance existed, which keeps this file testable without a daemon and
   * keeps a wiring mistake from silently changing routing. index.server.ts
   * always supplies it.
   */
  parentProfiles?: ParentToolProfiles;
  /** Called (deduplicated per caller) when a caller's own restrictions could not be determined. */
  onParentProfileUnresolved?: (episode: ParentProfileUnresolvedEpisode) => void;
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
 * Everything a tool profile writes into a create request. Both fields are
 * undefined when the profile restricts nothing, so the request can pass
 * through byte-identical.
 *
 * `providerOptions` carries both halves: `disallowedTools` plus the
 * `--settings` deny tier are the enforcement; `providerOptions.appendSystemPrompt`
 * is the disclosure — a restriction the agent only discovers by hitting it
 * costs a whole turn and then invites it to route around the denial, which is
 * the most expensive failure mode this feature has (see
 * shared/restriction-notice.ts). There is no `initialPrompt` field here
 * anymore: the daemon discards a hook's mutation of it (it's read-only
 * context by the time this hook runs), so writing one was dead code that
 * never reached the agent.
 */
interface ToolEnforcement {
  providerOptions: ProviderOptionsValue | undefined;
  /**
   * The request's labels rewritten to record what was denied, or undefined
   * when they already say the right thing (the overwhelmingly common case:
   * nothing denied, no label present).
   */
  labels: Record<string, string> | undefined;
}

/**
 * What a tool profile should write into a request, or nothing at all when it
 * restricts nothing. Takes the profile directly rather than a role, since
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
  inherited: readonly string[],
): ToolEnforcement {
  const own = profileDeniedTools(toolProfile);
  const inheritedExtras = inherited.filter((tool) => !own.includes(tool));
  const effective = [...own, ...inheritedExtras];
  const extended = request as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  const notice = restrictionNotice(effective, { inherited: inheritedExtras.length > 0 });
  return {
    providerOptions: applyToolProfile(request.config.providerOptions, toolProfile, inheritedExtras, notice) as
      | ProviderOptionsValue
      | undefined,
    labels: toolDenialLabels(extended.labels, effective),
  };
}

/**
 * The labels a request should carry so the agent it creates records what was
 * denied to it, or undefined when they already do.
 *
 * Writes the label when something was denied and STRIPS a caller-supplied one
 * when nothing was — a caller that pre-set it would otherwise leave a child
 * claiming restrictions the hook never applied, and the record has to mean
 * exactly what the hook did. Returns undefined when neither applies, so an
 * ordinary unrestricted create stays byte-identical.
 */
function toolDenialLabels(
  labels: Record<string, string> | undefined,
  denied: readonly string[],
): Record<string, string> | undefined {
  const current = labels?.[TOOLS_DENIED_LABEL];
  const next = denied.length > 0 ? serializeDeniedTools(denied) : undefined;
  if (current === next) {
    return undefined;
  }
  const result = { ...labels };
  if (next === undefined) {
    delete result[TOOLS_DENIED_LABEL];
  } else {
    result[TOOLS_DENIED_LABEL] = next;
  }
  return result;
}

/**
 * Whether any configured role restricts anything at all. Gates the parent
 * lookup: with every role unrestricted (the shipped default, and Tyler's
 * live config) no agent can ever have been restricted, so there is nothing
 * to inherit and the common path does no work and issues no RPC.
 */
function policyRestrictsAnything(policy: RoleModelPolicy): boolean {
  return policy.roles.some((role) => profileDeniedTools(role.toolProfile).length > 0);
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

/** True when enforcement has nothing to write and the request can pass through byte-identical. */
function isNoOp(enforcement: ToolEnforcement): boolean {
  return enforcement.providerOptions === undefined && enforcement.labels === undefined;
}

/** Applies tool enforcement alone, on the paths that skip the model rewrite. */
function withToolProfile(
  request: PluginBeforeRequests["agent.create"],
  enforcement: ToolEnforcement,
): PluginBeforeRequests["agent.create"] | void {
  if (isNoOp(enforcement)) {
    return;
  }
  const next: PluginBeforeRequests["agent.create"] = { ...request };
  if (enforcement.providerOptions) {
    next.config = { ...request.config, providerOptions: enforcement.providerOptions };
  }
  const extended = next as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  if (enforcement.labels !== undefined) {
    extended.labels = enforcement.labels;
  }
  return next;
}

/**
 * `before("agent.create")` handler: resolves the caller's role from
 * labels/title/initialPrompt, selects that role's top eligible model against
 * the live catalog + pool health, and rewrites `config.model` (and
 * `config.provider` only when the selection crosses provider families).
 * and merges the role's tool profile into `config.providerOptions`.
 *
 * A restrictive profile also carries a short notice naming what was denied
 * and what to do instead, via `providerOptions.appendSystemPrompt` — a
 * Paseo-owned key the fork's `buildOptions()` folds into the agent's actual
 * system prompt (`providers/claude/agent.ts`), so it persists across every
 * turn rather than just the first message. Telling an agent up front is far
 * cheaper than letting it discover the denial by hitting it — see
 * shared/restriction-notice.ts. An unrestricted profile writes neither
 * `providerOptions` nor a label.
 *
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
  const declaredTaskClassUnknownSeen = new Set<string>();
  const unavailableRoleIds = new Set<string>();
  const overriddenSeen = new Set<string>();
  const unadvertisedSeen = new Set<string>();
  const toolProfileWithheldSeen = new Set<string>();
  const parentUnresolvedSeen = new Set<string>();
  const logThrottle = createLogThrottle({ now: options.now });

  return function routeRoleForCreate(input) {
    try {
      return routeRoleForCreateUnguarded(
        input,
        options,
        declaredUnknownSeen,
        declaredTaskClassUnknownSeen,
        unavailableRoleIds,
        overriddenSeen,
        unadvertisedSeen,
        toolProfileWithheldSeen,
        parentUnresolvedSeen,
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
  declaredTaskClassUnknownSeen: Set<string>,
  unavailableRoleIds: Set<string>,
  overriddenSeen: Set<string>,
  unadvertisedSeen: Set<string>,
  toolProfileWithheldSeen: Set<string>,
  parentUnresolvedSeen: Set<string>,
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

  // Task class is orthogonal to role (see resolveTaskClass's own doc
  // comment): it picks HOW MUCH MODEL the work is worth, not WHO runs it, so
  // it's resolved for every create — including a root/leader one — the same
  // way, from the same labels/title/initialPrompt. It only ever influences
  // model selection below; it never touches tool enforcement.
  const taskClassResolution = resolveTaskClass({
    labels: extended.labels,
    title: request.config.title,
    initialPrompt: extended.initialPrompt,
  });
  const taskClass = taskClassResolution.taskClass;
  if (taskClassResolution.unknownDeclaredValue !== undefined) {
    const dedupeKey = `${episodeCaller} ${taskClassResolution.unknownDeclaredValue}`;
    if (!declaredTaskClassUnknownSeen.has(dedupeKey)) {
      declaredTaskClassUnknownSeen.add(dedupeKey);
      options.onDeclaredTaskClassUnknown?.({ callerAgentId: episodeCaller, value: taskClassResolution.unknownDeclaredValue });
    }
  }

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

  // A child is never less restricted than its parent. Without this, the
  // `create_agent` that `orchestrator` and `read-only` keep on purpose is an
  // escape hatch: spawn an unrestricted worker, have it do the writing.
  // Gated on the policy restricting SOMETHING, so an all-unrestricted config
  // (the default, and today's live one) does no lookup and issues no RPC.
  let inherited: readonly string[] = [];
  if (callerAgentId && options.parentProfiles && policyRestrictsAnything(policy)) {
    const lookup = options.parentProfiles.lookup(callerAgentId);
    if (lookup.status === "known") {
      inherited = lookup.denied;
    } else {
      // "cold" fails open, "unknown" fails safe. The asymmetry is deliberate:
      // a cold cache says nothing about this parent, while a parent missing
      // from a directory that DID load is a contradiction (a live agent is
      // making this create), and granting a clean child on a contradiction is
      // exactly the silent escalation inheritance exists to stop. The floor
      // is `read-only`, not `orchestrator`, so a wrongly-restricted child can
      // still investigate and say so — and the restriction notice tells it to.
      const failedSafe = lookup.status === "unknown";
      if (failedSafe) {
        inherited = profileDeniedTools({ kind: "read-only" });
      }
      if (!parentUnresolvedSeen.has(callerAgentId)) {
        parentUnresolvedSeen.add(callerAgentId);
        options.onParentProfileUnresolved?.({
          callerAgentId,
          roleId: role.id,
          reason: failedSafe ? "not-in-directory" : "directory-cold",
          failedSafe,
        });
      }
    }
  }

  // Tool enforcement is independent of model selection: a role can have no
  // configured models (so no rewrite) and still be restricted to reading, or
  // to pure delegation.
  const enforcement = enforceToolProfile(request, toolProfile, inherited);

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
  //
  // One exception to the catalog half of that bar: an approved model the
  // catalog doesn't list is honored when the operator put it in
  // `allowUnlistedModels`. It is honored loudly (onUnadvertisedModelAllowed +
  // a label), never just quietly let through, and only on this explicit path —
  // selectModel below never sees the allowlist.

  // One dedupe + notify for both routes an unlisted model can take (explicit
  // request, pool default), so neither can run unannounced.
  const noteUnadvertised = (source: "explicit" | "pool", ref: string): void => {
    const dedupeKey = `${episodeCaller} ${role.id} ${taskClass ?? "standard"} ${source} ${ref}`;
    if (unadvertisedSeen.has(dedupeKey)) {
      return;
    }
    unadvertisedSeen.add(dedupeKey);
    options.onUnadvertisedModelAllowed?.({ callerAgentId: episodeCaller, roleId: role.id, source, ref, taskClass });
  };

  const requestedModel = request.config.model;
  const requestedRef = requestedModel ? `${request.config.provider}/${requestedModel}` : undefined;
  let explicitOverrideReason: ExplicitModelOverriddenEpisode["reason"] | undefined;
  let explicitMissingFromCatalog = false;
  if (requestedModel && classModels(role, taskClass).length > 0) {
    const evaluation = evaluateRequestedModel(role, requestedFamily, requestedModel, catalog, pool, options.health, {
      modelBudgetThresholdPct: policy.modelBudgetThresholdPct,
      allowUnlistedModels: policy.allowUnlistedModels,
      taskClass,
    });
    if (evaluation.eligible) {
      const honored = withToolProfile(request, enforcement);
      if (!evaluation.unadvertised) {
        return honored;
      }
      noteUnadvertised("explicit", requestedRef as string);
      const base = (honored ?? request) as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
      return { ...base, labels: { ...base.labels, [UNADVERTISED_MODEL_LABEL]: requestedRef as string } };
    }
    explicitMissingFromCatalog = evaluation.missingFromCatalog === true;
    explicitOverrideReason = evaluation.configured ? "not-currently-selectable" : "not-approved";
  }

  const outcome = selectModel(role, catalog, pool, options.health, {
    modelBudgetThresholdPct: policy.modelBudgetThresholdPct,
    allowUnlistedModels: policy.allowUnlistedModels,
    taskClass,
  });

  if (outcome.outcome === "unconfigured") {
    return withToolProfile(request, enforcement);
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
  // Deduped per (role, task class): a mechanical-pool exhaustion and a
  // hard-pool exhaustion on the same role are different, actionable facts —
  // fixing one must not silently suppress the notification for the other.
  const unavailableDedupeKey = `${role.id}:${taskClass ?? "standard"}`;
  if (crossesFamily) {
    const pinnedProvider = outcome.provider as string; // crossesFamily implies a pinned (non-null) provider.
    const registeredProviderIds = options.providerIds?.get();
    if (registeredProviderIds && !registeredProviderIds.has(pinnedProvider)) {
      if (!unavailableRoleIds.has(unavailableDedupeKey)) {
        unavailableRoleIds.add(unavailableDedupeKey);
        options.onRoleUnavailable?.({
          callerAgentId: episodeCaller,
          roleId: role.id,
          requestedModel: formatModelRef(outcome),
          taskClass,
          reason: "provider-not-registered",
        });
      }
      // Recovered, not blocked: skip the model rewrite but keep enforcing the
      // role's tools — a vanished model target is no reason to hand an
      // orchestrator a shell.
      return withToolProfile(request, enforcement);
    }
  }

  if (outcome.outcome === "unavailable") {
    if (!unavailableRoleIds.has(unavailableDedupeKey)) {
      unavailableRoleIds.add(unavailableDedupeKey);
      options.onRoleUnavailable?.({
        callerAgentId: episodeCaller,
        roleId: role.id,
        requestedModel: formatModelRef(outcome),
        taskClass,
        reason: "no-eligible-model",
      });
    }
  } else {
    unavailableRoleIds.delete(unavailableDedupeKey); // Re-arm: this (role, class) recovered.
  }

  const nextConfig: AgentCreateConfig = { ...request.config, model: outcome.model };
  if (crossesFamily && outcome.provider !== null) {
    nextConfig.provider = outcome.provider as AgentCreateConfig["provider"];
  }
  if (enforcement.providerOptions) {
    nextConfig.providerOptions = enforcement.providerOptions;
  }

  const routed: PluginBeforeRequests["agent.create"] = { ...request, config: nextConfig };
  const routedExtended = routed as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  if (enforcement.labels !== undefined) {
    routedExtended.labels = enforcement.labels;
  }

  // An unlisted pool entry ran as the role's default: same disclosure as an
  // explicit one. It runs for every spawn of this role/class, so it must be
  // impossible to miss that the provider never confirmed it.
  const extraLabels: Record<string, string> = {};
  if (outcome.unadvertised) {
    noteUnadvertised("pool", formatModelRef(outcome));
    extraLabels[UNADVERTISED_MODEL_LABEL] = formatModelRef(outcome);
  }

  if (explicitOverrideReason) {
    // The caller's explicit request didn't win — either it was never approved
    // for this role's resolved task class, or it was approved but isn't
    // selectable right now — and policy ran instead. Visible, not silent:
    // logged once per (caller, role, task class, requested ref), and recorded
    // on the agent itself so the UI can show "model chosen by policy" instead
    // of a quiet swap. This is exactly the "asked for Opus, got Sonnet" case —
    // role-model-policy.explain (queried with the same taskClass) reports the
    // same reason on demand.
    const overriddenDedupeKey = `${episodeCaller} ${role.id} ${taskClass ?? "standard"} ${requestedRef}`;
    if (!overriddenSeen.has(overriddenDedupeKey)) {
      overriddenSeen.add(overriddenDedupeKey);
      options.onExplicitModelOverridden?.({
        callerAgentId: episodeCaller,
        roleId: role.id,
        requestedRef: requestedRef as string,
        effectiveRef: formatModelRef(outcome),
        taskClass,
        reason: explicitOverrideReason,
        ...(explicitMissingFromCatalog ? { missingFromCatalog: true } : {}),
      });
    }
    extraLabels[MODEL_OVERRIDDEN_LABEL] = requestedRef as string;
  }

  if (Object.keys(extraLabels).length === 0) {
    return routed;
  }
  return { ...routed, labels: { ...(enforcement.labels ?? extended.labels), ...extraLabels } };
}
