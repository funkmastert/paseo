import {
  AGENT_ROLE_LABEL,
  AGENT_TYPE_LABEL,
  LEADER_ROLE_ID,
  TASK_CLASS_IDS,
  TASK_CLASS_LABEL,
  type RoleModelPolicy,
  type RoleRecord,
  type StandardRoleId,
  type TaskClassId,
} from "../shared/role-policy-schema";

export type ResolveRoleTier = 1 | 2 | 3 | 4;

/**
 * Which kind of text match produced a tier-3 role.
 *
 * `vocabulary` is one of the operator's OWN configured role names/aliases
 * appearing in the text; `seed` is one of the two built-in seed patterns
 * below. The distinction is only ever reported, never acted on — but it is
 * the difference between "your alias caught this" and "a built-in keyword
 * did", which is the first question asked when a classification surprises
 * someone. Absent on tiers 1, 2 and 4, where no text matching happened — and
 * absent on a tier-3 result too when the text matched nothing and the worker
 * default is simply what was left.
 *
 * `jev` is JEV's spawn hint replacing the keyword guess (docs/jev.md,
 * "Feature 2"). Still tier 3: a guess, so it may pick a model and never a
 * tool profile.
 */
export type ClassificationMatch = "vocabulary" | "seed" | "jev";

export interface ResolveRoleInput {
  labels?: Record<string, string>;
  title?: string | null;
  initialPrompt?: string;
}

/**
 * JEV's role proposal, already past its confidence floor (server/jev-hint.ts).
 * `apply` false means the answer is recorded, not used: shadow mode, or
 * `spawnHint.applyRole` off.
 */
export interface RoleJevInput {
  roleId: string;
  apply: boolean;
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
  /** Which kind of text match produced a tier-3 role. Absent on every other tier. */
  match?: ClassificationMatch;
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

/**
 * The role a create with no calling agent declared for itself, or undefined when it declared
 * none that a role owns.
 *
 * Only explicit labels count: `paseo.agent-type` found in `agentTypeMappings` (tier 1), or
 * `paseo.agent-role` naming a role (tier 2). No title fallback and no text classification, so an
 * unlabelled root stays the leader whatever its prompt says. Daemon jobs such as the remediation
 * ladder start agents with no caller and label them workers; ignoring the label ran each one as a
 * leader.
 */
export function resolveDeclaredRootRole(
  policy: RoleModelPolicy,
  labels: Record<string, string> | undefined,
): { role: RoleRecord; tier: 1 | 2 } | undefined {
  const typeLabelValue = labels?.[AGENT_TYPE_LABEL];
  if (typeLabelValue !== undefined) {
    const mappedRoleId = policy.agentTypeMappings[typeLabelValue];
    const role = mappedRoleId !== undefined ? findRoleById(policy, mappedRoleId) : undefined;
    if (role) {
      return { role, tier: 1 };
    }
  }
  const declaredRole = labels?.[AGENT_ROLE_LABEL];
  if (declaredRole !== undefined) {
    const role = findRoleByExactWordCI(policy, declaredRole);
    if (role) {
      return { role, tier: 2 };
    }
  }
  return undefined;
}

/**
 * Whether a create with no calling agent is placed and configured like a child: it declared a
 * role, and that role is not the leader. The classifier and the account router both ask this, so
 * the model a create runs and the account it runs on can't disagree about what it is.
 */
export function placesRootAsChild(policy: RoleModelPolicy, labels: Record<string, string> | undefined): boolean {
  const declared = resolveDeclaredRootRole(policy, labels);
  return declared !== undefined && declared.role.id !== LEADER_ROLE_ID;
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
function classify(
  policy: RoleModelPolicy,
  text: string,
): { role: RoleRecord; tier: 3 | 4; match?: ClassificationMatch } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { role: requireStandardRole(policy, "worker"), tier: 4 };
  }

  const configuredMatch = findRoleByWordInText(policy, trimmed);
  if (configuredMatch) {
    return { role: configuredMatch, tier: 3, match: "vocabulary" };
  }
  if (REVIEWER_SEED_RE.test(trimmed)) {
    return { role: requireStandardRole(policy, "reviewer"), tier: 3, match: "seed" };
  }
  if (ADVISOR_SEED_RE.test(trimmed)) {
    return { role: requireStandardRole(policy, "advisor"), tier: 3, match: "seed" };
  }
  // Text existed but nothing in it matched: `match` stays unset, which is
  // how a caller tells "a keyword chose worker" from "worker is what's left".
  return { role: requireStandardRole(policy, "worker"), tier: 3 };
}

/**
 * Pure role resolution: one step of server/classifier.ts, which is the only
 * caller. Nothing else should call this directly — the classifier is the
 * single authority, and a second caller here is a second place the role
 * answer can be derived (see classifier.ts's header).
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
export function resolveRole(
  policy: RoleModelPolicy,
  input: ResolveRoleInput,
  jev?: RoleJevInput,
): ResolveRoleResult {
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
    return { ...classifyWithJev(policy, classificationText, jev), unknownDeclaredValue: declaredRole };
  }

  return classifyWithJev(policy, classificationText, jev);
}

/**
 * Tiers 3–4 with JEV's role in front of the keywords, when it applies. The
 * leader is never a JEV answer: it is not offered as an option, and a policy
 * edit that removed a role since the question was built falls through.
 */
function classifyWithJev(
  policy: RoleModelPolicy,
  text: string,
  jev: RoleJevInput | undefined,
): { role: RoleRecord; tier: 3 | 4; match?: ClassificationMatch } {
  if (jev?.apply && jev.roleId !== LEADER_ROLE_ID) {
    const role = findRoleById(policy, jev.roleId);
    if (role) {
      return { role, tier: 3, match: "jev" };
    }
  }
  return classify(policy, text);
}

export type TaskClassSource = "declared" | "jev" | "classified" | "default";

export interface ResolveTaskClassResult {
  /** Undefined means "default": no class resolved, so classModels() falls back to the role's standard pool. */
  taskClass: TaskClassId | undefined;
  source: TaskClassSource;
  /** Set when the caller declared labels[TASK_CLASS_LABEL] but it matched none of TASK_CLASS_IDS. Never blocks. */
  unknownDeclaredValue?: string;
}

/**
 * Keyword seeds for the ungoverned fallback: no declared `paseo.task-class`
 * label, so the only signal left is free text. Deliberately narrow — this
 * only picks out fairly unambiguous cases; anything it doesn't recognize
 * stays "default" (the role's standard pool), which is the safe, predictable
 * answer per today's behavior. `hard` is checked first: a prompt that
 * mentions both a trivial-sounding word and a genuine risk word (e.g. "fix
 * the typo that's causing the race condition") must not be under-classified.
 */
const HARD_SEED_RE =
  /race condition|deadlock|concurren(?:cy|t)|distributed|migrat(?:e|ion)|security|vulnerab|architecture|redesign|cross-cutting|consensus|data loss|corrupt/;
const MECHANICAL_SEED_RE =
  /\btypo\b|\brenam(?:e|ing)\b|\bformatting\b|\bwhitespace\b|\bchangelog\b|\blint(?:ing)?\b|\bdead code\b|\bunused import\b|\bone[- ]liner\b|\btrivial\b|\bbump(?:ed|ing)? (?:the )?version\b/;

/**
 * `reasoning` at or over this, with a `standard` or `hard` class, lifts a
 * mechanical keyword seed to `standard`: past "Some" (1), so more than
 * following an existing pattern. A rename JEV scores at 1 stays mechanical.
 */
export const MECHANICAL_SEED_LIFT_REASONING = 1.2;

/**
 * JEV's class proposal, already past its floors (server/jev-hint.ts). Each
 * `apply` flag false means that direction is recorded, not used: shadow mode
 * turns both off, and `spawnHint.applyHard` off keeps a hard answer a record.
 */
export interface TaskClassJevInput {
  proposed: "mechanical" | "hard" | undefined;
  /**
   * JEV disagrees with a mechanical reading on both answers (server/jev-hint.ts
   * `proposeFromAnswers`), so a mechanical keyword seed becomes `standard`.
   * That moves a task to a dearer model, so it rides `applyHard`, the switch
   * every raise needs, not `applyMechanical`.
   */
  liftsMechanicalSeed?: boolean;
  applyMechanical: boolean;
  applyHard: boolean;
}

/**
 * Tiers "jev"/"classified"/"default". The hard seed reads `text` (title and
 * prompt); the mechanical seed reads `mechanicalText` (the title, or the
 * prompt when there is no title), because brief boilerplate such as
 * "run `npm run lint`" would otherwise send real work to the mechanical pool.
 *
 * A risk keyword outranks JEV: JEV cannot lower a task the hard seed marked.
 * JEV outranks the mechanical seed, and lifts it to `standard` when its
 * answers disagree with a mechanical reading.
 */
function classifyTaskClass(
  text: string,
  mechanicalText: string,
  jev: TaskClassJevInput | undefined,
): ResolveTaskClassResult {
  const trimmed = text.trim();
  if (trimmed.length > 0 && HARD_SEED_RE.test(trimmed)) {
    return { taskClass: "hard", source: "classified" };
  }
  if (jev?.proposed === "mechanical" && jev.applyMechanical) {
    return { taskClass: "mechanical", source: "jev" };
  }
  if (jev?.proposed === "hard" && jev.applyHard) {
    return { taskClass: "hard", source: "jev" };
  }
  const mechanicalTrimmed = mechanicalText.trim();
  if (mechanicalTrimmed.length > 0 && MECHANICAL_SEED_RE.test(mechanicalTrimmed)) {
    if (jev?.liftsMechanicalSeed && jev.applyHard) {
      return { taskClass: "standard", source: "jev" };
    }
    return { taskClass: "mechanical", source: "classified" };
  }
  return { taskClass: undefined, source: "default" };
}

/**
 * Resolves how hard a task is, independent of `resolveRole`'s role
 * resolution — a role picks WHO runs the work, this picks HOW MUCH MODEL
 * it's worth. Feeds ONLY model selection (see `classModels` in
 * shared/role-policy-schema.ts); it must never influence tool-profile
 * enforcement, which is role-based and evidence-gated on its own terms.
 *
 * Precedence, mirroring `resolveRole`'s "declared beats guessed" shape but
 * with only two tiers (there is no per-policy task-class vocabulary to
 * configure — TASK_CLASS_IDS is fixed):
 *   1. Declared: labels[paseo.task-class], matched case-insensitively
 *      against the fixed TASK_CLASS_IDS. The cheapest, most trustworthy
 *      signal — the caller is stating what it's asking for.
 *   2. Unknown declared value: never blocks — falls through to
 *      classification/default, with `unknownDeclaredValue` set so the
 *      caller can be told once.
 *   3. Classified: seed-keyword text classification (the hard seed over
 *      title + initialPrompt, the mechanical seed over the title alone), with
 *      JEV's spawn hint between the hard seed and the mechanical seed
 *      (`classifyTaskClass`). A guess here may only ever pick a model;
 *      unlike the role guess it doesn't gate anything else, so there is no
 *      evidence-based/withheld split to make.
 *   4. Default: undefined — classModels() falls back to the role's standard
 *      pool, exactly what happens today with no task-class concept at all.
 */
export function resolveTaskClass(input: ResolveRoleInput, jev?: TaskClassJevInput): ResolveTaskClassResult {
  const declared = input.labels?.[TASK_CLASS_LABEL];
  const classificationText = `${input.title ?? ""} ${input.initialPrompt ?? ""}`.toLowerCase();
  const title = input.title?.trim() ?? "";
  const mechanicalText = (title.length > 0 ? title : (input.initialPrompt ?? "")).toLowerCase();
  if (declared !== undefined) {
    const lower = declared.trim().toLowerCase();
    const matched = (TASK_CLASS_IDS as readonly string[]).find((id) => id === lower);
    if (matched) {
      return { taskClass: matched as TaskClassId, source: "declared" };
    }
    return { ...classifyTaskClass(classificationText, mechanicalText, jev), unknownDeclaredValue: declared };
  }
  return classifyTaskClass(classificationText, mechanicalText, jev);
}
