import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import {
  AGENT_TYPE_LABEL,
  MODEL_OVERRIDDEN_LABEL,
  THINKING_OVERRIDDEN_LABEL,
  TOOLS_DENIED_LABEL,
  UNADVERTISED_MODEL_LABEL,
  type RoleModelPolicy,
  type TaskClassId,
} from "../shared/role-policy-schema";
import { restrictionNotice } from "../shared/restriction-notice";
import { ULTRACODE_OPTION_ID } from "../shared/thinking-levels";
import { applyToolProfile, profileDeniedTools, serializeDeniedTools, type ToolProfile } from "../shared/tool-profiles";
import { classifyAgent, type AgentDecision, type ClassifierWorld } from "./classifier";
import type { DecisionLog, LoggedRequest } from "./decision-log";
import type { HealthTracker } from "./health";
import { createLogThrottle } from "./log-throttle";
import type { ModelCatalogCache } from "./model-catalog";
import type { PoolCache } from "./pool";
import type { RecentAgentTypes } from "./recent-agent-types";
import type { PolicyCache } from "./role-policy";
import type { ProviderIdCache } from "./router";
import { formatModelRef } from "./role-availability";
import type { ParentToolProfiles } from "./parent-profiles";
import type { ResolveRoleTier } from "./role-resolve";
import type { McpGatewayCache } from "./mcp-gateway-cache";
import { withMcpScope } from "./mcp-scope-enforcement";

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

/** Fired when labels[paseo.mcp] named servers no gateway server is called. Mirrors DeclaredTaskClassUnknownEpisode. */
export interface DeclaredMcpUnknownEpisode {
  callerAgentId: string;
  values: string[];
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
   * viable pool member, or gated by the model budget threshold) — the
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

/** Fired when a caller's explicit `config.thinkingOptionId` request didn't win. Mirrors `ExplicitModelOverriddenEpisode`. */
export interface ThinkingOverriddenEpisode {
  callerAgentId: string;
  roleId: string;
  /** The effective model the decision was made for, spelled like `formatModelRef`. Absent when no model was known at all. */
  modelRef?: string;
  /** The option id the caller explicitly requested. */
  requested: string;
  /** What ran instead. `null` when the requested id was removed and nothing replaced it. */
  applied: string | null;
  /**
   * "leader-rule": the leader tier's level outranks a request.
   * "subagent-no-ultracode": a subagent asked for Ultra Code, which only a
   * leader runs. "not-advertised": the model doesn't offer the requested id,
   * so it was clamped. "no-thinking-options": the model offers none, so the
   * request was removed.
   */
  reason: "leader-rule" | "subagent-no-ultracode" | "not-advertised" | "no-thinking-options";
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
   * The daemon's MCP gateway servers, for the MCP half of the decision.
   * Optional: without it every agent keeps every server, as before scoping.
   */
  mcpGatewayCache?: Pick<McpGatewayCache, "get">;
  /** Called (deduplicated per caller+values) when labels[paseo.mcp] named something no gateway server is called. */
  onDeclaredMcpUnknown?: (episode: DeclaredMcpUnknownEpisode) => void;
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
  /** Called (deduped per caller+modelRef+requested+applied) when a caller's explicit `thinkingOptionId` request was overridden by policy. */
  onThinkingOverridden?: (episode: ThinkingOverriddenEpisode) => void;
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
   * Where the classifier's decision is noted for the one-line-per-create log.
   * The line itself is written by the account router's hook, once the account
   * that actually runs is known (see server/decision-log.ts).
   */
  decisionLog?: DecisionLog;
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
 * Everything a tool decision writes into a create request. Both fields are
 * undefined when nothing was denied, so the request can pass through
 * byte-identical.
 *
 * `providerOptions` carries both halves: `disallowedTools` plus the
 * `--settings` deny tier are the enforcement; `providerOptions.appendSystemPrompt`
 * is the disclosure — a restriction the agent only discovers by hitting it
 * costs a whole turn and then invites it to route around the denial, which is
 * the most expensive failure mode this feature has (see
 * shared/restriction-notice.ts). There is no `initialPrompt` field here: the
 * daemon discards a hook's mutation of it (it's read-only context by the time
 * this hook runs), so writing one was dead code that never reached the agent.
 */
interface ToolEnforcement {
  providerOptions: ProviderOptionsValue | undefined;
  /**
   * The request's labels rewritten to record what was denied, or undefined
   * when they already say the right thing (the overwhelmingly common case:
   * nothing denied, no label present).
   */
  labels: Record<string, string> | undefined;
  /**
   * The output style to write to `config.outputStyle`, or undefined when there
   * is none to add. A protocol-level field rather than a `providerOptions` key
   * on purpose: an older daemon's hook re-parse drops an unknown `config` key,
   * so the child simply runs without the style, whereas its strictly validated
   * `providerOptions` would reject the create.
   */
  outputStyle: string | undefined;
}

/**
 * Turns the classifier's tool decision into request fields. It decides WHAT
 * is denied (profile, withholding, inheritance — see server/classifier.ts);
 * this only writes it down.
 *
 * The cast is the same structural read the rest of this file uses: the wire
 * schema for `providerOptions` is free-form JSON, and the profile merge only
 * ever produces string arrays and nested objects.
 */
function enforceToolDecision(
  request: PluginBeforeRequests["agent.create"],
  tools: AgentDecision["tools"],
  outputStyle: AgentDecision["outputStyle"],
): ToolEnforcement {
  const extended = request as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  const notice = restrictionNotice(tools.deniedTools, { inherited: tools.inheritedTools.length > 0 });
  return {
    providerOptions: applyToolProfile(request.config.providerOptions, tools.profile, tools.inheritedTools, notice) as
      | ProviderOptionsValue
      | undefined,
    labels: toolDenialLabels(extended.labels, tools.deniedTools),
    // Written on every path that writes tool enforcement, and only when it changes something.
    outputStyle:
      outputStyle.style !== null && outputStyle.style !== request.config.outputStyle ? outputStyle.style : undefined,
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

/** True when enforcement has nothing to write and the request can pass through byte-identical. */
function isNoOp(enforcement: ToolEnforcement): boolean {
  return (
    enforcement.providerOptions === undefined &&
    enforcement.labels === undefined &&
    enforcement.outputStyle === undefined
  );
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
  if (enforcement.outputStyle !== undefined) {
    next.config = { ...next.config, outputStyle: enforcement.outputStyle };
  }
  const extended = next as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  if (enforcement.labels !== undefined) {
    extended.labels = enforcement.labels;
  }
  return next;
}

/**
 * What a thinking decision writes into a create request: a `config.thinkingOptionId`
 * patch (undefined means leave it alone), and the `THINKING_OVERRIDDEN_LABEL`
 * value when the caller's own request didn't win. Both undefined means
 * nothing to change, mirroring `ToolEnforcement`'s no-op shape.
 */
interface ThinkingEnforcement {
  configPatch: { action: "set"; value: string } | { action: "remove" } | undefined;
  /** The label VALUE to write, present only when `AgentDecision["thinking"]["override"]` is set. Add-only, mirroring `MODEL_OVERRIDDEN_LABEL`: there is nothing to strip on recovery, since an override is a fact about THIS create, not an inherited restriction. */
  overriddenLabel: string | undefined;
}

/**
 * Turns the classifier's thinking decision into request fields. It decides
 * WHAT the option id should be (server/classifier.ts's `decideThinking`);
 * this only writes it down, comparing against the request's OWN
 * `thinkingOptionId` so an unchanged decision produces no patch at all.
 */
function enforceThinkingDecision(
  currentThinkingOptionId: string | undefined,
  thinking: AgentDecision["thinking"],
): ThinkingEnforcement {
  let configPatch: ThinkingEnforcement["configPatch"];
  if (thinking.optionId !== null) {
    if (thinking.optionId !== currentThinkingOptionId) {
      configPatch = { action: "set", value: thinking.optionId };
    }
  } else if (thinking.override && currentThinkingOptionId !== undefined) {
    // A requested id the decision removed: the model offers no thinking
    // options, or a subagent asked for Ultra Code and nothing lower could be
    // verified. Without an override, null only means nothing was asked for
    // and nothing is known — so there is nothing to touch.
    configPatch = { action: "remove" };
  }
  return { configPatch, overriddenLabel: thinking.override?.requested };
}

/**
 * The subagent invariant, on the two paths that return a request WITHOUT
 * applying a thinking decision: the provider-not-registered recovery and the
 * never-block catch. A subagent never runs Ultra Code, including when routing
 * gave up or broke. With no verified model to clamp against, the id is
 * removed rather than replaced, so the provider's own no-effort default runs.
 * Returns undefined when there is nothing to remove.
 */
function withoutSubagentUltracode(
  request: PluginBeforeRequests["agent.create"],
): PluginBeforeRequests["agent.create"] | undefined {
  const extended = request as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  if (!extended.callerAgentId || request.config.thinkingOptionId !== ULTRACODE_OPTION_ID) {
    return undefined;
  }
  const next = withThinkingDecision(request, {
    configPatch: { action: "remove" },
    overriddenLabel: ULTRACODE_OPTION_ID,
  });
  return next ?? undefined;
}

/** Applies a `ThinkingEnforcement`'s config patch. Returns `config` itself, unchanged, when there is nothing to apply. */
function applyThinkingConfigPatch(config: AgentCreateConfig, patch: ThinkingEnforcement["configPatch"]): AgentCreateConfig {
  if (!patch) {
    return config;
  }
  if (patch.action === "set") {
    return { ...config, thinkingOptionId: patch.value };
  }
  const next = { ...config };
  delete next.thinkingOptionId;
  return next;
}

/** Applies thinking enforcement alone, on the paths that skip the model rewrite. Mirrors `withToolProfile`. */
function withThinkingDecision(
  request: PluginBeforeRequests["agent.create"],
  enforcement: ThinkingEnforcement,
): PluginBeforeRequests["agent.create"] | void {
  if (enforcement.configPatch === undefined && enforcement.overriddenLabel === undefined) {
    return;
  }
  const next: PluginBeforeRequests["agent.create"] = { ...request };
  if (enforcement.configPatch) {
    next.config = applyThinkingConfigPatch(request.config, enforcement.configPatch);
  }
  if (enforcement.overriddenLabel !== undefined) {
    const extended = next as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
    extended.labels = { ...extended.labels, [THINKING_OVERRIDDEN_LABEL]: enforcement.overriddenLabel };
  }
  return next;
}

/**
 * `before("agent.create")` handler. It no longer decides anything: it reads
 * the caches into a `ClassifierWorld`, asks `classifyAgent` (server/classifier.ts)
 * what this agent should be, and then WRITES that decision onto the request —
 * `config.model`, `config.provider` on a cross-family selection, the tool
 * profile merged into `config.providerOptions`, and the labels recording
 * what happened. The same function answers `role-model-policy.explain` and
 * the classifier MCP tool, so the preview and the hook cannot disagree.
 *
 * What stays here, because none of it is a classification:
 *  - the episode notifications and their per-(caller, role, class) dedup;
 *  - the provider-registry check before committing a cross-family rewrite;
 *  - the never-block contract (every failure mode is a passthrough).
 *
 * A restrictive profile also carries a short notice naming what was denied
 * and what to do instead, via `providerOptions.appendSystemPrompt` — a
 * Paseo-owned key the fork's `buildOptions()` folds into the agent's actual
 * system prompt (`providers/claude/agent.ts`), so it persists across every
 * turn rather than just the first message. Telling an agent up front is far
 * cheaper than letting it discover the denial by hitting it — see
 * shared/restriction-notice.ts.
 *
 * Must be registered BEFORE the account-pool's own router — this hook never
 * changes *which account*; the account router (unmodified) still decides
 * that, off the same ladder the classifier reports from (server/account-select.ts).
 */
export function createRoleRouter(options: RoleRouterOptions): RoleCreateRouter {
  const declaredUnknownSeen = new Set<string>();
  const declaredTaskClassUnknownSeen = new Set<string>();
  const unavailableRoleIds = new Set<string>();
  const overriddenSeen = new Set<string>();
  const unadvertisedSeen = new Set<string>();
  const thinkingOverriddenSeen = new Set<string>();
  const toolProfileWithheldSeen = new Set<string>();
  const parentUnresolvedSeen = new Set<string>();
  const declaredMcpUnknownSeen = new Set<string>();
  const logThrottle = createLogThrottle({ now: options.now });

  return function routeRoleForCreate(input) {
    try {
      const decided: DecisionHolder = {};
      const routed = routeRoleForCreateUnguarded(
        input,
        options,
        decided,
        declaredUnknownSeen,
        declaredTaskClassUnknownSeen,
        unavailableRoleIds,
        overriddenSeen,
        unadvertisedSeen,
        thinkingOverriddenSeen,
        toolProfileWithheldSeen,
        parentUnresolvedSeen,
      );
      return applyMcpDecision(input.request, routed, decided.decision, options, declaredMcpUnknownSeen);
    } catch (error) {
      // Defense-in-depth on the never-block contract: every code path below
      // is meant to fail open already, but a throw anywhere in classification
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
      // Untouched except for the one thing no failure may let through: a
      // subagent running Ultra Code.
      try {
        return withoutSubagentUltracode(input.request);
      } catch {
        return undefined;
      }
    }
  };
}

/**
 * The caller's own denials, as the classifier's `callerDenials` input.
 *
 * Gated on the policy restricting SOMETHING: with an all-unrestricted config
 * (the default, and today's live one) no agent can ever have been restricted,
 * so this does no lookup and issues no RPC.
 */
function callerDenialsFor(
  options: RoleRouterOptions,
  policy: RoleModelPolicy,
  callerAgentId: string | undefined,
): ClassifierWorld["callerDenials"] {
  if (!callerAgentId || !options.parentProfiles || !policyRestrictsAnything(policy)) {
    return undefined;
  }
  const lookup = options.parentProfiles.lookup(callerAgentId);
  return lookup.status === "known" ? { status: "known", denied: lookup.denied } : { status: lookup.status };
}

/** The output style the request itself already sets, if any. */
function requestedOutputStyleOf(request: PluginBeforeRequests["agent.create"]): string | undefined {
  const style = request.config.outputStyle;
  return typeof style === "string" && style.length > 0 ? style : undefined;
}

/** Where the unguarded router leaves its decision for the MCP step that runs after it. */
interface DecisionHolder {
  decision?: AgentDecision;
}

/**
 * Applies the MCP half of the decision to whatever the rest of the router
 * returned. Kept outside the router's many return paths so every one of
 * them gets it, including the recovered and honored ones.
 */
function applyMcpDecision(
  request: PluginBeforeRequests["agent.create"],
  routed: PluginBeforeRequests["agent.create"] | void,
  decision: AgentDecision | undefined,
  options: RoleRouterOptions,
  declaredMcpUnknownSeen: Set<string>,
): PluginBeforeRequests["agent.create"] | void {
  if (!decision) {
    return routed;
  }
  const unknown = decision.mcp.unknownDeclaredValues;
  if (unknown) {
    const caller = (request as PluginBeforeRequests["agent.create"] & RequestWithRoleFields).callerAgentId ?? ROOT_AGENT_CALLER;
    const dedupeKey = `${caller} ${unknown.join(",")}`;
    if (!declaredMcpUnknownSeen.has(dedupeKey)) {
      declaredMcpUnknownSeen.add(dedupeKey);
      options.onDeclaredMcpUnknown?.({ callerAgentId: caller, values: unknown });
    }
  }
  const base = routed ?? request;
  return withMcpScope(base, decision.mcp) ?? routed;
}

function routeRoleForCreateUnguarded(
  input: { request: PluginBeforeRequests["agent.create"] },
  options: RoleRouterOptions,
  decided: DecisionHolder,
  declaredUnknownSeen: Set<string>,
  declaredTaskClassUnknownSeen: Set<string>,
  unavailableRoleIds: Set<string>,
  overriddenSeen: Set<string>,
  unadvertisedSeen: Set<string>,
  thinkingOverriddenSeen: Set<string>,
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

  if (callerAgentId) {
    const agentTypeKey = extended.labels?.[AGENT_TYPE_LABEL] ?? request.config.title ?? undefined;
    if (agentTypeKey) {
      options.recentAgentTypes.record(agentTypeKey);
    }
  }

  const { pool } = options.poolCache.get();
  // `nowMs` is deliberately omitted: the ACCOUNT half of the decision belongs
  // to the account router, which runs next and owns the pool-dry/collapse/
  // exhaustion episodes. Asking for it here would compute an answer nobody
  // acts on — and a second answer is exactly what this refactor removes.
  const decision = classifyAgent(
    {
      labels: extended.labels,
      title: request.config.title,
      initialPrompt: extended.initialPrompt,
      callerAgentId,
      requestedProvider: request.config.provider,
      requestedModel: request.config.model,
      requestedThinkingOptionId: request.config.thinkingOptionId,
      requestedOutputStyle: requestedOutputStyleOf(request),
    },
    {
      policy,
      catalog: options.catalogCache.get(),
      thinkingCatalog: options.catalogCache.getThinking(),
      pool,
      health: options.health,
      callerDenials: callerDenialsFor(options, policy, callerAgentId),
      mcpGateway: options.mcpGatewayCache?.get(),
    },
  );
  decided.decision = decision;

  options.decisionLog?.note(request as unknown as LoggedRequest, decision);

  const role = decision.role.role;
  const taskClass = decision.taskClass.taskClass;
  const episodeCaller = callerAgentId ?? ROOT_AGENT_CALLER;

  if (decision.role.unknownDeclaredValue !== undefined && callerAgentId) {
    const dedupeKey = `${callerAgentId} ${decision.role.unknownDeclaredValue}`;
    if (!declaredUnknownSeen.has(dedupeKey)) {
      declaredUnknownSeen.add(dedupeKey);
      options.onDeclaredRoleUnknown?.({ callerAgentId, value: decision.role.unknownDeclaredValue });
    }
  }

  if (decision.taskClass.unknownDeclaredValue !== undefined) {
    const dedupeKey = `${episodeCaller} ${decision.taskClass.unknownDeclaredValue}`;
    if (!declaredTaskClassUnknownSeen.has(dedupeKey)) {
      declaredTaskClassUnknownSeen.add(dedupeKey);
      options.onDeclaredTaskClassUnknown?.({
        callerAgentId: episodeCaller,
        value: decision.taskClass.unknownDeclaredValue,
      });
    }
  }

  if (decision.tools.withheld && decision.role.tier !== undefined) {
    const dedupeKey = `${episodeCaller} ${role.id}`;
    if (!toolProfileWithheldSeen.has(dedupeKey)) {
      toolProfileWithheldSeen.add(dedupeKey);
      options.onToolProfileWithheld?.({ callerAgentId: episodeCaller, roleId: role.id, tier: decision.role.tier });
    }
  }

  if (decision.tools.inheritanceUnresolved && callerAgentId) {
    if (!parentUnresolvedSeen.has(callerAgentId)) {
      parentUnresolvedSeen.add(callerAgentId);
      options.onParentProfileUnresolved?.({
        callerAgentId,
        roleId: role.id,
        reason: decision.tools.inheritanceUnresolved.reason,
        failedSafe: decision.tools.inheritanceUnresolved.failedSafe,
      });
    }
  }

  // One dedupe + notify for both routes an unlisted model can take (an
  // explicit request, a pool default), so neither can run unannounced.
  const noteUnadvertised = (source: "explicit" | "pool", ref: string): void => {
    const dedupeKey = `${episodeCaller} ${role.id} ${taskClass ?? "standard"} ${source} ${ref}`;
    if (unadvertisedSeen.has(dedupeKey)) {
      return;
    }
    unadvertisedSeen.add(dedupeKey);
    options.onUnadvertisedModelAllowed?.({ callerAgentId: episodeCaller, roleId: role.id, source, ref, taskClass });
  };

  // Deduped per (caller, effective model, requested id, applied id): the same
  // fact logged once, not once per create that repeats it.
  const noteThinkingOverridden = (
    modelRef: string | undefined,
    requested: string,
    applied: string | null,
    reason: ThinkingOverriddenEpisode["reason"],
  ): void => {
    const dedupeKey = `${episodeCaller} ${modelRef ?? "(unknown model)"} ${requested} ${applied}`;
    if (thinkingOverriddenSeen.has(dedupeKey)) {
      return;
    }
    thinkingOverriddenSeen.add(dedupeKey);
    options.onThinkingOverridden?.({
      callerAgentId: episodeCaller,
      roleId: role.id,
      ...(modelRef !== undefined ? { modelRef } : {}),
      requested,
      applied,
      reason,
    });
  };

  const enforcement = enforceToolDecision(request, decision.tools, decision.outputStyle);

  // Tool enforcement is independent of model selection: a role can have no
  // configured models (so no rewrite) and still be restricted to reading, or
  // to pure delegation. An explicitly requested model that policy honors is
  // the same shape — nothing to rewrite, tools still applied. The thinking
  // decision applies here too: an honored/unconfigured model still has an
  // effective model (its own, since nothing was rewritten) worth deciding a
  // level for.
  if (decision.model.outcome === "unconfigured" || decision.model.outcome === "honored-request") {
    let honored = withToolProfile(request, enforcement);
    const thinkingEnforcement = enforceThinkingDecision(request.config.thinkingOptionId, decision.thinking);
    const withThinking = withThinkingDecision(honored ?? request, thinkingEnforcement);
    if (withThinking) {
      honored = withThinking;
    }
    if (decision.thinking.override) {
      noteThinkingOverridden(
        decision.thinking.modelRef,
        decision.thinking.override.requested,
        decision.thinking.override.applied,
        decision.thinking.override.reason,
      );
    }
    // An honored request for a model the catalog doesn't list runs on the
    // operator's say-so alone, so it is honored LOUDLY — never just quietly
    // let through. (`unconfigured` never carries this: nothing was selected.)
    if (!decision.model.unadvertised) {
      return honored;
    }
    noteUnadvertised(decision.model.unadvertised.source, decision.model.unadvertised.ref);
    const base = (honored ?? request) as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
    return { ...base, labels: { ...base.labels, [UNADVERTISED_MODEL_LABEL]: decision.model.unadvertised.ref } };
  }

  const modelRef = formatModelRef({ provider: decision.model.provider, model: decision.model.model as string });

  // Deduped per (role, task class): a mechanical-pool exhaustion and a
  // hard-pool exhaustion on the same role are different, actionable facts —
  // fixing one must not silently suppress the notification for the other.
  const unavailableDedupeKey = `${role.id}:${taskClass ?? "standard"}`;

  // Cross-family rewrites point `config.provider` at a family the account
  // router (router.ts) never gets a chance to validate — it only checks
  // claude-family targets against the provider registry. A family removed
  // from daemon config since the role was configured would otherwise
  // produce a request the daemon can never launch. Verify against the
  // same registry snapshot before committing to the switch; same-family
  // selections (the common case) skip this, since that family is already
  // the one in active use.
  if (decision.model.crossesRequestedFamily) {
    const pinnedProvider = decision.model.provider as string; // crossesRequestedFamily implies a pinned provider.
    const registeredProviderIds = options.providerIds?.get();
    if (registeredProviderIds && !registeredProviderIds.has(pinnedProvider)) {
      if (!unavailableRoleIds.has(unavailableDedupeKey)) {
        unavailableRoleIds.add(unavailableDedupeKey);
        options.onRoleUnavailable?.({
          callerAgentId: episodeCaller,
          roleId: role.id,
          requestedModel: modelRef,
          taskClass,
          reason: "provider-not-registered",
        });
      }
      // Recovered, not blocked: skip the model rewrite but keep enforcing the
      // role's tools — a vanished model target is no reason to hand an
      // orchestrator a shell. The thinking decision is skipped too:
      // `decision.thinking` was decided for the model the rewrite just gave
      // up on, and a level meant for a model this create will never run must
      // not land on it. The subagent invariant still holds.
      const recovered = withToolProfile(request, enforcement);
      const guarded = withoutSubagentUltracode(recovered ?? request);
      if (guarded) {
        // Named against the model that runs — the request's own — not the one the rewrite gave up on.
        const runningRef = request.config.model
          ? formatModelRef({ provider: request.config.provider ?? null, model: request.config.model })
          : undefined;
        noteThinkingOverridden(runningRef, ULTRACODE_OPTION_ID, null, "subagent-no-ultracode");
      }
      return guarded ?? recovered;
    }
  }

  if (decision.model.outcome === "unavailable") {
    if (!unavailableRoleIds.has(unavailableDedupeKey)) {
      unavailableRoleIds.add(unavailableDedupeKey);
      options.onRoleUnavailable?.({
        callerAgentId: episodeCaller,
        roleId: role.id,
        requestedModel: modelRef,
        taskClass,
        reason: "no-eligible-model",
      });
    }
  } else {
    unavailableRoleIds.delete(unavailableDedupeKey); // Re-arm: this (role, class) recovered.
  }

  const nextConfig: AgentCreateConfig = { ...request.config, model: decision.model.model };
  if (decision.model.crossesRequestedFamily && decision.model.provider !== null) {
    nextConfig.provider = decision.model.provider as AgentCreateConfig["provider"];
  }
  if (enforcement.providerOptions) {
    nextConfig.providerOptions = enforcement.providerOptions;
  }
  if (enforcement.outputStyle !== undefined) {
    nextConfig.outputStyle = enforcement.outputStyle;
  }
  const thinkingEnforcement = enforceThinkingDecision(request.config.thinkingOptionId, decision.thinking);
  if (thinkingEnforcement.configPatch?.action === "set") {
    nextConfig.thinkingOptionId = thinkingEnforcement.configPatch.value;
  } else if (thinkingEnforcement.configPatch?.action === "remove") {
    delete nextConfig.thinkingOptionId;
  }

  const routed: PluginBeforeRequests["agent.create"] = { ...request, config: nextConfig };
  const routedExtended = routed as PluginBeforeRequests["agent.create"] & RequestWithRoleFields;
  if (enforcement.labels !== undefined) {
    routedExtended.labels = enforcement.labels;
  }

  // Two independent facts can need recording on one agent: an unlisted model
  // running as the pool default, and an explicit request policy overrode.
  const extraLabels: Record<string, string> = {};

  // An unlisted pool entry ran as the role's default: same disclosure as an
  // explicit one. It runs for every spawn of this role/class, so it must be
  // impossible to miss that the provider never confirmed it.
  if (decision.model.unadvertised) {
    noteUnadvertised(decision.model.unadvertised.source, decision.model.unadvertised.ref);
    extraLabels[UNADVERTISED_MODEL_LABEL] = decision.model.unadvertised.ref;
  }

  const override = decision.model.override;
  if (override) {
    // The caller's explicit request didn't win — either it was never approved
    // for this role's resolved task class, or it was approved but isn't
    // selectable right now — and policy ran instead. Visible, not silent:
    // logged once per (caller, role, task class, requested ref), and recorded
    // on the agent itself so the UI can show "model chosen by policy" instead
    // of a quiet swap. This is exactly the "asked for Opus, got Sonnet" case —
    // role-model-policy.explain (queried with the same taskClass) reports the
    // same reason on demand, because it asks the same classifier.
    const overriddenDedupeKey = `${episodeCaller} ${role.id} ${taskClass ?? "standard"} ${override.requestedRef}`;
    if (!overriddenSeen.has(overriddenDedupeKey)) {
      overriddenSeen.add(overriddenDedupeKey);
      options.onExplicitModelOverridden?.({
        callerAgentId: episodeCaller,
        roleId: role.id,
        requestedRef: override.requestedRef,
        effectiveRef: override.effectiveRef,
        taskClass,
        reason: override.reason,
        ...(override.missingFromCatalog ? { missingFromCatalog: true } : {}),
      });
    }
    extraLabels[MODEL_OVERRIDDEN_LABEL] = override.requestedRef;
  }

  if (thinkingEnforcement.overriddenLabel !== undefined && decision.thinking.override) {
    noteThinkingOverridden(
      decision.thinking.modelRef,
      decision.thinking.override.requested,
      decision.thinking.override.applied,
      decision.thinking.override.reason,
    );
    extraLabels[THINKING_OVERRIDDEN_LABEL] = thinkingEnforcement.overriddenLabel;
  }

  if (Object.keys(extraLabels).length === 0) {
    return routed;
  }
  return { ...routed, labels: { ...(enforcement.labels ?? extended.labels), ...extraLabels } };
}

/** Re-exported so existing importers of the router's tool types keep working. */
export type { ToolProfile };
