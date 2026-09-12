import { z } from "zod";
import { MAX_ROLES, RoleModelPolicySchema, RoleRecordSchema } from "./role-policy-schema";
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
  provider: z.string().optional(),
  model: z.string().optional(),
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
    input: z.object({ agentType: z.string().optional(), title: z.string().optional() }),
    output: RoleModelPolicyExplainResultSchema,
  }),
};
