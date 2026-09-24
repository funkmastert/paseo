import { z } from "zod";
import { DEFAULT_TOOL_PROFILE, ToolProfileSchema } from "./tool-profiles";

/**
 * Label keys the role hook reads off `agent.create` requests. Mirrors the
 * `PARENT_AGENT_ID_LABEL` convention in `notify.ts` / `packages/protocol/src/agent-labels.ts`.
 */
export const AGENT_TYPE_LABEL = "paseo.agent-type";
export const AGENT_ROLE_LABEL = "paseo.agent-role";
/**
 * Declares how hard the caller believes this task is, independent of which
 * role it resolves to. The cheapest and most trustworthy signal there is —
 * the caller is stating what it's asking for, not leaving it to be guessed
 * from prompt text. See server/role-resolve.ts's `resolveTaskClass`.
 */
export const TASK_CLASS_LABEL = "paseo.task-class";

/**
 * Set by the role router (never read by it) when an explicitly requested
 * model wasn't a member of the resolved role's pool and policy overrode it.
 * Value is the ref the caller asked for, so the UI can show "model chosen by
 * policy (you asked for X)" instead of silently swapping the model.
 */
export const MODEL_OVERRIDDEN_LABEL = "paseo.model-overridden-by-policy";

/**
 * Set by the account router when a ROOT agent's requested pooled account was
 * out of budget and it was started on another one instead. Value is the
 * provider id the request asked for, so the UI can show "moved off
 * claude-backup" instead of silently running somewhere else. See
 * server/account-select.ts's `selectRootAccount`.
 */
export const ACCOUNT_REROUTED_LABEL = "paseo.account-rerouted";

/**
 * Set by the role router when the thinking level the caller asked for
 * (`config.thinkingOptionId`) is not the one the agent runs: the leader rule
 * outranked it, the agent is a subagent and asked for Ultra Code, or the
 * model doesn't offer that level. Value is the option id the caller asked
 * for, so the UI can show "thinking level chosen by policy (you asked for X)"
 * instead of silently swapping it. Mirrors `MODEL_OVERRIDDEN_LABEL`.
 */
export const THINKING_OVERRIDDEN_LABEL = "paseo.thinking-overridden-by-policy";

/**
 * Set by the role router when an explicitly requested model was honored even
 * though the provider's advertised catalog doesn't list it (see
 * `allowUnlistedModels`). Value is the ref the caller asked for. The model was
 * never verified, so if the agent dies at launch this label is the first thing
 * to look at.
 */
export const UNADVERTISED_MODEL_LABEL = "paseo.model-unadvertised";

/**
 * Set by the role router on every agent it restricts: the comma-separated
 * tool names that were actually denied at launch.
 *
 * This is how a restriction survives to the NEXT create. A child must be at
 * least as restricted as its parent, or `read-only` means nothing (a
 * read-only agent could just spawn an unrestricted one and have it do the
 * writing). Working that out needs the parent's applied profile, and a label
 * is the only place to keep it: `providerOptions` is accepted on
 * `agent.create` but appears in no agent snapshot the daemon will hand back,
 * so the thing that actually carries the enforcement is unreadable
 * afterwards. A label is writable by the hook, readable from
 * `AgentSnapshotPayload.labels`, and — unlike anything the plugin holds in
 * memory — survives a plugin reload and a daemon restart. That last property
 * is the deciding one: activating a plugin change reloads the plugin, so an
 * in-memory map would forget every live restricted agent at exactly the
 * moment the operator turned the feature on.
 *
 * Absence means unrestricted, and that is a fact rather than a guess: the
 * only thing that can restrict an agent here is this hook, and this hook
 * always writes the label when it restricts. An agent created while the
 * plugin was uninstalled carries no denials either.
 *
 * `mcp__paseo__update_agent` (which can rewrite labels) is denied by every
 * restrictive built-in profile, so an agent cannot erase its own record.
 */
export const TOOLS_DENIED_LABEL = "paseo.tools-denied";

/**
 * The role governing ROOT agents — creates with no `callerAgentId`, i.e. the
 * ones a human, the CLI, or the app starts. Nothing constrained those before,
 * which is exactly the agent that burned a whole weekly budget doing its
 * subagents' work itself.
 */
export const LEADER_ROLE_ID = "leader";

/** Fixed, non-renamable, non-deletable role ids. Aliases and models remain editable. */
export const STANDARD_ROLE_IDS = ["worker", "reviewer", "advisor", LEADER_ROLE_ID] as const;
export type StandardRoleId = (typeof STANDARD_ROLE_IDS)[number];

/**
 * How hard a task is, orthogonal to which role runs it: a role picks WHO
 * (worker/reviewer/advisor/...), a task class picks HOW MUCH MODEL that work
 * is worth. Fixed and small, deliberately — a taxonomy nobody can apply
 * consistently is worse than none, and three levels are enough to separate
 * "cheaper than usual", "the default", and "reach for the best model":
 *
 * - `mechanical`: rote, low-risk, narrowly-scoped (a rename, a typo, a
 *   formatting pass, a comment/changelog tweak, a dependency bump). Wrong
 *   output is cheap to spot and cheap to redo.
 * - `standard`: everyday work of ordinary, unestablished difficulty — the
 *   default. This is exactly what `RoleRecord.models` has always meant;
 *   nothing about it changes here.
 * - `hard`: real correctness or design risk (concurrency, migrations,
 *   security, architecture, cross-cutting refactors) where a cheap model's
 *   subtly-wrong answer is expensive to catch later.
 *
 * Not user-definable, unlike role names: a fixed, small, fixed-meaning enum
 * is something every caller and every operator can apply the same way, which
 * a free-text vocabulary here would not be.
 */
export const TASK_CLASS_IDS = ["mechanical", "standard", "hard"] as const;
export type TaskClassId = (typeof TASK_CLASS_IDS)[number];

/** One namespace word: a role name or alias. Case-insensitively unique across the whole policy. */
export const ROLE_WORD_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** An `agentTypeMappings` key: an exact caller-supplied agent-type/title string. */
export const EXACT_AGENT_NAME_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

/**
 * The provider family whose accounts this plugin pools. An account-agnostic
 * (bare) model ref resolves its catalog entry and its pool health against
 * this family.
 */
export const POOL_FAMILY = "claude";

/**
 * A model reference in one of two forms. No whitespace, control characters,
 * commas, wildcards, or `/` inside a segment.
 *
 * - `model` (bare) — ACCOUNT-AGNOSTIC. The role picks the model; the account
 *   router (server/router.ts) still picks which pooled account runs it. This
 *   is the form that survives one account dying.
 * - `provider/model` — PINNED to that provider id. Use it to cross provider
 *   families (`codex/gpt-5`). Note that pinning to a *claude-family* id only
 *   pins the family: the account router runs after the role router and still
 *   has the final say on which pooled account serves a claude-family request.
 */
const MODEL_REF_SEGMENT = "[^\\s,*?/\\x00-\\x1F\\x7F]+";
export const BARE_MODEL_REF_RE = new RegExp(`^${MODEL_REF_SEGMENT}$`);
export const MODEL_REF_RE = new RegExp(`^${MODEL_REF_SEGMENT}(?:/${MODEL_REF_SEGMENT})?$`);

/**
 * Percent at/above which a budget-gated model family stops being selectable
 * and a role falls to the next model in its own pool. 80 leaves a fifth of
 * the weekly window in hand, so the cap lands at a model boundary rather than
 * mid-task.
 */
export const DEFAULT_MODEL_BUDGET_THRESHOLD_PCT = 80;

export const MAX_ROLES = 64;
export const MAX_ALIASES_PER_ROLE = 8;
export const MAX_MODELS_PER_ROLE = 32;
export const MAX_MAPPINGS = 256;
export const MAX_MODEL_REF_LENGTH = 256;

/**
 * A thinking-effort option id, as a model's `thinkingOptions` (or the
 * `thinking` policy block) names it: `low`, `xhigh`, `ultracode`, or a
 * non-Claude provider's own token. Not restricted to Claude's known ids —
 * other providers name their own effort levels, and the clamp in
 * `shared/thinking-levels.ts` falls back to the model's own default for
 * anything it doesn't recognize.
 */
export const THINKING_OPTION_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const ThinkingOptionIdSchema = z.string().regex(THINKING_OPTION_ID_RE);

/**
 * The leader tier's level: Extra High, not Ultra Code. No agent runs Ultra
 * Code by default. It fans work out to in-process workflows, which a message
 * from Tyler kills, and its standing instruction says token cost is no
 * constraint. Leaders delegate through durable Paseo agents instead. Ultra
 * Code stays a choice for the leader row in the settings editor, but nothing
 * defaults to it.
 */
export const DEFAULT_LEADER_THINKING = "xhigh";

/**
 * Each task class's level for a subagent. Mechanical work gets the cheapest
 * reasonable level, hard work the highest one short of Ultra Code, standard
 * sits in between — priced like `RoleRecord`'s own three pools.
 */
export const DEFAULT_THINKING_BY_TASK_CLASS: Readonly<Record<TaskClassId, string>> = {
  mechanical: "low",
  standard: "high",
  hard: "xhigh",
};

/**
 * Required ids, never null: every subagent whose model offers thinking must
 * leave the classifier with an explicit level. A class with no level would
 * fall back to the model's own default, which the classifier never trusts to
 * be a subagent's level.
 */
const ThinkingByTaskClassSchema = z
  .object({
    mechanical: ThinkingOptionIdSchema.default(DEFAULT_THINKING_BY_TASK_CLASS.mechanical),
    standard: ThinkingOptionIdSchema.default(DEFAULT_THINKING_BY_TASK_CLASS.standard),
    hard: ThinkingOptionIdSchema.default(DEFAULT_THINKING_BY_TASK_CLASS.hard),
  })
  .default(DEFAULT_THINKING_BY_TASK_CLASS as Record<TaskClassId, string>);

/**
 * The block's shape with no top-level default — used standalone by
 * `RoleModelPolicyDraftSchema`'s OPTIONAL `thinking` field (shared/role-policy-rpc.ts),
 * where the key being absent has to stay distinguishable from a written
 * block (an older app that never sends `thinking` vs. one that does).
 * `ThinkingPolicySchema` below adds the top-level default for the
 * stored-document shape, where "absent" always means "apply the default".
 */
export const ThinkingPolicyShapeSchema = z.object({
  /**
   * The level for the leader tier: a root agent, or one resolved to the
   * leader role. It outranks a requested level. `null` switches the rule off,
   * so leaders are decided like anyone else. A subagent resolved to the
   * leader role still never runs Ultra Code — see `decideThinking`.
   */
  leader: z.union([ThinkingOptionIdSchema, z.null()]).default(DEFAULT_LEADER_THINKING),
  /** A subagent's level by task class, used when the caller didn't ask for one. */
  byTaskClass: ThinkingByTaskClassSchema,
});

/**
 * Which thinking-effort level each agent's model runs at — a field
 * `RoleModelPolicy` gained with NO `schemaVersion` bump, the same way
 * `allowUnlistedModels`/`exposeClassifierTool` joined v4: the whole block
 * defaults to `DEFAULT_THINKING_POLICY` when absent from a stored document,
 * so a config that predates it keeps parsing. Inside it, an absent `leader`,
 * `byTaskClass`, or task-class key each take their own default.
 *
 * There is no knob for the one rule that matters most: a subagent never runs
 * Ultra Code. That is an invariant in the classifier, not policy.
 */
export const ThinkingPolicySchema = ThinkingPolicyShapeSchema.default({
  leader: DEFAULT_LEADER_THINKING,
  byTaskClass: DEFAULT_THINKING_BY_TASK_CLASS,
} as { leader: string | null; byTaskClass: Record<TaskClassId, string> });
export type ThinkingPolicy = z.infer<typeof ThinkingPolicySchema>;

/** `ThinkingPolicySchema` parsed with nothing supplied — the value every field of it defaults to. */
export const DEFAULT_THINKING_POLICY: ThinkingPolicy = {
  leader: DEFAULT_LEADER_THINKING,
  byTaskClass: { ...DEFAULT_THINKING_BY_TASK_CLASS },
};

export const RoleRecordSchema = z.object({
  /** Fixed lowercase id for standard roles; stable lowercase UUID for custom roles. */
  id: z.string().min(1),
  name: z.string().regex(ROLE_WORD_RE),
  standard: z.boolean(),
  aliases: z.array(z.string().regex(ROLE_WORD_RE)).max(MAX_ALIASES_PER_ROLE),
  /**
   * Ordered, most-preferred first. Empty = unconfigured (never routed). This
   * is the STANDARD-class pool: what an unclassified spawn gets, and the
   * fallback for `mechanicalModels`/`hardModels` when either is empty. See
   * `classModels` and TASK_CLASS_IDS's doc comment above.
   */
  models: z.array(z.string().max(MAX_MODEL_REF_LENGTH).regex(MODEL_REF_RE)).max(MAX_MODELS_PER_ROLE),
  /**
   * Optional override pool for a task classified `mechanical`. Empty (the
   * default) means "no override — use `models`", so adding this field
   * changes nothing for a role that never configures it.
   */
  mechanicalModels: z.array(z.string().max(MAX_MODEL_REF_LENGTH).regex(MODEL_REF_RE)).max(MAX_MODELS_PER_ROLE).default([]),
  /** Optional override pool for a task classified `hard`. Same empty-means-unset semantics as `mechanicalModels`. */
  hardModels: z.array(z.string().max(MAX_MODEL_REF_LENGTH).regex(MODEL_REF_RE)).max(MAX_MODELS_PER_ROLE).default([]),
  /**
   * Which tools agents resolved to this role may use. Defaults to
   * `unrestricted`, so a policy written before tool profiles existed keeps
   * behaving exactly as it did.
   */
  toolProfile: ToolProfileSchema.default(DEFAULT_TOOL_PROFILE),
});
export type RoleRecord = z.infer<typeof RoleRecordSchema>;

const AgentTypeMappingsSchema = z
  .record(z.string().regex(EXACT_AGENT_NAME_RE), z.string())
  .refine((mappings) => Object.keys(mappings).length <= MAX_MAPPINGS, {
    message: `agentTypeMappings must not exceed ${MAX_MAPPINGS} entries`,
  });

export const CURRENT_SCHEMA_VERSION = 4;

export const RoleModelPolicySchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    roles: z.array(RoleRecordSchema).max(MAX_ROLES),
    /** Caller agent-type/title -> role id. Tier 1 of role resolution. */
    agentTypeMappings: AgentTypeMappingsSchema,
    /**
     * Percent at/above which a budget-gated model family (Fable) stops being
     * selectable and a role falls to the next model in its own pool. See
     * BUDGET_GATED_FAMILIES in server/role-availability.ts.
     */
    modelBudgetThresholdPct: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(DEFAULT_MODEL_BUDGET_THRESHOLD_PCT),
    /**
     * Escape hatch, default OFF: when true, a role resolved by tier-3 seed
     * classification or the tier-4 default also has its tool profile
     * enforced, not just its model. Off by default because a classified role
     * is a guess about what the agent's prompt LOOKS like it's doing, and a
     * wrong guess here doesn't cost quality (a model pick) — it silently
     * removes Write/Edit/Bash from an agent already mid-task. See
     * `resolveRole`'s tier semantics in server/role-resolve.ts and the role
     * router's tool-profile gating in server/role-router.ts.
     */
    enforceToolsOnClassifiedRoles: z.boolean().default(false),
    /**
     * Default OFF: when true, every agent this daemon creates is given the
     * `agent_model_policy` MCP tool, so a caller can ask what a task WOULD
     * run as before it spawns anything (see server/classifier-tool.ts).
     *
     * Off by default because turning it on changes the `mcpServers` of every
     * agent on the fleet, which is not something an upgrade should do
     * quietly. It exposes the operator's routing policy to agents that
     * already run on the operator's machine, and nothing else.
     */
    exposeClassifierTool: z.boolean().default(false),
    /**
     * Model refs (same `model` / `provider/model` spelling as a role's pool)
     * that the operator vouches for even though the provider's advertised
     * catalog doesn't list them. Default empty: the catalog check stays
     * absolute, exactly as before this field existed.
     *
     * Why it exists: a CLI can accept a model id its `supportedModels()` list
     * doesn't advertise (Claude Code 2.1.280 runs `claude-opus-5-5` but omits
     * it). The catalog check can't tell "absent because unreal" from "absent
     * because unadvertised", so the operator says which ids are the second
     * kind. Naming an id here makes it count as present for the catalog check,
     * for BOTH an explicit request and ordered pool selection — an id the
     * operator wrote here is operator-verified, so it may be a pool default.
     *
     * Deliberately narrow:
     * - Per id, not a boolean: a typo'd request (`claude-opus-5-6`) matches no
     *   entry and is still refused at validation rather than dying at launch,
     *   and a non-allowlisted unlisted pool entry is still skipped.
     * - Only the catalog check is waived. A model that is capped, drained or
     *   budget-gated is refused exactly as before, and an explicit request must
     *   still name a model in the resolved role's own pool — this list adds no
     *   approval, it only stands in for catalog verification.
     */
    allowUnlistedModels: z.array(z.string().max(MAX_MODEL_REF_LENGTH).regex(MODEL_REF_RE)).max(MAX_MODELS_PER_ROLE).default([]),
    /**
     * Which thinking-effort level each agent's model runs at. See
     * `ThinkingPolicySchema`'s own doc comment for the default/absent
     * semantics at each level of this block.
     */
    thinking: ThinkingPolicySchema,
    /** Opaque compare-and-swap token, bumped on every accepted write. */
    revision: z.string(),
  })
  .superRefine((policy, ctx) => {
    const idCounts = new Map<string, number>();
    for (const role of policy.roles) {
      idCounts.set(role.id, (idCounts.get(role.id) ?? 0) + 1);
    }
    for (const [id, count] of idCounts) {
      if (count > 1) {
        ctx.addIssue({ code: "custom", message: `duplicate role id "${id}"`, path: ["roles"] });
      }
    }

    const standardIds = policy.roles
      .filter((role) => role.standard)
      .map((role) => role.id)
      .sort();
    const expectedStandardIds = [...STANDARD_ROLE_IDS].sort();
    if (
      standardIds.length !== expectedStandardIds.length ||
      standardIds.some((id, index) => id !== expectedStandardIds[index])
    ) {
      ctx.addIssue({
        code: "custom",
        message: `policy must declare exactly the standard roles: ${expectedStandardIds.join(", ")}`,
        path: ["roles"],
      });
    }

    // One case-insensitive namespace across every role's name + aliases.
    const wordOwners = new Map<string, string>();
    for (const role of policy.roles) {
      const words = [role.name, ...role.aliases];
      const lowerWords = words.map((word) => word.toLowerCase());
      if (new Set(lowerWords).size !== lowerWords.length) {
        ctx.addIssue({
          code: "custom",
          message: `role "${role.id}" has a duplicate name/alias word`,
          path: ["roles"],
        });
      }
      for (const lower of lowerWords) {
        const owner = wordOwners.get(lower);
        if (owner !== undefined && owner !== role.id) {
          ctx.addIssue({
            code: "custom",
            message: `"${lower}" is used by more than one role (names/aliases share one case-insensitive namespace)`,
            path: ["roles"],
          });
        } else {
          wordOwners.set(lower, role.id);
        }
      }
    }

    // Duplicates are checked WITHIN each pool independently — the same model
    // legitimately appearing in both `models` and `hardModels` (e.g. sonnet
    // as both the standard default and a hard-pool fallback member) is not a
    // dupe; only repeating an entry inside the same ordered pool is.
    for (const role of policy.roles) {
      for (const [field, pool] of [
        ["models", role.models],
        ["mechanicalModels", role.mechanicalModels],
        ["hardModels", role.hardModels],
      ] as const) {
        const lowerModels = pool.map((model) => model.toLowerCase());
        if (new Set(lowerModels).size !== lowerModels.length) {
          ctx.addIssue({
            code: "custom",
            message: `role "${role.id}" has a duplicate model entry in ${field}`,
            path: ["roles"],
          });
        }
      }
    }

    const roleIds = new Set(policy.roles.map((role) => role.id));
    for (const [key, value] of Object.entries(policy.agentTypeMappings)) {
      if (!roleIds.has(value)) {
        ctx.addIssue({
          code: "custom",
          message: `agentTypeMappings["${key}"] references unknown role "${value}"`,
          path: ["agentTypeMappings", key],
        });
      }
    }
  });
export type RoleModelPolicy = z.infer<typeof RoleModelPolicySchema>;

/**
 * Seeded on first install (no `agentModelPolicy` key present yet): all
 * standard roles unconfigured (empty `models`, behaviorally no policy) with
 * a starter vocabulary for tier-1 exact-name resolution.
 */
export const DEFAULT_POLICY: RoleModelPolicy = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  roles: [
    { id: "worker", name: "worker", standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
    { id: "advisor", name: "advisor", standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
    // Unconfigured and unrestricted by default: installing this version must
    // not silently change how a root agent runs. Tyler opts in from settings.
    { id: LEADER_ROLE_ID, name: LEADER_ROLE_ID, standard: true, aliases: [], models: [], mechanicalModels: [], hardModels: [], toolProfile: DEFAULT_TOOL_PROFILE },
  ],
  modelBudgetThresholdPct: DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  enforceToolsOnClassifiedRoles: false,
  exposeClassifierTool: false,
  allowUnlistedModels: [],
  thinking: DEFAULT_THINKING_POLICY,
  agentTypeMappings: {
    worker: "worker",
    scout: "worker",
    researcher: "worker",
    delegate: "worker",
    reviewer: "reviewer",
    oracle: "advisor",
    advisor: "advisor",
  },
  revision: "default",
};

export interface ParsedModelRef {
  /** Null for a bare, account-agnostic ref: the account router picks the provider. */
  provider: string | null;
  model: string;
}

/** Parses a model reference. Null on malformed input (defensive; schema should prevent this). */
export function splitModelRef(ref: string): ParsedModelRef | null {
  if (!MODEL_REF_RE.test(ref)) {
    return null;
  }
  const slashIndex = ref.indexOf("/");
  if (slashIndex === -1) {
    return { provider: null, model: ref };
  }
  return { provider: ref.slice(0, slashIndex), model: ref.slice(slashIndex + 1) };
}

/** The provider family a ref's catalog entry lives under — POOL_FAMILY for bare refs. */
export function modelRefFamily(parsed: ParsedModelRef): string {
  return parsed.provider ?? POOL_FAMILY;
}

/** Distinct provider-family ids referenced anywhere across the policy's roles, for catalog refresh scoping. */
export function rolePolicyFamilies(policy: RoleModelPolicy): string[] {
  const families = new Set<string>();
  for (const role of policy.roles) {
    for (const ref of [...role.models, ...role.mechanicalModels, ...role.hardModels]) {
      const parsed = splitModelRef(ref);
      if (parsed) {
        families.add(modelRefFamily(parsed));
      }
    }
  }
  return [...families];
}

/**
 * Every provider family the model catalog must cover to answer this policy in
 * full: every family a role's pools reference (`rolePolicyFamilies`), plus the
 * pool family itself.
 *
 * `POOL_FAMILY` is included unconditionally because a root agent's model
 * never has to come from a configured role pool (the leader role can be
 * unconfigured, as it is by default) — without it, the leader rule would
 * find no thinking options to apply its level against.
 */
export function catalogFamilies(policy: RoleModelPolicy): string[] {
  const families = new Set<string>(rolePolicyFamilies(policy));
  families.add(POOL_FAMILY);
  return [...families];
}

/**
 * The ordered model pool a role effectively uses for a given task class:
 * the class's own override pool when it's configured (non-empty), else
 * `role.models` (the standard pool). `taskClass` undefined (no class
 * resolved — see `resolveTaskClass`) or `"standard"` both mean `role.models`
 * directly, so an unclassified spawn and an explicitly-"standard" one behave
 * identically, and a role that never configures `mechanicalModels`/
 * `hardModels` behaves exactly as it did before those fields existed.
 */
export function classModels(role: RoleRecord, taskClass: TaskClassId | undefined): readonly string[] {
  if (taskClass === "mechanical" && role.mechanicalModels.length > 0) {
    return role.mechanicalModels;
  }
  if (taskClass === "hard" && role.hardModels.length > 0) {
    return role.hardModels;
  }
  return role.models;
}

export interface MigrateRolePolicyOptions {
  /**
   * The pool leader's provider entry id, read from the same daemon-config
   * snapshot. On a typical install this is the literal `"claude"`, which is
   * also the provider *family* id — the ambiguity this migration resolves.
   */
  poolLeaderProviderId?: string;
}

/**
 * v1 wrote every ref as `provider/model`, and the only provider id it could
 * name for a pooled account was the claude family id. Under v2 a pinned ref
 * means what it says, so carrying those refs forward verbatim would newly pin
 * every role at the leader account — the failure that stranded every role
 * when that account died. Drop the provider segment when it names the pool
 * leader, or the pool family itself (the second clause keeps the migration
 * correct when the pool config can't be read at all, where defaulting to
 * "still pinned" would be the bug).
 */
function unpinLegacyRef(ref: string, options: MigrateRolePolicyOptions): string {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0) {
    return ref;
  }
  const provider = ref.slice(0, slashIndex);
  if (provider === POOL_FAMILY || provider === options.poolLeaderProviderId) {
    return ref.slice(slashIndex + 1);
  }
  return ref;
}

/** v1 -> v2: model refs stop naming the leader account. */
function migrateV1ToV2(document: Record<string, unknown>, options: MigrateRolePolicyOptions): Record<string, unknown> {
  const roles = Array.isArray(document.roles)
    ? document.roles.map((role) => {
        if (typeof role !== "object" || role === null) {
          return role;
        }
        const record = role as Record<string, unknown>;
        if (!Array.isArray(record.models)) {
          return role;
        }
        return {
          ...record,
          models: record.models.map((ref) => (typeof ref === "string" ? unpinLegacyRef(ref, options) : ref)),
        };
      })
    : document.roles;
  return { ...document, schemaVersion: 2, roles };
}

/** Every name/alias word a document already claims, lowercased. */
function claimedRoleWords(roles: unknown): Set<string> {
  const words = new Set<string>();
  if (!Array.isArray(roles)) {
    return words;
  }
  for (const role of roles) {
    if (typeof role !== "object" || role === null) continue;
    const record = role as Record<string, unknown>;
    if (typeof record.name === "string") words.add(record.name.toLowerCase());
    if (Array.isArray(record.aliases)) {
      for (const alias of record.aliases) {
        if (typeof alias === "string") words.add(alias.toLowerCase());
      }
    }
  }
  return words;
}

/**
 * v2 -> v3: seed the `leader` standard role, which governs root agents.
 *
 * Seeded unconfigured (no models, unrestricted tools), so adding it changes
 * nothing until it's configured. Names and aliases share one case-insensitive
 * namespace, so a document where a custom role already owns "leader" would
 * otherwise fail validation and take the whole policy down with it — pick the
 * next free `leaderN` instead. This is seeding a newly-required role, not
 * repairing malformed input, which stays an error with no automatic fix.
 */
function migrateV2ToV3(document: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(document.roles)) {
    return { ...document, schemaVersion: 3 };
  }
  const hasLeader = document.roles.some(
    (role) => typeof role === "object" && role !== null && (role as Record<string, unknown>).id === LEADER_ROLE_ID,
  );
  if (hasLeader) {
    return { ...document, schemaVersion: 3 };
  }

  const claimed = claimedRoleWords(document.roles);
  let name = LEADER_ROLE_ID;
  for (let suffix = 1; claimed.has(name.toLowerCase()); suffix += 1) {
    name = `${LEADER_ROLE_ID}${suffix}`;
  }

  return {
    ...document,
    schemaVersion: 3,
    roles: [
      ...document.roles,
      { id: LEADER_ROLE_ID, name, standard: true, aliases: [], models: [], toolProfile: DEFAULT_TOOL_PROFILE },
    ],
  };
}

/**
 * v3 -> v4: no data changes at all. `mechanicalModels`/`hardModels` default
 * to `[]` via `RoleRecordSchema` itself (`.default([])`), so every role's
 * existing `models` pool — Tyler's live [opus, sonnet]/[sonnet, haiku,
 * opus]/[sonnet]/[opus, sonnet] pools included — round-trips byte-identical.
 * A version bump is the whole migration; there is nothing to re-pin.
 */
function migrateV3ToV4(document: Record<string, unknown>): Record<string, unknown> {
  return { ...document, schemaVersion: 4 };
}

/**
 * Brings a stored policy document up to CURRENT_SCHEMA_VERSION, in memory
 * only — this never writes settings. Anything that isn't a recognized older
 * version passes through untouched for `RoleModelPolicySchema` to accept or
 * reject on its own.
 *
 * `revision` carries through untouched at every step: it's the CAS token the
 * settings screen round-trips, and migrating in memory must not invalidate it.
 */
export function migrateRoleModelPolicy(raw: unknown, options: MigrateRolePolicyOptions = {}): unknown {
  if (typeof raw !== "object" || raw === null) {
    return raw;
  }
  let document = raw as Record<string, unknown>;
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2 && document.schemaVersion !== 3) {
    return raw;
  }

  if (document.schemaVersion === 1) {
    document = migrateV1ToV2(document, options);
  }
  if (document.schemaVersion === 2) {
    document = migrateV2ToV3(document);
  }
  return migrateV3ToV4(document);
}
