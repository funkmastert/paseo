import { z } from "zod";
import {
  DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  MAX_ROLES,
  TASK_CLASS_IDS,
  RoleModelPolicySchema,
  RoleRecordSchema,
  ThinkingPolicyShapeSchema,
} from "./role-policy-schema";
import { defineRpc } from "@getpaseo/plugin";

/**
 * The client-editable subset of a policy document: everything except
 * `schemaVersion` and `revision`, which the server owns. Field-level shape
 * (regexes, per-array maxes) is checked here; the full semantic invariants
 * (namespace dupes, standard-role set, mapping targets) are re-checked
 * server-side by composing this into a full `RoleModelPolicy` and running it
 * through `RoleModelPolicySchema` — one validator, never duplicated.
 */
export const RoleModelPolicyDraftSchema = z.object({
  roles: z.array(RoleRecordSchema).max(MAX_ROLES),
  agentTypeMappings: z.record(z.string(), z.string()),
  modelBudgetThresholdPct: z.number().int().min(1).max(100).default(DEFAULT_MODEL_BUDGET_THRESHOLD_PCT),
  /**
   * OPTIONAL, unlike every other field here: an app build that predates this
   * field never sends it, and `performWrite` (server/role-policy-rpc-handlers.ts)
   * carries the stored value through untouched when it's absent — mirroring
   * how `allowUnlistedModels` survives an unrelated save. `ThinkingPolicyShapeSchema`
   * (not `ThinkingPolicySchema`) is used here specifically so an absent key
   * parses to `undefined` rather than the default policy — the two must stay
   * distinguishable for that carry-through to work.
   */
  thinking: ThinkingPolicyShapeSchema.optional(),
});
export type RoleModelPolicyDraft = z.infer<typeof RoleModelPolicyDraftSchema>;

export const RoleModelPolicyReadResultSchema = z.object({
  policy: RoleModelPolicySchema,
  /** True when the stored config exists but failed validation; `policy` is then the last known-good document. */
  malformed: z.boolean(),
  error: z.string().optional(),
});
export type RoleModelPolicyReadResult = z.infer<typeof RoleModelPolicyReadResultSchema>;

/**
 * Compare-and-swap write outcome. `conflict` and `saved` both carry the
 * authoritative `policy` so the client can re-seed its draft without a
 * second round trip. `saved.warning` is set when the write itself
 * succeeded but the in-process routing cache failed to pick it up
 * immediately — the write is durable; only the hot-path cache is stale.
 */
export const RoleModelPolicyWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), policy: RoleModelPolicySchema, warning: z.string().optional() }),
  z.object({ status: z.literal("conflict"), error: z.string(), policy: RoleModelPolicySchema }),
  z.object({ status: z.literal("invalid"), error: z.string() }),
]);
export type RoleModelPolicyWriteResult = z.infer<typeof RoleModelPolicyWriteResultSchema>;

export const RoleModelPolicyExplainResultSchema = z.object({
  roleId: z.string(),
  roleName: z.string(),
  /**
   * Which rung of resolution produced the role. Preferred over `tier` for
   * anything human-facing: it separates "your own alias matched" from "a
   * built-in seed keyword matched", which `tier: 3` conflates.
   */
  roleSource: z.enum([
    "leader-tier",
    "agent-type-mapping",
    "declared-label",
    "classified-vocabulary",
    "classified-seed",
    "default",
  ]),
  /** The numeric tier. Absent for a root agent, which resolves to `leader` structurally rather than by classification. */
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  /** Set when the simulated `paseo.agent-role` matched no configured role. Resolution fell through, never blocked. */
  unknownDeclaredRole: z.string().optional(),
  outcome: z.union([
    z.literal("unconfigured"),
    z.literal("honored-request"),
    z.literal("selected"),
    z.literal("unavailable"),
  ]),
  /** Absent for an account-agnostic model ref: the account router still picks the account. */
  provider: z.string().optional(),
  model: z.string().optional(),
  /** The ordered pool the model came from, and which of the role's three pools that was. */
  pool: z.array(z.string()),
  poolSlot: z.enum(["standard", "mechanical", "hard"]),
  /** True when `poolSlot` is "standard" only because the resolved class's own pool is empty. */
  fellBackToStandardPool: z.boolean(),
  /**
   * True when `model` was selected from the pool although the provider's
   * catalog doesn't list it — the operator's `allowUnlistedModels` vouches
   * for it. Absent for a listed model.
   */
  modelUnadvertised: z.boolean().optional(),
  /**
   * Refs in the resolved pool that ordered selection SKIPS because the
   * catalog doesn't list them and `allowUnlistedModels` doesn't name them.
   * Without this an entry that is "in the pool" but never chosen looks live.
   * An allowlisted entry is selectable, so it does not appear here.
   */
  unadvertisedPoolEntries: z.array(z.string()).optional(),
  /**
   * The tools actually removed at launch — the APPLIED profile plus anything
   * inherited, not the role's configured profile. Those differ whenever a
   * guessed role's profile is withheld, which is exactly what the preview
   * used to get wrong.
   */
  deniedTools: z.array(z.string()),
  /**
   * Present when the role's own profile was withheld because the role was
   * guessed rather than declared. `deniedTools` above is what really applies;
   * this is what WOULD have, had the caller labelled the agent.
   */
  toolsWithheld: z
    .object({ profileKind: z.string(), deniedTools: z.array(z.string()) })
    .optional(),
  /**
   * The resolved task class driving `outcome`/`model` — undefined means
   * "default": the role's standard `models` pool, exactly what every role
   * used before this dimension existed.
   */
  taskClass: z.enum(TASK_CLASS_IDS).optional(),
  taskClassSource: z.union([z.literal("declared"), z.literal("classified"), z.literal("default")]),
  /** Set when the query's `taskClass` didn't match mechanical/standard/hard; resolution still fell through, never blocked. */
  unknownDeclaredTaskClass: z.string().optional(),
  /**
   * Which pooled account would serve it, from the same ladder the account
   * router walks (server/account-select.ts). `not-evaluated` never appears
   * here — the RPC always supplies an instant — but `no-pool` does, for a
   * non-pool-family request or a root agent whose own account can serve it.
   */
  account: z.object({
    kind: z.enum(["worker", "leader", "exhausted", "no-pool", "not-evaluated"]),
    providerId: z.string().optional(),
    usableProviderIds: z.array(z.string()).optional(),
    /** Set when a root agent's own account is out of budget: the account it asked for, and moved off. */
    reroutedFrom: z.string().optional(),
  }),
  /**
   * One sentence per part of the decision, written by the classifier itself.
   * This is what the settings preview prints: the rendering side states no
   * rule of its own, so there is nothing there to drift.
   */
  reasons: z.object({
    role: z.string(),
    taskClass: z.string(),
    model: z.string(),
    tools: z.string(),
    account: z.string(),
    /** Optional: a plugin that predates the thinking decision sends none. */
    thinking: z.string().optional(),
  }),
  /**
   * The thinking level the create hook would write to `config.thinkingOptionId`
   * — server/classifier.ts's `ThinkingDecision`, projected. Optional, like
   * everything added here, because the app and the plugin drift in version.
   * The discriminants are plain strings rather than enums for the same
   * reason: a newer plugin's outcome must not fail an older app's parse of
   * the whole result.
   */
  thinking: z
    .object({
      /** leader-rule, requested, task-class-default, no-thinking-options, or model-unknown. */
      outcome: z.string(),
      /** Absent when no level applies: the model offers none, or nothing is known and nothing was asked for. */
      optionId: z.string().optional(),
      modelRef: z.string().optional(),
      /** What the leader rule, the request or the task class named, before any cap or clamp. */
      wanted: z.string().optional(),
      /** True when this is a subagent and Ultra Code was replaced by Extra High. */
      subagentCapped: z.boolean().optional(),
      clamped: z.object({ wanted: z.string(), applied: z.string(), how: z.string() }).optional(),
      /** The simulated `requestedThinkingOptionId`, when one was given. */
      requested: z.string().optional(),
      /**
       * Present when the requested level is not what would run. A real agent
       * would carry `paseo.thinking-overridden-by-policy=<requested>`.
       * `applied` is absent when the requested id would be removed.
       */
      override: z
        .object({ requested: z.string(), applied: z.string().optional(), reason: z.string() })
        .optional(),
    })
    .optional(),
  /**
   * Present only when the query named `requestedModel`: what the create hook
   * would actually do with that explicit request — honored because it's a
   * member of the resolved (role, task class) pool AND currently selectable,
   * or overridden by policy.
   */
  requestedModelOverride: z
    .object({
      requestedRef: z.string(),
      honored: z.boolean(),
      /** The ref policy would run instead. Omitted when `honored` is true. */
      effectiveRef: z.string().optional(),
      /**
       * Omitted when `honored` is true. "not-approved": never one of the
       * role's configured entries. "not-currently-selectable": configured,
       * but catalog-missing, no viable pool member, or budget-gated.
       */
      reason: z.union([z.literal("not-approved"), z.literal("not-currently-selectable")]).optional(),
      /**
       * Present (true) only when `honored` is true because the catalog check
       * was waived: the model isn't in the provider's advertised catalog and
       * the policy's `allowUnlistedModels` names it. It is unverified — a real
       * agent would carry `paseo.model-unadvertised`.
       */
      unadvertised: z.boolean().optional(),
      /**
       * Present (true) only when refused because the model is absent from the
       * advertised catalog and not in `allowUnlistedModels` — the one refusal
       * an operator can lift, unlike a capped or budget-gated model.
       */
      missingFromCatalog: z.boolean().optional(),
    })
    .optional(),
});
export type RoleModelPolicyExplainResult = z.infer<typeof RoleModelPolicyExplainResultSchema>;

/**
 * RPC method names are lowercase-only (`defineRpc`'s `RPC_NAME` regex), so
 * the wire names are kebab-case even though this object's own property
 * names read as `roleModelPolicy.read` etc. in the plan/prose.
 */
export const roleModelPolicyRpc = {
  read: defineRpc({
    name: "role-model-policy.read",
    input: z.object({}),
    output: RoleModelPolicyReadResultSchema,
  }),
  write: defineRpc({
    name: "role-model-policy.write",
    input: z.object({ revision: z.string(), patch: RoleModelPolicyDraftSchema }),
    output: RoleModelPolicyWriteResultSchema,
  }),
  listModels: defineRpc({
    name: "role-model-policy.list-models",
    input: z.object({ families: z.array(z.string()).min(1), force: z.boolean().optional() }),
    output: z.object({ catalog: z.record(z.string(), z.array(z.string())) }),
  }),
  recentAgentTypes: defineRpc({
    name: "role-model-policy.recent-agent-types",
    input: z.object({}),
    output: z.object({ values: z.array(z.string()) }),
  }),
  explain: defineRpc({
    name: "role-model-policy.explain",
    input: z.object({
      /** Simulates labels[paseo.agent-type] (tier 1's exact-mapping key). */
      agentType: z.string().optional(),
      /**
       * Simulates labels[paseo.agent-role] (tier-2 resolution: a declared role
       * name or alias). Unknown values fall through exactly as they do at
       * create time. It is the only way to ask about a role no agent-type
       * mapping points at — though for `leader`, `root` below is the accurate
       * question, since a real root agent reaches that role structurally
       * rather than through any label.
       */
      role: z.string().optional(),
      title: z.string().optional(),
      /**
       * Simulates the create's `initialPrompt`. The create hook classifies
       * over title AND prompt; a preview that only saw the title answered a
       * different question than the hook did, which is how the two drifted.
       */
      prompt: z.string().optional(),
      /**
       * Simulates labels[paseo.task-class] — same declared/unknown/default
       * fallthrough the classifier applies at create time. Omitted means
       * "not declared": the result falls back to text classification.
       */
      taskClass: z.string().optional(),
      /**
       * Simulate a ROOT agent (one with no calling agent — what you, the CLI
       * or the app start). Those resolve to `leader` structurally, and never
       * reached this preview before.
       */
      root: z.boolean().optional(),
      /**
       * Simulates an explicit `config.model` request against the resolved
       * role, alongside `requestedProvider` (defaults to the pool family).
       * When set, the result's `requestedModelOverride` reports whether the
       * create hook would honor it or override it.
       */
      requestedModel: z.string().optional(),
      requestedProvider: z.string().optional(),
      /**
       * Simulates an explicit `config.thinkingOptionId`. The result's
       * `thinking.override` reports whether the create hook would keep it.
       */
      requestedThinkingOptionId: z.string().optional(),
    }),
    output: RoleModelPolicyExplainResultSchema,
  }),
};
