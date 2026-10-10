import type { PluginHookContext } from "@getpaseo/plugin/server";
import { WORK_KINDS, type WorkKind } from "../shared/arena-aliases";
import {
  classModels,
  LEADER_ROLE_ID,
  TASK_CLASS_IDS,
  TASK_CLASS_LABEL,
  type RoleModelPolicy,
  type TaskClassId,
} from "../shared/role-policy-schema";
import { classifyAgent, type ClassifierInput, type ClassifierWorld } from "./classifier";
import { MECHANICAL_SEED_LIFT_REASONING, placesRootAsChild, resolveRole, resolveTaskClass } from "./role-resolve";

/**
 * JEV's spawn hint (docs/jev.md, "Feature 2"): one typed call, made by the
 * role hook before the classifier runs, asking what class of work an
 * unlabelled create is — or, while `spawnHint.auditDeclared` is on, what
 * class a declared child's own label should have been, asked in shadow and
 * never applied ("Auditing a declared label"). The classifier takes the
 * answer as one input (`ClassifierInput.jevHint`); this file only asks and
 * reads.
 *
 * Nothing here can fail or slow a create beyond its bound. `fetchSpawnHint`
 * never throws, answers within its plugin timeout (tighter for the
 * declared-label audit than for an ordinary ask) whatever the daemon does,
 * and every outcome but an answer is today's classifier.
 */

/** The feature id `jev.decide` serves to a client. */
export const SPAWN_HINT_FEATURE = "spawnHint";
/** Recorded on the daemon's ledger line. */
export const SPAWN_HINT_CALL_SITE = "account-pool.role-hook";
/** Sent as `deadlineMs`; the daemon clamps it to `agents.jev.spawnHint.timeoutMs`. */
export const SPAWN_HINT_DEADLINE_MS = 1_500;
/** The RPC's own timeout: the deadline plus the round trip. */
export const SPAWN_HINT_RPC_TIMEOUT_MS = SPAWN_HINT_DEADLINE_MS + 250;
/** The plugin's own bound, whatever the RPC does. The role hook's whole budget is 30 s. */
export const SPAWN_HINT_PLUGIN_TIMEOUT_MS = 2_000;
/**
 * The declared-label audit's own, tighter bound: its answer is never applied, so a slow or
 * browned-out JEV should cost the audit a record, not the create extra latency on top of what an
 * ordinary unlabelled ask already pays.
 */
export const SPAWN_HINT_DECLARED_AUDIT_DEADLINE_MS = 750;
export const SPAWN_HINT_DECLARED_AUDIT_RPC_TIMEOUT_MS = SPAWN_HINT_DECLARED_AUDIT_DEADLINE_MS + 250;
export const SPAWN_HINT_DECLARED_AUDIT_PLUGIN_TIMEOUT_MS = 1_000;
/** How much of the prompt goes in the state. */
export const SPAWN_HINT_PROMPT_CHARS = 6_000;

/**
 * The floors. They bias down: a move to a cheaper model needs less agreement
 * than a move to a dearer one, and the dearer moves are off until the shadow
 * day shows they pay. JEV's calibration error is 0.13–0.25, and a hard answer
 * compounds, since it also raises thinking to Extra High.
 */
export const MECHANICAL_CONFIDENCE_FLOOR = 0.65;
/** `reasoning` at or under this agrees with a mechanical answer: between "None" (0) and "Some" (1). */
export const MECHANICAL_REASONING_CEILING = 0.8;
export const HARD_CONFIDENCE_FLOOR = 0.85;
/** `reasoning` at or over this agrees with a hard answer: most of the way to "Deep" (2). */
export const HARD_REASONING_FLOOR = 1.6;
export const ROLE_CONFIDENCE_FLOOR = 0.7;

/** The question ids. JEV never sees them as meaning; it reads the instructions. */
const TASK_CLASS_QUESTION = "task_class";
const REASONING_QUESTION = "reasoning";
const ROLE_QUESTION = "role";
const WORK_KIND_QUESTION = "work_kind";
const OTHER_OPTION = "other";

/** The answers this plugin reads, one per question asked. */
export interface SpawnHintAnswers {
  taskClass?: { choice: string; confidence: number };
  reasoning?: { score: number; confidence: number };
  role?: { choice: string; confidence: number };
  /**
   * The kind of work JEV named (KTD-12). Recorded whenever asked, with no
   * confidence floor: unlike `taskClass`/`role`, a wrong kind only misorders
   * an already-approved pool (U8's ranking), never moves capability or
   * class, so there is nothing for a floor to protect against.
   */
  workKind?: { choice: string; confidence: number };
}

/** What the answers propose once past their floors. Precedence against labels and seeds is the classifier's. */
export interface SpawnHintProposal {
  taskClass?: "mechanical" | "hard";
  /** The answers disagree with a mechanical reading: see `MECHANICAL_SEED_LIFT_REASONING`. */
  liftsMechanicalSeed?: boolean;
  /** A policy role id, never the leader. */
  roleId?: string;
}

/**
 * Why no call was made although JEV is on.
 * - `leader`: a root create is the leader, whose class cannot change its model or thinking.
 * - `declared`: a `paseo.task-class` label decides the class, and the role is not asked.
 * - `hard-seed`: a risk keyword made it hard, which JEV cannot lower, and the role is not asked.
 * - `no-text`: no title or prompt to judge.
 * - `no-effect`: every class runs the same model at the same thinking level for this role, AND
 *   arena ranking is off or the resolved class has fewer than two candidates to reorder (KTD-12).
 */
export type SpawnHintSkip = "leader" | "declared" | "hard-seed" | "no-text" | "no-effect";

export type SpawnHint =
  | { status: "not-needed"; reason: SpawnHintSkip }
  /**
   * The preview and the classifier tool: a live create would ask and apply
   * the answer, so the class (and the role, when `role`) is decided then.
   * Never fetched: a preview must not spend.
   */
  | { status: "decided-at-create"; role: boolean }
  | { status: "unavailable" | "failed"; reason: string; callId?: string }
  | {
      status: "answered" | "shadow";
      callId: string;
      answers: SpawnHintAnswers;
      proposal: SpawnHintProposal;
      /** `spawnHint.applyHard` as the last `jev.status` poll read it. */
      applyHard: boolean;
      /** `spawnHint.applyRole` as the last `jev.status` poll read it. */
      applyRole: boolean;
      /**
       * Carries `SpawnHintPlan.declaredAudit` through to the classifier and the labels it writes.
       * A declared child's class source is `declared` whether this call was the declared-label
       * audit or an ordinary role-only ask on the same child (`applyRole` winning over the audit,
       * see `planSpawnHint`) — the label alone cannot tell those apart, so the savings track reads
       * this flag instead of re-deriving it from the class source.
       */
      declaredAudit: boolean;
    };

/** The daemon's spawn-hint switches, from the last `jev.status` poll (server/jev-availability.ts). */
export interface SpawnHintAvailability {
  /** A call could be sent now: key, switches, the control lane's budget and circuit. */
  active: boolean;
  /** Why not, when not. */
  reason: string | null;
  shadow: boolean;
  applyHard: boolean;
  applyRole: boolean;
  /** `agents.jev.spawnHint.auditDeclared`: ask a declared child too, always in shadow. */
  auditDeclared: boolean;
}

export type SpawnHintPlan =
  | { ask: false; skip: SpawnHintSkip }
  | {
      ask: true;
      taskClass: boolean;
      role: boolean;
      /**
       * Whether `work_kind` rides this call (KTD-12): ranking is on (live or shadow) and the
       * resolved class has at least two approved candidates for it to reorder. Independent of
       * `taskClass`/`role` — a create can ask only the kind question when neither of those applies.
       */
      workKind: boolean;
      /**
       * A declared `paseo.task-class` label decided this create already; the answer is asked only
       * to measure it (`agents.jev.spawnHint.auditDeclared`, docs/jev.md "Feature 2") and must
       * never move the label, model or thinking. `fetchSpawnHint` sends it as `shadow: true` so
       * the call can never count as a live answer, whatever `spawnHint.shadow` says.
       */
      declaredAudit: boolean;
      /** The declared class, normalized, present only when `declaredAudit` is true. */
      declaredTaskClass?: TaskClassId;
    };

/** The model and thinking a class would give this create. Two classes that agree cannot be told apart by an answer. */
function outcomeKey(input: ClassifierInput, world: ClassifierWorld, taskClass: string): string {
  const decision = classifyAgent(
    { ...input, labels: { ...input.labels, [TASK_CLASS_LABEL]: taskClass }, jevHint: undefined },
    { ...world, jevToolsAvailable: undefined },
  );
  return `${decision.model.provider ?? ""}/${decision.model.model ?? ""} ${decision.thinking.optionId ?? ""}`;
}

/**
 * Whether a call could change this create, from the classifier alone. Pure.
 *
 * The class is asked when nothing declares one, no risk keyword already made
 * it hard, and the three classes give the role (resolved without JEV)
 * different models or thinking. The role rides on
 * that call for a child whose role is a keyword guess; it earns a call of its
 * own only with `applyRole` on. A root create is the leader and never asks:
 * the leader's thinking comes from the leader rule and its pools do not
 * change with the class, and even where a policy made them, a person started
 * it and chose what it runs.
 *
 * `work_kind` (KTD-12) rides the same call whenever `options.rankingActive`
 * is on and the resolved class has at least two approved candidates to
 * reorder — independent of whether the class or role also matters, since a
 * kind answer never moves either of those, only U8's ranking. `rankingActive`
 * is a plain caller-supplied flag rather than a read off `world.policy.arena`:
 * that key is optional and PR B's own addition (KTD-13), so this function
 * stays buildable and testable without it existing yet.
 *
 * With `auditDeclared` on, a child with a caller and a valid `paseo.task-class`
 * label is asked the class alone, in shadow (`declaredAudit: true`) — unless a
 * live `applyRole` ask on the same child's guessed role would also apply, which
 * wins instead, since one call cannot serve both. A schedule-run root create,
 * placed like a child only for role resolution, stays unasked like any other
 * root create. A declared child whose kind could still matter (ranking would
 * reorder its already-fixed class's pool) gets the same shadow treatment for
 * `work_kind` alone, even with `auditDeclared` off: the declared label still
 * decides the model, so recording the kind can only ever be in shadow for it.
 */
export function planSpawnHint(
  input: ClassifierInput,
  world: ClassifierWorld,
  options: { applyRole: boolean; auditDeclared: boolean; rankingActive: boolean },
): SpawnHintPlan {
  const hasCaller = input.callerAgentId !== undefined && input.callerAgentId !== "";
  if (!hasCaller && !placesRootAsChild(world.policy, input.labels)) {
    return { ask: false, skip: "leader" };
  }
  if (`${input.title ?? ""} ${input.initialPrompt ?? ""}`.trim().length === 0) {
    return { ask: false, skip: "no-text" };
  }
  const textInput = { labels: input.labels, title: input.title, initialPrompt: input.initialPrompt };
  const baseline = resolveTaskClass(textInput);
  const fixed: SpawnHintSkip | null =
    baseline.source === "declared"
      ? "declared"
      : baseline.source === "classified" && baseline.taskClass === "hard"
        ? "hard-seed"
        : null;
  const roleResolution = resolveRole(world.policy, textInput);
  const roleGuessed = hasCaller && roleResolution.tier >= 3;
  const workKindMatters =
    options.rankingActive && classModels(roleResolution.role, baseline.taskClass ?? "standard").length >= 2;
  // The audit only measures a genuine child's own declared label: a schedule-run root create is
  // placed like a child for role resolution, but it is a person's or a daemon job's own call, not
  // another agent's, and stays unasked like any other root create. A live role ask wins over it
  // when both apply — `shadow: true` covers the whole call, so one ask cannot serve both, and the
  // plan's stop condition forbids the audit silently stopping today's `applyRole` from working.
  if (
    fixed === "declared" &&
    hasCaller &&
    !(roleGuessed && options.applyRole) &&
    (options.auditDeclared || workKindMatters)
  ) {
    return {
      ask: true,
      taskClass: options.auditDeclared,
      role: false,
      workKind: workKindMatters,
      declaredAudit: true,
      declaredTaskClass: baseline.taskClass,
    };
  }
  const classMatters =
    fixed === null && new Set(TASK_CLASS_IDS.map((taskClass) => outcomeKey(input, world, taskClass))).size > 1;
  if (classMatters || (fixed === null && workKindMatters)) {
    return { ask: true, taskClass: classMatters, role: roleGuessed, workKind: workKindMatters, declaredAudit: false };
  }
  if (roleGuessed && options.applyRole) {
    return { ask: true, taskClass: false, role: true, workKind: workKindMatters, declaredAudit: false };
  }
  if (fixed === "hard-seed" && workKindMatters) {
    return { ask: true, taskClass: false, role: roleGuessed, workKind: true, declaredAudit: false };
  }
  return { ask: false, skip: fixed ?? "no-effect" };
}

/**
 * What the preview and the classifier tool pass instead of a hint: nothing,
 * unless a live create would ask JEV and could act on the answer. In shadow
 * mode the create does exactly what the preview says, so it says nothing.
 */
export function spawnHintPreview(
  input: ClassifierInput,
  world: ClassifierWorld,
  availability: SpawnHintAvailability | undefined,
  /** Whether arena ranking (live or shadow) is on. Defaults off: a caller that predates U8's `arena` policy key never asks `work_kind`. */
  rankingActive = false,
): SpawnHint | undefined {
  if (!availability?.active || availability.shadow) {
    return undefined;
  }
  const plan = planSpawnHint(input, world, {
    applyRole: availability.applyRole,
    auditDeclared: availability.auditDeclared,
    rankingActive,
  });
  // A declared-audit ask never decides anything — the label already did — so the preview says
  // nothing, the same as any other declared create.
  if (!plan.ask || plan.declaredAudit) {
    return undefined;
  }
  return { status: "decided-at-create", role: plan.role && availability.applyRole };
}

/**
 * The state sent: title, the start of the prompt, who spawned it, and the normalized declared
 * class for the declared-label audit (docs/jev.md, "Auditing a declared label") — never a raw
 * label value, and never for any other ask: an unrecognized `paseo.task-class` value falls
 * through to an ordinary live ask, which must not leak the label into its state.
 */
export function buildSpawnHintState(
  input: ClassifierInput,
  declaredTaskClass?: TaskClassId,
): Record<string, string> {
  const hasCaller = input.callerAgentId !== undefined && input.callerAgentId !== "";
  return {
    title: input.title ?? "",
    prompt: (input.initialPrompt ?? "").slice(0, SPAWN_HINT_PROMPT_CHARS),
    spawned_by: hasCaller ? "another agent" : "a person or a daemon job",
    ...(declaredTaskClass !== undefined ? { declared_task_class: declaredTaskClass } : {}),
  };
}

const STANDARD_ROLE_CRITERIA: Record<string, string> = {
  worker: "Makes the change: implements, fixes, edits files, runs builds and tests",
  reviewer: "Judges existing work without changing it: reviews a diff, verifies a claim, audits for defects",
  advisor: "Finds things out and recommends: researches, investigates, compares options, gives a second opinion",
};

type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };

/** The role question's options: the policy's roles minus the leader, then `other`. */
function roleCriteria(policy: RoleModelPolicy): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const role of policy.roles) {
    if (role.id === LEADER_ROLE_ID || role.id === OTHER_OPTION) {
      continue;
    }
    const aliases = role.aliases.length > 0 ? `, also called ${role.aliases.join(", ")}` : "";
    criteria[role.id] = STANDARD_ROLE_CRITERIA[role.id] ?? `An operator-defined role named ${role.name}${aliases}`;
  }
  criteria[OTHER_OPTION] = "None of these";
  return criteria;
}

/** `work_kind`'s options (KTD-12): the boards KTD-11 ranks, plus `other` for anything else. */
const WORK_KIND_CRITERIA: Record<WorkKind, string> = {
  coding: "Implements, fixes, or refactors code; writes or updates tests; runs builds",
  frontend: "Builds or styles UI: screens, components, layout, CSS, web pages",
  research: "Investigates or compares options without changing code: a root-cause hunt, a design survey",
  review: "Judges existing work without changing it: reviews a diff, verifies a claim, audits for defects",
  writing: "Produces prose: documentation, a changelog, a commit message, a plan or report",
  ops: "Runs or recovers infrastructure: deploys, incident response, environment or process repair",
  other: "None of these, or too little text to tell",
};

/** The questions for a plan that asks. */
export function buildSpawnHintQuestions(
  policy: RoleModelPolicy,
  plan: { taskClass: boolean; role: boolean; workKind: boolean },
): Record<string, ChoiceQuestion | ScoreQuestion> {
  const questions: Record<string, ChoiceQuestion | ScoreQuestion> = {};
  if (plan.taskClass) {
    questions[TASK_CLASS_QUESTION] = {
      type: "choice",
      instructions:
        "Which class of work does `prompt` hand to the new agent? Judge the work it asks for, not the length or tone of `prompt`.",
      criteria: {
        mechanical:
          "Rote and fully specified: a rename, a formatting pass, a version bump, a changelog line, copying or moving text, running named commands and reporting the output",
        standard:
          "Ordinary engineering in a known area: implement or fix a described behaviour, write or update tests, review a bounded change, research a specific question",
        hard: "Open-ended or high-stakes: design across several modules, concurrency, security or data-loss risk, a migration, a root-cause hunt without a lead, or choosing between approaches",
        [OTHER_OPTION]: "Not a task: a greeting, a status question, or too little text to tell",
      },
    };
    questions[REASONING_QUESTION] = {
      type: "score",
      instructions: "How much reasoning does the work in `prompt` need before the first change is made?",
      criteria: [
        "None: the steps are spelled out and only need doing",
        "Some: read a few files, then follow an existing pattern",
        "Deep: weigh approaches, trace behaviour across modules, or reason about failure modes",
      ],
    };
  }
  if (plan.role) {
    questions[ROLE_QUESTION] = {
      type: "choice",
      instructions: "Which kind of agent does `prompt` ask for?",
      criteria: roleCriteria(policy),
    };
  }
  if (plan.workKind) {
    questions[WORK_KIND_QUESTION] = {
      type: "choice",
      instructions: "Which kind of work does `prompt` hand to the new agent?",
      criteria: WORK_KIND_CRITERIA,
    };
  }
  return questions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readChoice(value: unknown): { choice: string; confidence: number } | null {
  if (!isRecord(value) || value.type !== "choice" || typeof value.choice !== "string" || !finite(value.confidence)) {
    return null;
  }
  return { choice: value.choice, confidence: value.confidence };
}

function readScore(value: unknown): { score: number; confidence: number } | null {
  if (!isRecord(value) || value.type !== "score" || !finite(value.score) || !finite(value.confidence)) {
    return null;
  }
  return { score: value.score, confidence: value.confidence };
}

/**
 * The answers to the questions asked, or null when any is missing or the
 * wrong shape. The daemon validated them against the contract; this is the
 * plugin not trusting a wire it does not own.
 */
export function readSpawnHintAnswers(
  raw: unknown,
  plan: { taskClass: boolean; role: boolean; workKind: boolean },
): SpawnHintAnswers | null {
  if (!isRecord(raw)) {
    return null;
  }
  const answers: SpawnHintAnswers = {};
  if (plan.taskClass) {
    const taskClass = readChoice(raw[TASK_CLASS_QUESTION]);
    const reasoning = readScore(raw[REASONING_QUESTION]);
    if (!taskClass || !reasoning) {
      return null;
    }
    answers.taskClass = taskClass;
    answers.reasoning = reasoning;
  }
  if (plan.role) {
    const role = readChoice(raw[ROLE_QUESTION]);
    if (!role) {
      return null;
    }
    answers.role = role;
  }
  if (plan.workKind) {
    const workKind = readChoice(raw[WORK_KIND_QUESTION]);
    if (!workKind) {
      return null;
    }
    answers.workKind = workKind;
  }
  return answers;
}

/**
 * The answers past their floors. Pure. A mechanical class needs the class
 * answer and the reasoning score to agree; so does a hard one, at higher
 * floors. A `standard` or `hard` class at `MECHANICAL_SEED_LIFT_REASONING`
 * or more also sets `liftsMechanicalSeed`. `other` and anything under every
 * floor propose nothing.
 */
export function proposeFromAnswers(answers: SpawnHintAnswers, policy: RoleModelPolicy): SpawnHintProposal {
  const proposal: SpawnHintProposal = {};
  const { taskClass, reasoning, role } = answers;
  if (taskClass && reasoning) {
    if (
      taskClass.choice === "mechanical" &&
      taskClass.confidence >= MECHANICAL_CONFIDENCE_FLOOR &&
      reasoning.score <= MECHANICAL_REASONING_CEILING
    ) {
      proposal.taskClass = "mechanical";
    } else if (
      taskClass.choice === "hard" &&
      taskClass.confidence >= HARD_CONFIDENCE_FLOOR &&
      reasoning.score >= HARD_REASONING_FLOOR
    ) {
      proposal.taskClass = "hard";
    }
    if (
      (taskClass.choice === "standard" || taskClass.choice === "hard") &&
      reasoning.score >= MECHANICAL_SEED_LIFT_REASONING
    ) {
      proposal.liftsMechanicalSeed = true;
    }
  }
  if (
    role &&
    role.choice !== OTHER_OPTION &&
    role.choice !== LEADER_ROLE_ID &&
    role.confidence >= ROLE_CONFIDENCE_FLOOR &&
    policy.roles.some((candidate) => candidate.id === role.choice)
  ) {
    proposal.roleId = role.choice;
  }
  return proposal;
}

/** The slice of the plugin's Paseo handle this needs. `jev` is absent on a daemon without JEV. */
export type SpawnHintPaseo = { readonly jev?: Partial<Pick<NonNullable<PluginHookContext["paseo"]["jev"]>, "decide">> };

export interface FetchSpawnHintOptions {
  input: ClassifierInput;
  /** The new agent's cwd, the D7 scope. */
  cwd: string | undefined;
  /** The cached world; the check can start before the per-create policy refresh finishes. */
  world: ClassifierWorld;
  /**
   * Undefined before the first successful `jev.status` poll, after one fails,
   * or on a daemon without JEV. Undefined asks nothing.
   */
  availability: SpawnHintAvailability | undefined;
  paseo: SpawnHintPaseo;
  /**
   * Whether arena ranking (live or shadow) is on, so `work_kind` (KTD-12) can
   * ride this call. Defaults off: a caller that predates U8's `arena` policy
   * key never asks it.
   */
  rankingActive?: boolean;
  /** Tests only. */
  timeoutMs?: number;
}

const TIMED_OUT = Symbol("timed-out");

/** The daemon's call ids are short opaque strings. */
const MAX_CALL_ID_CHARS = 200;

function readCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CALL_ID_CHARS ? value : undefined;
}

async function withinBound<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks JEV for the hint, or says why not. Never throws, and answers within
 * `SPAWN_HINT_PLUGIN_TIMEOUT_MS` whatever the RPC does: a stalled call is
 * `unavailable: plugin-timeout`, which is today's classifier.
 */
export async function fetchSpawnHint(options: FetchSpawnHintOptions): Promise<SpawnHint> {
  try {
    const { input, world, availability, paseo } = options;
    const plan = planSpawnHint(input, world, {
      applyRole: availability?.applyRole ?? false,
      auditDeclared: availability?.auditDeclared ?? false,
      rankingActive: options.rankingActive ?? false,
    });
    if (!plan.ask) {
      return { status: "not-needed", reason: plan.skip };
    }
    // COMPAT(jevPaseoApi): added in v0.8.x, remove after 2027-03-28. A plugin reloaded against a
    // daemon without JEV has no `paseo.jev`, and calling it would be a TypeError.
    const jev = paseo.jev;
    if (typeof jev?.decide !== "function") {
      return { status: "unavailable", reason: "no-jev-api" };
    }
    // Only a poll that answered and said the hint can send lets a create ask. No answer yet, a
    // failed poll, or a daemon that rejects `jev.status` is JEV unavailable, and asks nothing.
    if (!availability?.active) {
      return { status: "unavailable", reason: availability?.reason ?? "no-status" };
    }
    if (!options.cwd) {
      return { status: "unavailable", reason: "no-cwd" };
    }
    const hasCaller = input.callerAgentId !== undefined && input.callerAgentId !== "";
    const response = await withinBound(
      jev.decide(
        {
          feature: SPAWN_HINT_FEATURE,
          callSite: SPAWN_HINT_CALL_SITE,
          state: buildSpawnHintState(input, plan.declaredTaskClass),
          questions: buildSpawnHintQuestions(world.policy, plan),
          scope: { cwd: options.cwd, ...(hasCaller ? { parentAgentId: input.callerAgentId } : {}) },
          // The declared-label audit's answer is never applied, so it gets its own tighter bound:
          // a timeout there should cost the audit a record, not the create extra latency on top
          // of what an ordinary unlabelled ask already pays.
          deadlineMs: plan.declaredAudit ? SPAWN_HINT_DECLARED_AUDIT_DEADLINE_MS : SPAWN_HINT_DEADLINE_MS,
          // The declared-label audit must never count as a live answer, whatever
          // `spawnHint.shadow` says: it can only make the call shadow, never live.
          ...(plan.declaredAudit ? { shadow: true as const } : {}),
        },
        { timeout: plan.declaredAudit ? SPAWN_HINT_DECLARED_AUDIT_RPC_TIMEOUT_MS : SPAWN_HINT_RPC_TIMEOUT_MS },
      ),
      options.timeoutMs ??
        (plan.declaredAudit ? SPAWN_HINT_DECLARED_AUDIT_PLUGIN_TIMEOUT_MS : SPAWN_HINT_PLUGIN_TIMEOUT_MS),
    );
    if (response === TIMED_OUT) {
      return { status: "unavailable", reason: "plugin-timeout" };
    }
    if (!isRecord(response)) {
      return { status: "failed", reason: "contract" };
    }
    // The call id becomes a label, and a label that is not a string makes the daemon refuse the
    // create. Anything else is a broken contract, read as no answer.
    const callId = readCallId(response.callId);
    if (response.outcome === "answered" || response.outcome === "shadow") {
      const answers = callId === undefined ? null : readSpawnHintAnswers(response.answers, plan);
      if (callId === undefined || !answers) {
        return { status: "failed", reason: "contract", ...(callId !== undefined ? { callId } : {}) };
      }
      return {
        // Defense in depth: the declared-label audit requested `shadow: true`, which the daemon
        // enforces (service.ts), but a daemon that ignored the flag must still never read here as
        // a live answer.
        status: plan.declaredAudit ? "shadow" : response.outcome,
        callId,
        answers,
        proposal: proposeFromAnswers(answers, world.policy),
        applyHard: availability.applyHard,
        applyRole: availability.applyRole,
        declaredAudit: plan.declaredAudit,
      };
    }
    return {
      status: response.outcome === "unavailable" ? "unavailable" : "failed",
      reason:
        typeof response.reason === "string"
          ? response.reason
          : typeof response.outcome === "string"
            ? response.outcome
            : "contract",
      ...(callId !== undefined ? { callId } : {}),
    };
  } catch {
    return { status: "unavailable", reason: "error" };
  }
}
