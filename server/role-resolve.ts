import {
  AGENT_ROLE_LABEL,
  AGENT_TYPE_LABEL,
  LEADER_ROLE_ID,
  type RoleModelPolicy,
  type RoleRecord,
  type StandardRoleId,
} from "../shared/role-policy-schema";

export type ResolveRoleTier = 1 | 2 | 3 | 4;

export interface ResolveRoleInput {
  labels?: Record<string, string>;
  title?: string | null;
  initialPrompt?: string;
}

export interface ResolveRoleResult {
  role: RoleRecord;
  tier: ResolveRoleTier;
  /**
   * Set when the caller declared labels[AGENT_ROLE_LABEL] but it matched no
   * configured role name/alias. Resolution still falls through to tier 3/4
   * (never blocks); the router uses this to notify once per (caller, value).
   */
  unknownDeclaredValue?: string;
}

// Tier-3 built-in seed vocabulary. Checked only after every configured role
// name/alias, so user vocabulary always wins.
const REVIEWER_SEED_RE = /review|verify|audit|check/;
const ADVISOR_SEED_RE = /research|scout|explore|investigate|advis|oracle/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findRoleById(policy: RoleModelPolicy, id: string): RoleRecord | undefined {
  return policy.roles.find((role) => role.id === id);
}

function requireStandardRole(policy: RoleModelPolicy, id: StandardRoleId): RoleRecord {
  const role = findRoleById(policy, id);
  if (!role) {
    // The schema's superRefine guarantees every valid policy declares the
    // standard roles; a policy that reached resolveRole is always
    // schema-valid (role-policy.ts fails closed on anything else).
    throw new Error(`role policy is missing the standard "${id}" role`);
  }
  return role;
}

/**
 * The role for a ROOT agent: one the daemon created with no `callerAgentId`.
 * Deterministic rather than classified — a root agent is the leader by
 * definition, and guessing from its prompt would make whether the operator's
 * orchestrator restriction applies depend on wording.
 */
export function resolveLeaderRole(policy: RoleModelPolicy): RoleRecord {
  return requireStandardRole(policy, LEADER_ROLE_ID);
}

/** Exact (not substring) case-insensitive match against every role's name + aliases. */
function findRoleByExactWordCI(policy: RoleModelPolicy, value: string): RoleRecord | undefined {
  const lower = value.toLowerCase();
  return policy.roles.find(
    (role) => role.name.toLowerCase() === lower || role.aliases.some((alias) => alias.toLowerCase() === lower),
  );
}

/**
 * Word-boundary case-insensitive search for any role's name/alias inside free
 * text. The leader role is skipped: it governs root agents, and a child whose
 * prompt merely mentions leading something must not inherit an orchestrator's
 * tool restrictions by accident. Naming it explicitly (an agent-type mapping
 * or the role label) still selects it.
 */
function findRoleByWordInText(policy: RoleModelPolicy, text: string): RoleRecord | undefined {
  for (const role of policy.roles) {
    if (role.id === LEADER_ROLE_ID) {
      continue;
    }
    for (const word of [role.name, ...role.aliases]) {
      const pattern = new RegExp(`\\b${escapeRegExp(word.toLowerCase())}\\b`);
      if (pattern.test(text)) {
        return role;
      }
    }
  }
  return undefined;
}

/** Tier 3/4: deterministic keyword classification over lowercase(title + " " + initialPrompt). */
function classify(policy: RoleModelPolicy, text: string): { role: RoleRecord; tier: 3 | 4 } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { role: requireStandardRole(policy, "worker"), tier: 4 };
  }

  const configuredMatch = findRoleByWordInText(policy, trimmed);
  if (configuredMatch) {
    return { role: configuredMatch, tier: 3 };
  }
  if (REVIEWER_SEED_RE.test(trimmed)) {
    return { role: requireStandardRole(policy, "reviewer"), tier: 3 };
  }
  if (ADVISOR_SEED_RE.test(trimmed)) {
    return { role: requireStandardRole(policy, "advisor"), tier: 3 };
  }
  return { role: requireStandardRole(policy, "worker"), tier: 3 };
}

/**
 * Pure role resolution — no I/O, no callerAgentId, no dedup state. See
 * role-router.ts for the callerAgentId gate (same one the account router
 * uses) and the once-per-(caller, value) notification for unknown declared
 * roles.
 *
 * Precedence:
 *   1. Explicit exact-name mapping: labels[AGENT_TYPE_LABEL] in
 *      agentTypeMappings, else title as the exact-match fallback key.
 *   2. Caller-declared role: labels[AGENT_ROLE_LABEL] matched
 *      case-insensitively against every role name+alias. Unknown/malformed
 *      values never block — they fall through to tier 3 with
 *      `unknownDeclaredValue` set.
 *   3. Automatic task classification (configured vocabulary, then seeds).
 *   4. Default: worker (only when there's no title/prompt text to classify).
 */
export function resolveRole(policy: RoleModelPolicy, input: ResolveRoleInput): ResolveRoleResult {
  const typeLabelValue = input.labels?.[AGENT_TYPE_LABEL];
  const tier1Key = typeLabelValue !== undefined ? typeLabelValue : (input.title ?? undefined);
  if (tier1Key !== undefined) {
    const mappedRoleId = policy.agentTypeMappings[tier1Key];
    if (mappedRoleId !== undefined) {
      const role = findRoleById(policy, mappedRoleId);
      if (role) {
        return { role, tier: 1 };
      }
    }
  }

  const declaredRole = input.labels?.[AGENT_ROLE_LABEL];
  const classificationText = `${input.title ?? ""} ${input.initialPrompt ?? ""}`.toLowerCase();
  if (declaredRole !== undefined) {
    const role = findRoleByExactWordCI(policy, declaredRole);
    if (role) {
      return { role, tier: 2 };
    }
    return { ...classify(policy, classificationText), unknownDeclaredValue: declaredRole };
  }

  return classify(policy, classificationText);
}
