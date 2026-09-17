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

export const CURRENT_SCHEMA_VERSION = 2;

export const RoleModelPolicySchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
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
  schemaVersion: CURRENT_SCHEMA_VERSION,
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
    for (const ref of role.models) {
      const parsed = splitModelRef(ref);
      if (parsed) {
        families.add(modelRefFamily(parsed));
      }
    }
  }
  return [...families];
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

/**
 * Brings a stored policy document up to CURRENT_SCHEMA_VERSION, in memory
 * only — this never writes settings. Anything that isn't a recognized older
 * version passes through untouched for `RoleModelPolicySchema` to accept or
 * reject on its own.
 */
export function migrateRoleModelPolicy(raw: unknown, options: MigrateRolePolicyOptions = {}): unknown {
  if (typeof raw !== "object" || raw === null) {
    return raw;
  }
  const document = raw as Record<string, unknown>;
  if (document.schemaVersion !== 1 || !Array.isArray(document.roles)) {
    return raw;
  }

  const roles = document.roles.map((role) => {
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
  });

  // `revision` carries through untouched: it's the CAS token the settings
  // screen round-trips, and migrating in memory must not invalidate it.
  return { ...document, schemaVersion: CURRENT_SCHEMA_VERSION, roles };
}
