import {
  AGENT_TYPE_LABEL,
  POOL_FAMILY,
  TASK_CLASS_LABEL,
  LEADER_ROLE_ID,
  classModels,
  type RoleModelPolicy,
  type RoleRecord,
  type TaskClassId,
} from "../shared/role-policy-schema";
import { DEFAULT_TOOL_PROFILE, profileDeniedTools, type ToolProfile } from "../shared/tool-profiles";
import {
  clampThinkingOption,
  THINKING_LEVEL_LABELS,
  ULTRACODE_EFFORT_OPTION_ID,
  ULTRACODE_OPTION_ID,
  type ThinkingClampHow,
  type ThinkingLevelId,
} from "../shared/thinking-levels";
import {
  describeRootSelection,
  selectPoolAccount,
  selectRootAccount,
  usablePoolMembers,
  type AccountPool,
  type AccountSelectHealth,
  type AccountSelection,
} from "./account-select";
import type { ThinkingCatalog } from "./model-catalog";
import {
  evaluateRequestedModel,
  familyOfProvider,
  formatModelRef,
  selectModel,
  unadvertisedPoolEntries,
  type AvailabilityHealth,
  type ModelCatalog,
} from "./role-availability";
import {
  resolveLeaderRole,
  resolveRole,
  resolveTaskClass,
  type ClassificationMatch,
  type ResolveRoleTier,
  type TaskClassSource,
} from "./role-resolve";

/**
 * THE classifier. One deterministic function answering the whole of "what
 * should this agent be" — role, task class, model, thinking level, account,
 * tools — from everything known at `agent.create`.
 *
 * Every consumer calls this and only this: the `before("agent.create")` hook
 * (server/role-router.ts), the `role-model-policy.explain` RPC
 * (server/role-policy-rpc-handlers.ts, which the settings preview renders),
 * and the MCP tool an agent can ask before it spawns
 * (server/classifier-tool.ts). A second implementation of any part of this —
 * "the preview does roughly the same thing" — is the bug this file exists to
 * remove. They had drifted twice: the preview reported a role's configured
 * tool profile for a guessed role the hook would have WITHHELD, and it
 * classified from the title alone while the hook classified from title plus
 * prompt.
 *
 * ## Determinism
 *
 * No clock, no randomness, no I/O, no LLM. Everything time-dependent or
 * remote is an argument: the policy document, the model catalog, pool health,
 * the caller's inherited denials, and `nowMs`. Same `ClassifierInput` +
 * `ClassifierWorld` in, same `AgentDecision` out, forever — which is what
 * makes a decision replayable from a log line and testable without a daemon.
 * An LLM classifier was evaluated and rejected on arithmetic: this runs on
 * every create, and a model call there would add latency and cost to the one
 * code path that must add neither.
 *
 * ## Explicit beats inferred
 *
 * At every level. A label the caller set outranks a mapping, which outranks
 * anything read out of free text, which outranks the default.
 *
 * ## Inference may choose a model; it may never remove capability
 *
 * Tool profiles come only from explicit evidence (a `paseo.agent-type`
 * mapping, a `paseo.agent-role` label) or the structural leader tier, where
 * no guessing happened at all. A role guessed from prompt text may still pick
 * a model — a wrong guess costs some quality — but may not take Edit/Write/
 * Bash away, which is how a prompt containing the word "check" once stripped
 * an implementation agent to read-only and cost 1.1M tokens. Settled; see
 * `toolProfileIsEvidenceBased`.
 *
 * ## Nothing silent
 *
 * Every part of the decision carries a `reason` — a whole sentence, written
 * for the person reading it in a notification or the settings preview, not a
 * code. No caller should have to learn its configuration by hitting a wall.
 */

export interface ClassifierInput {
  /** Labels on the create request: `paseo.agent-role`, `paseo.agent-type`, `paseo.task-class`. */
  labels?: Record<string, string>;
  title?: string | null;
  initialPrompt?: string;
  /**
   * The agent that asked for this one. ABSENT means a ROOT agent — one a
   * human, the CLI, the app, a schedule or a heartbeat started — which is
   * the leader by definition rather than by classification.
   */
  callerAgentId?: string;
  /** `config.provider` as requested: a provider family id, or a literal pool entry id. */
  requestedProvider?: string;
  /** `config.model` as requested, when the caller named one. */
  requestedModel?: string;
  /** `config.thinkingOptionId` as requested, when the caller named one. */
  requestedThinkingOptionId?: string;
  /** `config.outputStyle` as requested, when the caller set one. */
  requestedOutputStyle?: string;
}

/**
 * The live state a decision is made against. Every field is a snapshot the
 * caller reads; the classifier never fetches anything itself.
 */
interface ClassifierWorldBase {
  policy: RoleModelPolicy;
  catalog: ModelCatalog;
  /**
   * Every model's advertised thinking options, from the same `listModels`
   * poll that builds `catalog` (server/model-catalog.ts). Required, so a
   * consumer that forgets to wire it up is a type error rather than a silent
   * `model-unknown` on every decision.
   */
  thinkingCatalog: ThinkingCatalog;
  pool: AccountPool;
  /**
   * What the CALLER was itself denied, so a child is never less restricted
   * than its parent. `known` carries the list; `cold` (no agent-directory
   * sweep has succeeded yet) fails open; `unknown` (a sweep succeeded and the
   * caller wasn't in it — a contradiction, since a live agent is making this
   * create) fails safe onto the read-only floor. Omitted entirely means the
   * caller isn't tracking inheritance, which behaves like `cold`.
   */
  callerDenials?: { status: "known"; denied: readonly string[] } | { status: "cold" } | { status: "unknown" };
}

/**
 * The live state a decision is made against. Every field is a snapshot the
 * caller reads; the classifier never fetches anything itself.
 *
 * The union is how "you may only ask for an account if you brought what
 * decides one" becomes a type error rather than a convention: `nowMs` is the
 * instant to score account headroom against, and supplying it obliges you to
 * supply the health API the ladder walks. Leaving both out is the create
 * hook's case — it deliberately doesn't decide the account, because the
 * account router runs next and owns that, episodes and all.
 */
export type ClassifierWorld = ClassifierWorldBase &
  (
    | { health: AvailabilityHealth; nowMs?: undefined }
    | { health: AvailabilityHealth & AccountSelectHealth; nowMs: number }
  );

export type RoleSource =
  /** Root agent: the leader by structure, with no classification involved. */
  | "leader-tier"
  /** Tier 1: `paseo.agent-type` (or the title as its fallback key) matched `agentTypeMappings`. */
  | "agent-type-mapping"
  /** Tier 2: `paseo.agent-role` matched a configured role name or alias. */
  | "declared-label"
  /** Tier 3: a configured role's own name/alias appeared in the title/prompt text. */
  | "classified-vocabulary"
  /** Tier 3: a built-in seed keyword matched the title/prompt text. */
  | "classified-seed"
  /** Tier 4: nothing to classify, so the worker default. */
  | "default";

export interface RoleDecision {
  role: RoleRecord;
  source: RoleSource;
  /**
   * The numeric tier, kept because it is what `enforceToolsOnClassifiedRoles`
   * and the explain wire format have always spoken. `undefined` is the leader
   * tier — evidence in its own right, not a missing value.
   */
  tier: ResolveRoleTier | undefined;
  /** Whether this role may set tools, not just a model. See the file header. */
  evidenceBased: boolean;
  reason: string;
  /** Set when `paseo.agent-role` named something no role owns. Never blocks. */
  unknownDeclaredValue?: string;
}

export interface TaskClassDecision {
  /** Undefined means "no class resolved": the role's standard pool, exactly as before task classes existed. */
  taskClass: TaskClassId | undefined;
  source: TaskClassSource;
  reason: string;
  /** Set when `paseo.task-class` named something outside mechanical/standard/hard. Never blocks. */
  unknownDeclaredValue?: string;
}

/** Which of a role's three pools actually decided the model. */
export type ModelPoolSlot = "standard" | "mechanical" | "hard";

export interface ModelDecision {
  /**
   * - `unconfigured` — the resolved pool is empty, so the request's own model
   *   stands and the hook must not touch it.
   * - `honored-request` — the caller named a model, and it is approved for
   *   this (role, class) and selectable right now.
   * - `selected` — ordered selection picked one.
   * - `unavailable` — every entry in the pool was gated out, so its first
   *   entry is used anyway. Routing problems get recovered, never used to
   *   skip a requested subagent.
   */
  outcome: "unconfigured" | "honored-request" | "selected" | "unavailable";
  /** Null for an account-agnostic ref: the pool picks the account (see `account`). */
  provider: string | null;
  /** Absent only when `outcome` is `unconfigured`. */
  model?: string;
  /**
   * Set when the model that runs is the catalog's spelling of a differently
   * spelled pool entry, so `model` is not what the policy wrote: a dated
   * snapshot (`claude-haiku-4-5-20251001`) whose alias the provider lists.
   * The value is the pool's own spelling.
   */
  resolvedFrom?: string;
  /** The ordered pool the decision came from. */
  pool: readonly string[];
  /** Which pool that was. Names the `classModels` fallback an operator otherwise misreads as "my Hard pool is ignored". */
  poolSlot: ModelPoolSlot;
  /** True when `poolSlot` is `standard` because the class's own pool is empty. */
  fellBackToStandardPool: boolean;
  /**
   * Set when the model that will run is absent from the provider's advertised
   * catalog and is running only because `allowUnlistedModels` names it. The
   * provider never confirmed the id, so no consumer may treat this as
   * ordinary: the create hook logs it and labels the agent
   * `paseo.model-unadvertised`, and the preview says UNVERIFIED. `source`
   * distinguishes the caller asking for it from the pool defaulting to it —
   * a pool default runs for every spawn of that (role, class), which is the
   * louder of the two.
   */
  unadvertised?: { source: "explicit" | "pool"; ref: string };
  /**
   * Refs in this pool that ordered selection SKIPS because the catalog
   * doesn't list them and `allowUnlistedModels` doesn't name them. Without
   * this, a pool entry that is never chosen looks live.
   */
  unadvertisedPoolEntries: string[];
  /**
   * True when acting on this decision would move the request to a different
   * provider FAMILY than it asked for. Reported rather than left to each
   * consumer to recompute: a cross-family rewrite is the one that has to be
   * checked against the daemon's provider registry before it's committed.
   */
  crossesRequestedFamily: boolean;
  reason: string;
  /**
   * The ref the caller asked for, spelled the way the create hook spells it
   * (always provider-qualified, defaulting to the pool family). Present
   * whenever a model was requested, honored or not, so no consumer has to
   * spell it a second way.
   */
  requestedRef?: string;
  /**
   * Set when the caller named a model and policy ran something else instead.
   * Consumers make this visible rather than swapping quietly — the create
   * hook writes `paseo.model-overridden-by-policy` onto the agent, and the
   * settings preview prints the same fact.
   */
  override?: {
    requestedRef: string;
    effectiveRef: string;
    /** `not-approved`: never one of this (role, class)'s entries. `not-currently-selectable`: approved, but catalog-missing / no viable pool member / budget-gated. */
    reason: "not-approved" | "not-currently-selectable";
    /**
     * Set when the refusal is specifically "the catalog doesn't list it and
     * `allowUnlistedModels` doesn't name it" — the one refusal an operator can
     * lift, unlike a capped or budget-gated model.
     */
    missingFromCatalog?: true;
  };
}

export interface ToolDecision {
  /** The profile actually applied — `unrestricted` when a guessed role's own profile was withheld. */
  profile: ToolProfile;
  /** Everything denied at launch: the applied profile's own denials plus whatever was inherited. */
  deniedTools: string[];
  /** The subset that came from the caller rather than this role's profile. */
  inheritedTools: string[];
  reason: string;
  /** Set when the role's own profile was withheld because the role was guessed. */
  withheld?: { profile: ToolProfile; deniedTools: string[]; reason: string };
  /** Set when the caller's own denials could not be established. */
  inheritanceUnresolved?: { reason: "directory-cold" | "not-in-directory"; failedSafe: boolean };
}

export interface AccountDecision {
  /**
   * - `worker` / `leader` — the pooled account that will run it.
   * - `exhausted` — every pooled account is out of budget. A child is
   *   refused; a root keeps the account it asked for (`providerId`).
   * - `no-pool` — the account router leaves it alone: a non-pool-family
   *   request, or a root whose own account can serve it (`providerId`).
   * - `not-evaluated` — no `nowMs` was supplied, so no account was chosen.
   */
  kind: "worker" | "leader" | "exhausted" | "no-pool" | "not-evaluated";
  providerId?: string;
  /**
   * Set when a root agent's own account couldn't run it and it was moved:
   * the provider it asked for. The create hook writes the same value to
   * `paseo.account-rerouted`.
   */
  reroutedFrom?: string;
  /** Every pooled entry that could serve this request. One means isolation has collapsed. */
  usableProviderIds?: string[];
  reason: string;
}

/**
 * Which thinking-effort level the effective model runs at, decided AFTER the
 * model (`decideThinking` takes the already-decided `ModelDecision`). No
 * agent runs Ultra Code unless the policy or a root's request names it, and a
 * subagent never does. See `decideThinking` for the order the rules apply in.
 */
export interface ThinkingDecision {
  /**
   * - `leader-rule` — the leader tier's level (`policy.thinking.leader`), which
   *   outranks a requested one.
   * - `requested` — the caller named a level, and nothing outranks it.
   * - `task-class-default` — nothing was requested, so the task class's level.
   * - `no-thinking-options` — the effective model offers none; `optionId` is null.
   * - `model-unknown` — the catalog doesn't list the model's options, so no
   *   level can be verified and the request stands (minus Ultra Code, for a subagent).
   */
  outcome: "leader-rule" | "requested" | "task-class-default" | "no-thinking-options" | "model-unknown";
  /**
   * What `config.thinkingOptionId` becomes. `null` means none: the model
   * offers no thinking options, or nothing is known and nothing was asked for.
   * When `override` is also set, a null here means the requested id is removed.
   */
  optionId: string | null;
  /** The effective model this was decided for, spelled like `formatModelRef`. Absent only when no model is known at all. */
  modelRef?: string;
  /** What the leader rule, the request or the class named, before any cap or clamp. */
  wanted?: string;
  /**
   * True when this is a subagent and Ultra Code was replaced — wanted by the
   * rule or request, or reached through the model's own default. A subagent
   * never runs Ultra Code; it gets `xhigh`, the effort Ultra Code implies.
   */
  subagentCapped?: true;
  /** Set when the level (after any subagent cap) isn't one the model offers and something it does offer is used instead. */
  clamped?: { wanted: string; applied: string; how: Exclude<ThinkingClampHow, "unclamped"> };
  /** The caller's own `requestedThinkingOptionId`, when it named one — whichever outcome fired. */
  requested?: string;
  /**
   * Set when the caller's own request is not what runs: the leader rule
   * outranked it (`leader-rule`), a subagent asked for Ultra Code
   * (`subagent-no-ultracode`), the model doesn't offer it (`not-advertised`),
   * or the model offers no thinking options at all (`no-thinking-options`).
   * The create hook labels the agent `paseo.thinking-overridden-by-policy`.
   */
  override?: {
    requested: string;
    applied: string | null;
    reason: "leader-rule" | "subagent-no-ultracode" | "not-advertised" | "no-thinking-options";
  };
  reason: string;
}

/**
 * The Claude Code output style the agent runs with. Decided from the policy
 * and structure only — never from the prompt — so it is as deterministic as
 * the role of a root agent.
 */
export interface OutputStyleDecision {
  /** What `settings.outputStyle` becomes. `null` means the request is left as it is. */
  style: string | null;
  /**
   * - `policy` — the policy's child style.
   * - `requested` — the caller set one, and explicit beats inferred.
   * - `none` — nothing applies; `reason` says which of root, non-Claude or switched-off.
   */
  source: "policy" | "requested" | "none";
  reason: string;
}

export interface AgentDecision {
  role: RoleDecision;
  taskClass: TaskClassDecision;
  model: ModelDecision;
  tools: ToolDecision;
  account: AccountDecision;
  thinking: ThinkingDecision;
  outputStyle: OutputStyleDecision;
}

/** The read-only floor a child falls to when its parent's restrictions are unknowable. */
const INHERITANCE_FLOOR: ToolProfile = { kind: "read-only" };

/**
 * Whether a role's own tool profile may be enforced, or must be withheld in
 * favor of `DEFAULT_TOOL_PROFILE`.
 *
 * Tier 1 (an explicit `paseo.agent-type` mapping) and tier 2 (an explicit
 * `paseo.agent-role` label) are the caller stating its role outright.
 * `tier === undefined` is the leader tier: a root agent genuinely IS the
 * leader. Tiers 3 and 4 are guesses from free text — an implementation prompt
 * containing "check" classifies as `reviewer` exactly as readily as a real
 * review task does — so they may pick a model but not take tools away, unless
 * the operator opted in via `enforceToolsOnClassifiedRoles`.
 */
function toolProfileIsEvidenceBased(tier: ResolveRoleTier | undefined, policy: RoleModelPolicy): boolean {
  if (tier === undefined || tier === 1 || tier === 2) {
    return true;
  }
  return policy.enforceToolsOnClassifiedRoles === true;
}

/**
 * Tier -> source. Tier 3 splits on WHICH text match fired: the operator's own
 * configured vocabulary, a built-in seed pattern, or neither (worker is what
 * was left). All three still count as a guess for tool purposes.
 */
function roleSourceFor(tier: ResolveRoleTier, match: ClassificationMatch | undefined): RoleSource {
  if (tier === 1) return "agent-type-mapping";
  if (tier === 2) return "declared-label";
  if (tier === 4) return "default";
  if (match === "vocabulary") return "classified-vocabulary";
  if (match === "seed") return "classified-seed";
  return "default";
}

function describeRole(decision: Omit<RoleDecision, "reason">, input: ClassifierInput): string {
  const name = decision.role.name;
  const ignored =
    decision.unknownDeclaredValue !== undefined
      ? ` The declared role "${decision.unknownDeclaredValue}" matched no configured role name or alias, so it was ignored rather than blocking the create.`
      : "";
  switch (decision.source) {
    case "leader-tier":
      return `${name}, because this create has no calling agent — a root agent is the leader by definition, not by classification.`;
    case "agent-type-mapping":
      return `${name}, from the agent-type mapping for "${input.labels?.[AGENT_TYPE_LABEL] ?? input.title ?? ""}".`;
    case "declared-label":
      return `${name}, declared outright by the caller's paseo.agent-role label.`;
    case "classified-vocabulary":
      return `${name}, guessed from the title/prompt: one of its own configured names or aliases appears in the text. A guess picks a model but never removes a tool.${ignored}`;
    case "classified-seed":
      return `${name}, guessed from the title/prompt by a built-in seed keyword. A guess picks a model but never removes a tool.${ignored}`;
    case "default":
      return decision.tier === 3
        ? `${name}, the default: the title/prompt matched no role vocabulary and no seed keyword.${ignored}`
        : `${name}, the default: there was no label, no mapping, and no text to classify.${ignored}`;
  }
}

function describeTaskClass(decision: Omit<TaskClassDecision, "reason">): string {
  const ignored =
    decision.unknownDeclaredValue !== undefined
      ? ` The declared class "${decision.unknownDeclaredValue}" is not one of mechanical/standard/hard, so it was ignored.`
      : "";
  switch (decision.source) {
    case "declared":
      return `${decision.taskClass}, declared by the caller's ${TASK_CLASS_LABEL} label.`;
    case "classified":
      return `${decision.taskClass}, guessed from keywords in the title/prompt.${ignored}`;
    case "default":
      return `none — nothing declared or recognized one, so the role's standard pool decides.${ignored}`;
  }
}

/** Which pool `classModels` actually returned, and whether that was a fallback. */
function resolvePoolSlot(
  role: RoleRecord,
  taskClass: TaskClassId | undefined,
): { slot: ModelPoolSlot; fellBack: boolean } {
  if (taskClass === "mechanical") {
    return role.mechanicalModels.length > 0 ? { slot: "mechanical", fellBack: false } : { slot: "standard", fellBack: true };
  }
  if (taskClass === "hard") {
    return role.hardModels.length > 0 ? { slot: "hard", fellBack: false } : { slot: "standard", fellBack: true };
  }
  return { slot: "standard", fellBack: false };
}

function poolPhrase(slot: ModelPoolSlot, fellBack: boolean): string {
  if (fellBack) {
    return `the ${slot === "standard" ? "standard" : slot} pool (that class's own pool is empty, so the standard pool decided)`;
  }
  return `the ${slot} pool`;
}

/**
 * The model half: an explicit request first when it clears the same bar
 * ordered selection holds every other candidate to, then ordered selection.
 *
 * Honoring a configured-but-capped model would spawn the agent onto an
 * account with no budget left, dying on its first turn — which is the exact
 * failure this checks for, rather than just asking "is it in the list".
 */
function decideModel(
  input: ClassifierInput,
  world: ClassifierWorld,
  role: RoleRecord,
  taskClass: TaskClassId | undefined,
): ModelDecision {
  const pool = classModels(role, taskClass);
  const { slot, fellBack } = resolvePoolSlot(role, taskClass);
  const requestedFamily = familyOfProvider(world.pool, input.requestedProvider ?? POOL_FAMILY);
  const requestedRef = input.requestedModel
    ? `${input.requestedProvider ?? POOL_FAMILY}/${input.requestedModel}`
    : undefined;
  // One options object for both eligibility calls below, so an explicit
  // request and ordered selection are held to the same bar by construction —
  // including `allowUnlistedModels`, which either path can act on.
  const selectionOptions = {
    modelBudgetThresholdPct: world.policy.modelBudgetThresholdPct,
    allowUnlistedModels: world.policy.allowUnlistedModels,
    taskClass,
  };
  const base = {
    pool,
    poolSlot: slot,
    fellBackToStandardPool: fellBack,
    crossesRequestedFamily: false,
    unadvertisedPoolEntries: unadvertisedPoolEntries(role, world.catalog, taskClass, world.policy.allowUnlistedModels),
    ...(requestedRef !== undefined ? { requestedRef } : {}),
  } as const;

  if (pool.length === 0) {
    return {
      ...base,
      outcome: "unconfigured",
      provider: null,
      reason: `${role.name} has no models configured in ${poolPhrase(slot, fellBack)}, so the request's own model stands.`,
    };
  }

  let overrideReason: "not-approved" | "not-currently-selectable" | undefined;
  let missingFromCatalog = false;
  if (input.requestedModel) {
    const evaluation = evaluateRequestedModel(
      role,
      requestedFamily,
      input.requestedModel,
      world.catalog,
      world.pool,
      world.health,
      selectionOptions,
    );
    if (evaluation.eligible) {
      const unverified = evaluation.unadvertised === true;
      return {
        ...base,
        outcome: "honored-request",
        provider: input.requestedProvider ?? null,
        model: input.requestedModel,
        ...(unverified ? { unadvertised: { source: "explicit" as const, ref: requestedRef as string } } : {}),
        reason: unverified
          ? `${requestedRef} was asked for and ${poolPhrase(slot, fellBack)} approves it. The provider's catalog does not list it, so it is UNVERIFIED — it runs only because allowUnlistedModels names it.`
          : `${requestedRef} was asked for, ${poolPhrase(slot, fellBack)} approves it, and it is selectable right now — so it runs as requested.`,
      };
    }
    overrideReason = evaluation.configured ? "not-currently-selectable" : "not-approved";
    missingFromCatalog = evaluation.missingFromCatalog === true;
  }

  const outcome = selectModel(role, world.catalog, world.pool, world.health, selectionOptions);
  if (outcome.outcome === "unconfigured") {
    // Unreachable: pool.length > 0 above. Kept because selectModel's type says
    // it can, and inventing a model here would be worse than passing through.
    return {
      ...base,
      outcome: "unconfigured",
      provider: null,
      reason: `${role.name}'s pool could not be read, so the request's own model stands.`,
    };
  }

  const effectiveRef = formatModelRef(outcome);
  const override =
    overrideReason && requestedRef
      ? { requestedRef, effectiveRef, reason: overrideReason, ...(missingFromCatalog ? { missingFromCatalog: true as const } : {}) }
      : undefined;

  // Three different sentences, because they call for three different actions:
  // fix the pool, wait for capacity, or add the id to allowUnlistedModels.
  const overrideNote = override
    ? override.reason === "not-approved"
      ? ` ${requestedRef} was asked for, but ${poolPhrase(slot, fellBack)} does not approve it, so policy chose instead.`
      : missingFromCatalog
        ? ` ${requestedRef} was asked for and is approved, but the provider's catalog does not list it and allowUnlistedModels does not name it, so policy chose instead. Add it there if the provider does accept the id.`
        : ` ${requestedRef} was asked for and is approved, but is not selectable right now (capped or budget-gated), so policy chose instead.`
    : "";

  const crossesRequestedFamily = outcome.provider !== null && outcome.provider !== requestedFamily;
  // A pool default the catalog doesn't list runs for EVERY spawn of this
  // (role, class), not just the one that asked — the louder of the two ways
  // an unverified id gets used.
  const unadvertised = outcome.unadvertised
    ? { unadvertised: { source: "pool" as const, ref: effectiveRef } }
    : {};
  const unverifiedNote = outcome.unadvertised
    ? " The provider's catalog does not list it, so it is UNVERIFIED — it is selectable only because allowUnlistedModels names it."
    : "";
  // The pool's spelling and the id that runs differ: say both, so nobody
  // reads a decision for `claude-haiku-4-5` and concludes the policy's
  // dated entry was ignored.
  const resolvedField = outcome.resolvedFrom !== undefined ? { resolvedFrom: outcome.resolvedFrom } : {};
  const resolvedNote =
    outcome.resolvedFrom !== undefined
      ? ` The pool spells it ${outcome.resolvedFrom}; the provider's catalog lists it as ${outcome.model}, and that is the id that runs.`
      : "";

  if (outcome.outcome === "unavailable") {
    return {
      ...base,
      crossesRequestedFamily,
      ...unadvertised,
      ...resolvedField,
      outcome: "unavailable",
      provider: outcome.provider,
      model: outcome.model,
      ...(override ? { override } : {}),
      reason: `No entry in ${poolPhrase(slot, fellBack)} is selectable right now, so its first entry ${effectiveRef} is used anyway rather than dropping the spawn.${resolvedNote}${unverifiedNote}${overrideNote}`,
    };
  }

  return {
    ...base,
    crossesRequestedFamily,
    ...unadvertised,
    ...resolvedField,
    outcome: "selected",
    provider: outcome.provider,
    model: outcome.model,
    ...(override ? { override } : {}),
    reason: `${effectiveRef} is the first selectable entry in ${poolPhrase(slot, fellBack)}.${resolvedNote}${unverifiedNote}${overrideNote}`,
  };
}

/**
 * The tools half: the role's profile when the role was established by
 * evidence, plus whatever the caller itself was denied.
 *
 * Restrictions only ever accumulate. A child that could spawn an unrestricted
 * grandchild and have it do the writing would make `read-only` a suggestion.
 */
function decideTools(world: ClassifierWorld, role: RoleDecision, hasCaller: boolean): ToolDecision {
  let profile = role.role.toolProfile;
  let withheld: ToolDecision["withheld"];
  if (!role.evidenceBased && profile.kind !== "unrestricted") {
    withheld = {
      profile,
      deniedTools: profileDeniedTools(profile),
      reason: `${role.role.name} was guessed from text rather than declared, so its ${profile.kind} profile was withheld — inference may choose a model, never remove a capability. Set paseo.agent-role or paseo.agent-type to enforce it.`,
    };
    profile = DEFAULT_TOOL_PROFILE;
  }

  const own = profileDeniedTools(profile);
  let inherited: readonly string[] = [];
  let inheritanceUnresolved: ToolDecision["inheritanceUnresolved"];
  if (hasCaller && world.callerDenials) {
    if (world.callerDenials.status === "known") {
      inherited = world.callerDenials.denied;
    } else {
      const failedSafe = world.callerDenials.status === "unknown";
      if (failedSafe) {
        inherited = profileDeniedTools(INHERITANCE_FLOOR);
      }
      inheritanceUnresolved = { reason: failedSafe ? "not-in-directory" : "directory-cold", failedSafe };
    }
  }

  const inheritedExtras = inherited.filter((tool) => !own.includes(tool));
  const deniedTools = [...own, ...inheritedExtras];

  const inheritedNote =
    inheritedExtras.length > 0
      ? ` ${inheritedExtras.length} more come from the caller: a child is never less restricted than its parent.`
      : "";
  const unresolvedNote = inheritanceUnresolved
    ? inheritanceUnresolved.failedSafe
      ? " The caller is not in the agent directory, so what it was restricted to is unknowable; the read-only floor was applied instead of a clean profile."
      : " The agent directory has not loaded yet, so the caller's own restrictions are unknown and nothing was inherited this time."
    : "";
  const reason =
    deniedTools.length === 0
      ? `Nothing is denied: ${profile.kind === "unrestricted" ? "the applied profile is unrestricted" : `the ${profile.kind} profile removes nothing`}.${unresolvedNote}`
      : `${deniedTools.length} tools are denied under the ${profile.kind} profile.${inheritedNote}${unresolvedNote}`;

  return {
    profile,
    deniedTools,
    inheritedTools: inheritedExtras,
    reason,
    ...(withheld ? { withheld } : {}),
    ...(inheritanceUnresolved ? { inheritanceUnresolved } : {}),
  };
}

/**
 * The account half for a ROOT agent: it keeps the account it was started on
 * while that account can run it, and moves — leader account first — only when
 * that account is at a cap. Never refused. See `selectRootAccount`.
 */
function decideRootAccount(input: ClassifierInput, world: ClassifierWorld, model: ModelDecision): AccountDecision {
  // The provider the account router will actually see: the role router only
  // rewrites it for a cross-family model.
  const requestedProviderId =
    model.crossesRequestedFamily && model.provider !== null ? model.provider : (input.requestedProvider ?? POOL_FAMILY);
  if (world.nowMs === undefined) {
    return { kind: "not-evaluated", reason: "No instant was supplied, so account headroom was not scored." };
  }
  const modelId = model.model ?? input.requestedModel ?? "";
  const selection = selectRootAccount(world.pool, world.health, requestedProviderId, modelId, world.nowMs);
  const reason = describeRootSelection(selection, requestedProviderId, modelId);
  switch (selection.kind) {
    case "not-pooled":
      return { kind: "no-pool", reason };
    case "kept":
      return { kind: "no-pool", providerId: selection.providerId, reason };
    case "rerouted":
      return {
        kind: selection.target,
        providerId: selection.providerId,
        reroutedFrom: selection.from,
        usableProviderIds: usablePoolMembers(world.pool, world.health, modelId),
        reason,
      };
    case "stranded":
      return { kind: "exhausted", providerId: selection.providerId, usableProviderIds: [], reason };
  }
}

/**
 * The account half. Pool-family creates made BY an agent walk the child
 * ladder; a root agent walks its own (`decideRootAccount`); a `codex/gpt-5`
 * child keeps the account it was given. server/router.ts owns the episodes
 * and the refusal built on this answer.
 */
function decideAccount(
  input: ClassifierInput,
  world: ClassifierWorld,
  model: ModelDecision,
  hasCaller: boolean,
): AccountDecision {
  if (!hasCaller) {
    return decideRootAccount(input, world, model);
  }
  const effectiveProvider = model.provider ?? input.requestedProvider ?? POOL_FAMILY;
  const family = familyOfProvider(world.pool, effectiveProvider);
  if (family !== POOL_FAMILY) {
    return { kind: "no-pool", reason: `This is a ${family} request, and the pool only routes ${POOL_FAMILY}-family accounts.` };
  }
  if (world.nowMs === undefined) {
    return { kind: "not-evaluated", reason: "No instant was supplied, so account headroom was not scored." };
  }

  const modelId = model.model ?? "";
  const selection: AccountSelection = selectPoolAccount(world.pool, world.health, modelId, world.nowMs);
  const usable = usablePoolMembers(world.pool, world.health, modelId);
  const collapsed =
    usable.length === 1 ? " Only one pooled account can serve this — budget isolation has collapsed." : "";

  switch (selection.kind) {
    case "worker":
      return {
        kind: "worker",
        providerId: selection.providerId,
        usableProviderIds: usable,
        reason: `${selection.providerId} is the pooled worker with the most headroom for ${modelId || "this request"}.${collapsed}`,
      };
    case "leader":
      return {
        kind: "leader",
        providerId: selection.providerId,
        usableProviderIds: usable,
        reason: `No worker can run ${modelId || "this request"}, so the leader account ${selection.providerId} serves it. Isolation is gone until a worker recovers.${collapsed}`,
      };
    case "no-leader":
      return {
        kind: "no-pool",
        usableProviderIds: usable,
        reason: "No worker is usable and no leader account is configured, so the request keeps the account it was given.",
      };
    case "exhausted":
      return {
        kind: "exhausted",
        usableProviderIds: usable,
        reason: `Every pooled account is out of budget (${selection.providerIds.join(", ")}), so this spawn is refused rather than started on a dead account.`,
      };
  }
}

/** Display label for a thinking option id, falling back to the raw id for one this plugin doesn't recognize (a non-Claude provider's own token). */
function thinkingLabel(optionId: string): string {
  return THINKING_LEVEL_LABELS[optionId as ThinkingLevelId] ?? optionId;
}

/** The model the thinking decision is made against. */
interface EffectiveThinkingModel {
  modelId: string;
  family: string;
  /** Spelled like `formatModelRef`: bare when the underlying provider is null/unspecified, `provider/model` otherwise. */
  modelRef: string;
}

/**
 * The model that will actually run: the model decision's, or the request's
 * own when policy left the model alone. Same `provider ?? requestedProvider
 * ?? POOL_FAMILY` fallback `decideAccount` uses to find a family, because the
 * thinking catalog is keyed the way the account pool is.
 */
function effectiveThinkingModel(
  input: ClassifierInput,
  world: ClassifierWorld,
  model: ModelDecision,
): EffectiveThinkingModel | undefined {
  if (model.outcome === "selected" || model.outcome === "unavailable" || model.outcome === "honored-request") {
    const modelId = model.model as string; // always present for these outcomes
    return {
      modelId,
      family: familyOfProvider(world.pool, model.provider ?? input.requestedProvider ?? POOL_FAMILY),
      modelRef: formatModelRef({ provider: model.provider, model: modelId }),
    };
  }
  // `unconfigured`: no model was decided, so the request's own (if it named
  // one) is what runs.
  if (input.requestedModel) {
    return {
      modelId: input.requestedModel,
      family: familyOfProvider(world.pool, input.requestedProvider ?? POOL_FAMILY),
      modelRef: formatModelRef({ provider: input.requestedProvider ?? null, model: input.requestedModel }),
    };
  }
  return undefined;
}

/** Prose for how a level got clamped to what the model actually offers — appended to whichever outcome's reason chose it. */
function clampSentence(modelRef: string, clamp: NonNullable<ThinkingDecision["clamped"]>): string {
  const wantedLabel = thinkingLabel(clamp.wanted);
  const appliedLabel = thinkingLabel(clamp.applied);
  switch (clamp.how) {
    case "nearest-lower":
      return ` ${modelRef} does not offer ${wantedLabel}, so ${appliedLabel}, the nearest lower level it offers, is used.`;
    case "nearest-higher":
      return ` ${modelRef} does not offer ${wantedLabel}, so ${appliedLabel}, the nearest higher level it offers, is used.`;
    case "highest-effort":
      return ` ${modelRef} does not offer ${wantedLabel}, so ${appliedLabel}, the highest effort it offers, is used.`;
    case "model-default":
      return ` ${modelRef} does not recognize ${wantedLabel}, so ${appliedLabel}, its own default, is used.`;
  }
}

/**
 * One wanted level, made safe to apply. Ultra Code runs only when it is what
 * was wanted and the agent is not a subagent: a leader level or a root's
 * request that names it. Everything else is clamped to what the model offers
 * WITHOUT Ultra Code:
 *
 * - A subagent's wanted Ultra Code becomes `xhigh` first.
 * - The clamp's last resort is the model's own default. A default of Ultra
 *   Code is replaced by `xhigh` for everyone, so no agent reaches Ultra Code
 *   without asking for it by name.
 */
function resolveThinkingLevel(
  wanted: string,
  optionIds: readonly string[],
  defaultOptionId: string | undefined,
  isSubagent: boolean,
): {
  optionId: string;
  subagentCapped: boolean;
  /** A root agent's clamp fell back to the model's default, which was Ultra Code, and got `xhigh` instead. */
  defaultCapped: boolean;
  clamped?: NonNullable<ThinkingDecision["clamped"]>;
} {
  if (!isSubagent && wanted === ULTRACODE_OPTION_ID) {
    const clamp = clampThinkingOption(wanted, optionIds, defaultOptionId);
    return {
      optionId: clamp.optionId,
      subagentCapped: false,
      defaultCapped: false,
      ...(clamp.how !== "unclamped" ? { clamped: { wanted, applied: clamp.optionId, how: clamp.how } } : {}),
    };
  }

  // A subagent never gets here with a model that offers only Ultra Code (decideThinking's
  // `usable` check). A root might, and then the clamp keeps to what the model offers.
  const withoutUltracode = optionIds.filter((id) => id !== ULTRACODE_OPTION_ID);
  const allowed = withoutUltracode.length > 0 ? withoutUltracode : optionIds;
  const capDefault = defaultOptionId === ULTRACODE_OPTION_ID;
  const safeDefault = capDefault
    ? clampThinkingOption(ULTRACODE_EFFORT_OPTION_ID, allowed, undefined).optionId
    : defaultOptionId;
  const capWanted = wanted === ULTRACODE_OPTION_ID;
  const target = capWanted ? ULTRACODE_EFFORT_OPTION_ID : wanted;
  const clamp = clampThinkingOption(target, allowed, safeDefault);
  const usedCappedDefault = capDefault && clamp.how === "model-default";
  return {
    optionId: clamp.optionId,
    subagentCapped: isSubagent && (capWanted || usedCappedDefault),
    defaultCapped: !isSubagent && usedCappedDefault,
    ...(clamp.how !== "unclamped" ? { clamped: { wanted: target, applied: clamp.optionId, how: clamp.how } } : {}),
  };
}

/**
 * The thinking half: which effort level `config.thinkingOptionId` becomes.
 * Decided AFTER the model, because every rung below reads the EFFECTIVE
 * model, not the one the caller asked for.
 *
 * Order, most specific first:
 *  a. The effective model isn't in `world.thinkingCatalog`: `model-unknown`.
 *     Nothing can be verified, so the request's own level stands — except
 *     Ultra Code for a subagent, which is removed.
 *  b. The model offers no thinking options (Haiku): `no-thinking-options`.
 *     `optionId` is null, and a requested level is removed.
 *  c. The leader tier — a root agent, or one resolved to the leader role —
 *     with `policy.thinking.leader` set: `leader-rule`. It outranks a request.
 *     Ultra Code on a model that doesn't offer it becomes the highest effort
 *     that model does offer.
 *  d. A requested level: `requested`. Explicit beats inferred, so a class
 *     level never overrides it.
 *  e. The task class's level (`standard`'s when no class resolved):
 *     `task-class-default`. Always set, so every subagent whose model offers
 *     thinking leaves here with an explicit level and never falls back to
 *     the model's own default.
 *
 * A subagent never runs Ultra Code. That is an invariant, not policy: no
 * rule, policy entry or request can give a child `ultracode`
 * (`resolveThinkingLevel`). Nor does the classifier pick it for anyone on its
 * own: the leader level defaults to Extra High, and a model whose own default
 * is Ultra Code is treated as defaulting to Extra High. A root runs Ultra Code
 * only when the leader level names it, or when the leader rule is off and the
 * root asked for it. Every level from c-e is clamped to what the model
 * offers — never an id it doesn't.
 */
function decideThinking(
  input: ClassifierInput,
  world: ClassifierWorld,
  model: ModelDecision,
  taskClass: TaskClassId | undefined,
  role: RoleDecision,
  hasCaller: boolean,
): ThinkingDecision {
  const requested = input.requestedThinkingOptionId;
  const requestedField = requested !== undefined ? { requested } : {};
  const isSubagent = hasCaller;
  const effective = effectiveThinkingModel(input, world, model);
  const entry = effective ? world.thinkingCatalog.get(effective.family)?.get(effective.modelId) : undefined;

  if (!effective || !entry) {
    const unverified = effective
      ? `the provider's catalog does not list ${effective.modelRef}'s thinking options`
      : "no model was decided for this create";
    const modelRefField = effective ? { modelRef: effective.modelRef } : {};
    if (isSubagent && requested === ULTRACODE_OPTION_ID) {
      return {
        outcome: "model-unknown",
        optionId: null,
        ...modelRefField,
        requested,
        override: { requested, applied: null, reason: "subagent-no-ultracode" },
        reason: `Removed, because ${thinkingLabel(requested)} was asked for, a subagent never runs it, and ${unverified}, so no lower level can be verified in its place.`,
      };
    }
    return {
      outcome: "model-unknown",
      optionId: requested ?? null,
      ...modelRefField,
      ...requestedField,
      reason: `${requested !== undefined ? "Left as requested" : "Left unset"}, because ${unverified}, so no level can be verified for it.`,
    };
  }

  const { modelRef } = effective;
  // What this agent may run: a subagent may not run Ultra Code, so a model
  // offering nothing else offers a subagent nothing at all.
  const usable = isSubagent ? entry.optionIds.filter((id) => id !== ULTRACODE_OPTION_ID) : entry.optionIds;
  if (usable.length === 0) {
    const why =
      entry.optionIds.length === 0
        ? `${modelRef} offers no thinking options`
        : `${modelRef} offers only ${thinkingLabel(ULTRACODE_OPTION_ID)}, which a subagent never runs`;
    return {
      outcome: "no-thinking-options",
      optionId: null,
      modelRef,
      ...requestedField,
      ...(requested !== undefined
        ? { override: { requested, applied: null, reason: "no-thinking-options" as const } }
        : {}),
      reason: `None, because ${why}.${requested !== undefined ? ` ${thinkingLabel(requested)} was asked for and is removed.` : ""}`,
    };
  }

  const isLeaderTier = !hasCaller || role.role.id === LEADER_ROLE_ID;
  const leaderLevel = world.policy.thinking.leader;

  let outcome: "leader-rule" | "requested" | "task-class-default";
  let wanted: string;
  if (isLeaderTier && leaderLevel !== null) {
    outcome = "leader-rule";
    wanted = leaderLevel;
  } else if (requested !== undefined) {
    outcome = "requested";
    wanted = requested;
  } else {
    outcome = "task-class-default";
    wanted = world.policy.thinking.byTaskClass[taskClass ?? "standard"];
  }

  const level = resolveThinkingLevel(wanted, entry.optionIds, entry.defaultOptionId, isSubagent);
  const override: ThinkingDecision["override"] =
    requested !== undefined && requested !== level.optionId
      ? {
          requested,
          applied: level.optionId,
          reason:
            isSubagent && requested === ULTRACODE_OPTION_ID
              ? "subagent-no-ultracode"
              : outcome === "leader-rule"
                ? "leader-rule"
                : "not-advertised",
        }
      : undefined;

  return {
    outcome,
    optionId: level.optionId,
    modelRef,
    wanted,
    ...(level.subagentCapped ? { subagentCapped: true as const } : {}),
    ...(level.clamped ? { clamped: level.clamped } : {}),
    ...requestedField,
    ...(override ? { override } : {}),
    reason: describeThinking({ outcome, wanted, level, modelRef, taskClass, hasCaller, isSubagent, override }),
  };
}

/** The reason sentence for a decided level: what applies, why, then each thing that changed it on the way. */
function describeThinking(decision: {
  outcome: "leader-rule" | "requested" | "task-class-default";
  wanted: string;
  level: ReturnType<typeof resolveThinkingLevel>;
  modelRef: string;
  taskClass: TaskClassId | undefined;
  hasCaller: boolean;
  isSubagent: boolean;
  override: ThinkingDecision["override"];
}): string {
  const { outcome, wanted, level, modelRef, taskClass, override } = decision;
  const applied = thinkingLabel(level.optionId);
  const wantedLabel = thinkingLabel(wanted);
  const changed = level.optionId !== wanted;

  let basis: string;
  switch (outcome) {
    case "leader-rule":
      basis = `${applied}, because ${decision.hasCaller ? "this agent resolved to the leader role" : "this is a root agent, the leader by definition,"} and the policy runs leaders at ${wantedLabel}.`;
      break;
    case "requested":
      basis = changed
        ? `${applied}, because ${wantedLabel} was asked for and a requested level outranks the task class's.`
        : `${applied}, as requested: a requested level outranks the task class's.`;
      break;
    case "task-class-default": {
      const which =
        taskClass === undefined
          ? "nothing was requested and no task class resolved, so the standard task class's level"
          : `nothing was requested, so the ${taskClass} task class's level`;
      basis = `${applied}, because ${which}${changed ? `, ${wantedLabel},` : ""} applies.`;
      break;
    }
  }

  const cappedWanted = decision.isSubagent && wanted === ULTRACODE_OPTION_ID;
  const capNote = cappedWanted
    ? ` A subagent never runs ${thinkingLabel(ULTRACODE_OPTION_ID)} — only a leader orchestrates — so it gets ${thinkingLabel(ULTRACODE_EFFORT_OPTION_ID)}, the effort ${thinkingLabel(ULTRACODE_OPTION_ID)} implies.`
    : "";
  // The one cap that isn't about what was wanted: the clamp fell back to the
  // model's own default, and that default is Ultra Code.
  const clampNote = !level.clamped
    ? ""
    : level.subagentCapped && !cappedWanted
      ? ` ${modelRef} does not recognize ${thinkingLabel(level.clamped.wanted)}, and its own default, ${thinkingLabel(ULTRACODE_OPTION_ID)}, is never a subagent's, so ${applied} is used.`
      : level.defaultCapped
        ? ` ${modelRef} does not recognize ${thinkingLabel(level.clamped.wanted)}, and its own default, ${thinkingLabel(ULTRACODE_OPTION_ID)}, runs only when asked for by name, so ${applied} is used.`
        : clampSentence(modelRef, level.clamped);
  const outrankNote =
    override?.reason === "leader-rule"
      ? ` ${thinkingLabel(override.requested)} was asked for, but the leader rule outranks a requested level.`
      : "";
  return basis + capNote + clampNote + outrankNote;
}

/**
 * The output-style half. A child's narration is read by its leader, not a
 * person, and every word of it is cache the leader re-reads on every later
 * turn, so a child runs with the policy's concise style. A root agent does
 * not: the operator reads a leader. The style is a Claude Code CLI setting, so
 * it only applies to a Claude-family agent, and one the caller set itself is
 * kept.
 */
function decideOutputStyle(
  input: ClassifierInput,
  world: ClassifierWorld,
  model: ModelDecision,
  hasCaller: boolean,
): OutputStyleDecision {
  const family = familyOfProvider(world.pool, model.provider ?? input.requestedProvider ?? POOL_FAMILY);
  if (family !== POOL_FAMILY) {
    return {
      style: null,
      source: "none",
      reason: `None: this is a ${family} agent, and an output style is a Claude Code setting.`,
    };
  }
  if (input.requestedOutputStyle !== undefined) {
    return {
      style: input.requestedOutputStyle,
      source: "requested",
      reason: `${input.requestedOutputStyle}, as the caller's request set it — an explicit style is never replaced.`,
    };
  }
  if (!hasCaller) {
    return {
      style: null,
      source: "none",
      reason: "None: this is a root agent, and the operator reads a leader's narration.",
    };
  }
  const style = world.policy.childOutputStyle;
  if (style === null) {
    return { style: null, source: "none", reason: "None: the policy's child output style is switched off." };
  }
  return {
    style,
    source: "policy",
    reason: `${style}, because a subagent's narration is read by its leader rather than a person, and the policy runs children with that style.`,
  };
}

/**
 * Classify one `agent.create`. The only entry point; see the file header for
 * the properties it guarantees.
 */
export function classifyAgent(input: ClassifierInput, world: ClassifierWorld): AgentDecision {
  const hasCaller = input.callerAgentId !== undefined && input.callerAgentId !== "";

  let roleDecision: RoleDecision;
  if (hasCaller) {
    const resolution = resolveRole(world.policy, {
      labels: input.labels,
      title: input.title,
      initialPrompt: input.initialPrompt,
    });
    const source = roleSourceFor(resolution.tier, resolution.match);
    const partial = {
      role: resolution.role,
      source,
      tier: resolution.tier,
      evidenceBased: toolProfileIsEvidenceBased(resolution.tier, world.policy),
      ...(resolution.unknownDeclaredValue !== undefined
        ? { unknownDeclaredValue: resolution.unknownDeclaredValue }
        : {}),
    };
    roleDecision = { ...partial, reason: describeRole(partial, input) };
  } else {
    const partial = {
      role: resolveLeaderRole(world.policy),
      source: "leader-tier" as const,
      tier: undefined,
      evidenceBased: true,
    };
    roleDecision = { ...partial, reason: describeRole(partial, input) };
  }

  // Orthogonal to the role, and resolved for every create including a root
  // one: a role picks WHO runs the work, a task class picks HOW MUCH MODEL
  // it is worth. It only ever influences model selection — never tools.
  const classResolution = resolveTaskClass({
    labels: input.labels,
    title: input.title,
    initialPrompt: input.initialPrompt,
  });
  const classPartial = {
    taskClass: classResolution.taskClass,
    source: classResolution.source,
    ...(classResolution.unknownDeclaredValue !== undefined
      ? { unknownDeclaredValue: classResolution.unknownDeclaredValue }
      : {}),
  };
  const taskClass: TaskClassDecision = { ...classPartial, reason: describeTaskClass(classPartial) };

  const model = decideModel(input, world, roleDecision.role, taskClass.taskClass);
  const tools = decideTools(world, roleDecision, hasCaller);
  const account = decideAccount(input, world, model, hasCaller);
  const thinking = decideThinking(input, world, model, taskClass.taskClass, roleDecision, hasCaller);
  const outputStyle = decideOutputStyle(input, world, model, hasCaller);

  return { role: roleDecision, taskClass, model, tools, account, thinking, outputStyle };
}
