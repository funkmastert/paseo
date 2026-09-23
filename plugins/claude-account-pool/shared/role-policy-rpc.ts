import { z } from "zod";
import {
  DEFAULT_MODEL_BUDGET_THRESHOLD_PCT,
  MAX_ROLES,
  TASK_CLASS_IDS,
  RoleModelPolicySchema,
  RoleRecordSchema,
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
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  outcome: z.union([z.literal("unconfigured"), z.literal("selected"), z.literal("unavailable")]),
  /** Absent for an account-agnostic model ref: the account router still picks the account. */
  provider: z.string().optional(),
  model: z.string().optional(),
  /** The tools this role removes. Applies even when `outcome` is "unconfigured". */
  deniedTools: z.array(z.string()),
  /**
   * The resolved task class driving `outcome`/`model` — undefined means
   * "default": the role's standard `models` pool, exactly what every role
   * used before this dimension existed. See classModels() and
   * server/role-resolve.ts's resolveTaskClass.
   */
  taskClass: z.enum(TASK_CLASS_IDS).optional(),
  taskClassSource: z.union([z.literal("declared"), z.literal("classified"), z.literal("default")]),
  /** Set when the query's `taskClass` didn't match mechanical/standard/hard; resolution still fell through, never blocked. */
  unknownDeclaredTaskClass: z.string().optional(),
  /**
   * Present only when the query named `requestedModel`: what the role
   * router would actually do with that explicit request — honored because
   * it's a member of the resolved role's own pool AND currently selectable,
   * or overridden by policy (mirrors the `before("agent.create")`
   * precedence in role-router.ts, including its `evaluateRequestedModel`
   * eligibility check, not just configured-list membership).
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
  /**
   * Refs in the resolved pool that ordered selection skips because the
   * catalog doesn't list them. An unadvertised entry only ever runs via an
   * explicit request (see `allowUnlistedModels`), so it would otherwise sit in
   * the pool looking live and never be chosen.
   */
  unadvertisedPoolEntries: z.array(z.string()).optional(),
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
      agentType: z.string().optional(),
      /**
       * Simulates labels[paseo.agent-role] (tier-2 resolution: a declared role
       * name or alias). The only way to ask about a role no agent-type mapping
       * points at — notably `leader`, which real root agents reach
       * deterministically rather than through any label.
       */
      role: z.string().optional(),
      title: z.string().optional(),
      /**
       * Simulates labels[paseo.task-class] — same declared/unknown/default
       * fallthrough resolveTaskClass applies at create time. Omitted means
       * "not declared": the result falls back to text classification over
       * `title` alone (initialPrompt isn't simulated here, matching the
       * existing gap for role classification below).
       */
      taskClass: z.string().optional(),
      /**
       * Simulates an explicit `config.model` request against the resolved
       * role, alongside `requestedProvider` (defaults to the pool family).
       * When set, the result's `requestedModelOverride` reports whether the
       * role router would honor it or override it.
       */
      requestedModel: z.string().optional(),
      requestedProvider: z.string().optional(),
    }),
    output: RoleModelPolicyExplainResultSchema,
  }),
};
