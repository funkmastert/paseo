import { z } from "zod";

/**
 * Label keys the role hook reads off `agent.create` requests. Mirrors the
 * `PARENT_AGENT_ID_LABEL` convention in `notify.ts` / `packages/protocol/src/agent-labels.ts`.
 */
export const AGENT_TYPE_LABEL = "paseo.agent-type";
export const AGENT_ROLE_LABEL = "paseo.agent-role";

/** Fixed, non-renamable, non-deletable role ids. Aliases and models remain editable. */
export const STANDARD_ROLE_IDS = ["worker", "reviewer", "advisor"] as const;
export type StandardRoleId = (typeof STANDARD_ROLE_IDS)[number];

/** One namespace word: a role name or alias. Case-insensitively unique across the whole policy. */
export const ROLE_WORD_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** An `agentTypeMappings` key: an exact caller-supplied agent-type/title string. */
export const EXACT_AGENT_NAME_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

/**
 * A `provider/model` reference. No whitespace, control characters, commas,
 * or wildcards in either segment; exactly one `/` separator.
 */
const MODEL_REF_SEGMENT = "[^\\s,*?\\x00-\\x1F\\x7F]+";
export const MODEL_REF_RE = new RegExp(`^${MODEL_REF_SEGMENT}/${MODEL_REF_SEGMENT}$`);

export const MAX_ROLES = 64;
export const MAX_ALIASES_PER_ROLE = 8;
export const MAX_MODELS_PER_ROLE = 32;
export const MAX_MAPPINGS = 256;
export const MAX_MODEL_REF_LENGTH = 256;

export const RoleRecordSchema = z.object({
  /** Fixed lowercase id for standard roles; stable lowercase UUID for custom roles. */
  id: z.string().min(1),
  name: z.string().regex(ROLE_WORD_RE),
  standard: z.boolean(),
  aliases: z.array(z.string().regex(ROLE_WORD_RE)).max(MAX_ALIASES_PER_ROLE),
  /** Ordered, most-preferred first. Empty = unconfigured (never routed). */
  models: z.array(z.string().max(MAX_MODEL_REF_LENGTH).regex(MODEL_REF_RE)).max(MAX_MODELS_PER_ROLE),
});
export type RoleRecord = z.infer<typeof RoleRecordSchema>;

const AgentTypeMappingsSchema = z
  .record(z.string().regex(EXACT_AGENT_NAME_RE), z.string())
  .refine((mappings) => Object.keys(mappings).length <= MAX_MAPPINGS, {
    message: `agentTypeMappings must not exceed ${MAX_MAPPINGS} entries`,
  });

export const RoleModelPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    roles: z.array(RoleRecordSchema).max(MAX_ROLES),
    /** Caller agent-type/title -> role id. Tier 1 of role resolution. */
    agentTypeMappings: AgentTypeMappingsSchema,
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

    for (const role of policy.roles) {
      const lowerModels = role.models.map((model) => model.toLowerCase());
      if (new Set(lowerModels).size !== lowerModels.length) {
        ctx.addIssue({
          code: "custom",
          message: `role "${role.id}" has a duplicate model entry`,
          path: ["roles"],
        });
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
  schemaVersion: 1,
  roles: [
    { id: "worker", name: "worker", standard: true, aliases: [], models: [] },
    { id: "reviewer", name: "reviewer", standard: true, aliases: [], models: [] },
    { id: "advisor", name: "advisor", standard: true, aliases: [], models: [] },
  ],
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

/** Splits a validated `provider/model` reference. Null on malformed input (defensive; schema should prevent this). */
export function splitModelRef(ref: string): { family: string; model: string } | null {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1) {
    return null;
  }
  return { family: ref.slice(0, slashIndex), model: ref.slice(slashIndex + 1) };
}

/** Distinct provider-family ids referenced anywhere across the policy's roles, for catalog refresh scoping. */
export function rolePolicyFamilies(policy: RoleModelPolicy): string[] {
  const families = new Set<string>();
  for (const role of policy.roles) {
    for (const ref of role.models) {
      const parsed = splitModelRef(ref);
      if (parsed) {
        families.add(parsed.family);
      }
    }
  }
  return [...families];
}
