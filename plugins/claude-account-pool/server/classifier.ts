import {
  AGENT_TYPE_LABEL,
  POOL_FAMILY,
  TASK_CLASS_LABEL,
  classModels,
  type RoleModelPolicy,
  type RoleRecord,
  type TaskClassId,
} from "../shared/role-policy-schema";
import { DEFAULT_TOOL_PROFILE, profileDeniedTools, type ToolProfile } from "../shared/tool-profiles";
import {
  selectPoolAccount,
  usablePoolMembers,
  type AccountPool,
  type AccountSelectHealth,
  type AccountSelection,
} from "./account-select";
import {
  evaluateRequestedModel,
  familyOfProvider,
  formatModelRef,
  selectModel,
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
 * should this agent be" — role, task class, model, account, tools — from
 * everything known at `agent.create`.
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
}

/**
 * The live state a decision is made against. Every field is a snapshot the
 * caller reads; the classifier never fetches anything itself.
 */
interface ClassifierWorldBase {
  policy: RoleModelPolicy;
  catalog: ModelCatalog;
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
  /** The ordered pool the decision came from. */
  pool: readonly string[];
  /** Which pool that was. Names the `classModels` fallback an operator otherwise misreads as "my Hard pool is ignored". */
  poolSlot: ModelPoolSlot;
  /** True when `poolSlot` is `standard` because the class's own pool is empty. */
  fellBackToStandardPool: boolean;
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
   * - `exhausted` — every pooled account is out of budget; the create is refused.
   * - `no-pool` — this request isn't pool-family, or has no caller, so the
   *   account router leaves it alone.
   * - `not-evaluated` — no `nowMs` was supplied, so no account was chosen.
   */
  kind: "worker" | "leader" | "exhausted" | "no-pool" | "not-evaluated";
  providerId?: string;
  /** Every pooled entry that could serve this request. One means isolation has collapsed. */
  usableProviderIds?: string[];
  reason: string;
}

export interface AgentDecision {
  role: RoleDecision;
  taskClass: TaskClassDecision;
  model: ModelDecision;
  tools: ToolDecision;
  account: AccountDecision;
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
  const base = {
    pool,
    poolSlot: slot,
    fellBackToStandardPool: fellBack,
    crossesRequestedFamily: false,
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

  const thresholdOptions = { modelBudgetThresholdPct: world.policy.modelBudgetThresholdPct, taskClass };
  let overrideReason: "not-approved" | "not-currently-selectable" | undefined;
  if (input.requestedModel) {
    const evaluation = evaluateRequestedModel(
      role,
      requestedFamily,
      input.requestedModel,
      world.catalog,
      world.pool,
      world.health,
      thresholdOptions,
    );
    if (evaluation.eligible) {
      return {
        ...base,
        outcome: "honored-request",
        provider: input.requestedProvider ?? null,
        model: input.requestedModel,
        reason: `${requestedRef} was asked for, ${poolPhrase(slot, fellBack)} approves it, and it is selectable right now — so it runs as requested.`,
      };
    }
    overrideReason = evaluation.configured ? "not-currently-selectable" : "not-approved";
  }

  const outcome = selectModel(role, world.catalog, world.pool, world.health, thresholdOptions);
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
      ? { requestedRef, effectiveRef, reason: overrideReason }
      : undefined;

  const overrideNote = override
    ? override.reason === "not-approved"
      ? ` ${requestedRef} was asked for, but ${poolPhrase(slot, fellBack)} does not approve it, so policy chose instead.`
      : ` ${requestedRef} was asked for and is approved, but is not selectable right now (capped, budget-gated, or missing from the catalog), so policy chose instead.`
    : "";

  const crossesRequestedFamily = outcome.provider !== null && outcome.provider !== requestedFamily;

  if (outcome.outcome === "unavailable") {
    return {
      ...base,
      crossesRequestedFamily,
      outcome: "unavailable",
      provider: outcome.provider,
      model: outcome.model,
      ...(override ? { override } : {}),
      reason: `No entry in ${poolPhrase(slot, fellBack)} is selectable right now, so its first entry ${effectiveRef} is used anyway rather than dropping the spawn.${overrideNote}`,
    };
  }

  return {
    ...base,
    crossesRequestedFamily,
    outcome: "selected",
    provider: outcome.provider,
    model: outcome.model,
    ...(override ? { override } : {}),
    reason: `${effectiveRef} is the first selectable entry in ${poolPhrase(slot, fellBack)}.${overrideNote}`,
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
 * The account half. Only pool-family creates made BY an agent are routed —
 * a human-started agent and a `codex/gpt-5` child both keep the account they
 * were given (see server/router.ts, which owns the episodes and the refusal
 * built on this answer).
 */
function decideAccount(
  input: ClassifierInput,
  world: ClassifierWorld,
  model: ModelDecision,
  hasCaller: boolean,
): AccountDecision {
  const effectiveProvider = model.provider ?? input.requestedProvider ?? POOL_FAMILY;
  const family = familyOfProvider(world.pool, effectiveProvider);
  if (!hasCaller) {
    return { kind: "no-pool", reason: "A root agent keeps the account it was started on; the pool only routes agent-spawned children." };
  }
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

  return { role: roleDecision, taskClass, model, tools, account };
}
