import type { RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import { TASK_CLASS_IDS, type RoleRecord, type TaskClassId } from "../../shared/role-policy-schema";

/**
 * Turns a `role-model-policy.explain` result into the lines the "Test This
 * Name" panel prints. Pure and RN-free on purpose: this is the only part of
 * that panel worth asserting on, and importing the component itself would
 * drag react-native into a node test environment.
 */

/** The pool labels used on the role card, so the two screens name the same thing the same way. */
const POOL_LABEL: Record<TaskClassId, string> = {
  mechanical: "Mechanical",
  standard: "Standard",
  hard: "Hard",
};

const TIER_LABEL: Record<RoleModelPolicyExplainResult["tier"], string> = {
  1: "exact mapping",
  2: "declared role label",
  3: "automatic classification",
  4: "default",
};

const SOURCE_LABEL: Record<RoleModelPolicyExplainResult["taskClassSource"], string> = {
  declared: "declared by the caller",
  classified: "guessed from the text",
  default: "neither declared nor recognized",
};

/** A bare ref has no provider: say which one, rather than printing "undefined/model". */
export function describeTarget(result: RoleModelPolicyExplainResult): string {
  return result.provider === undefined
    ? `${result.model} on whichever pooled account is healthy`
    : `${result.provider}/${result.model}`;
}

function describeTools(result: RoleModelPolicyExplainResult): string {
  return result.deniedTools.length === 0 ? "" : ` Tools denied: ${result.deniedTools.join(", ")}.`;
}

export function describeOutcome(result: RoleModelPolicyExplainResult): string {
  const tierLabel = TIER_LABEL[result.tier];
  const tools = describeTools(result);
  switch (result.outcome) {
    case "unconfigured":
      return `→ ${result.roleName} (via ${tierLabel}), no model configured: the model is left as requested.${tools}`;
    case "selected":
      return `→ ${result.roleName} (via ${tierLabel}): would route to ${describeTarget(result)}.${tools}`;
    case "unavailable":
      return `→ ${result.roleName} (via ${tierLabel}): no eligible model right now; falls back to ${describeTarget(result)}.${tools}`;
  }
}

/** The models array backing a class's own override pool — empty means "falls back to Standard". */
function overridePool(role: RoleRecord, taskClass: TaskClassId): readonly string[] {
  if (taskClass === "mechanical") return role.mechanicalModels;
  if (taskClass === "hard") return role.hardModels;
  return role.models;
}

/**
 * Which pool actually decided the model. `classModels()` silently falls back
 * to the standard pool when a class's own override pool is empty, and that
 * fallback is exactly the thing an operator misreads as "my Hard pool is
 * being ignored" — so name it when we can see it. `role` is undefined when
 * the caller has no policy loaded to look the role up in; the sentence then
 * states the class without claiming which pool served it.
 */
function describePool(result: RoleModelPolicyExplainResult, role: RoleRecord | undefined): string {
  const taskClass = result.taskClass;
  if (taskClass === undefined || taskClass === "standard") {
    return "the Standard pool decided";
  }
  if (role === undefined) {
    return `the ${POOL_LABEL[taskClass]} pool decided (or the Standard pool, if that one is empty)`;
  }
  return overridePool(role, taskClass).length > 0
    ? `the ${POOL_LABEL[taskClass]} pool decided`
    : `the ${POOL_LABEL[taskClass]} pool is empty, so the Standard pool decided`;
}

/**
 * The task-class line. Always printed, including for the no-class case —
 * "nothing classified this, so it got the everyday pool" is the answer to
 * the question the panel is most often opened to ask, and leaving it out is
 * what made the dimension invisible in the first place.
 */
export function describeTaskClass(
  result: RoleModelPolicyExplainResult,
  role: RoleRecord | undefined,
): string {
  const source = SOURCE_LABEL[result.taskClassSource];
  const pool = describePool(result, role);
  const ignored =
    result.unknownDeclaredTaskClass !== undefined
      ? ` Ignored "${result.unknownDeclaredTaskClass}": not one of ${TASK_CLASS_IDS.join(", ")}.`
      : "";
  if (result.taskClass === undefined) {
    return `Task class: none (${source}) — ${pool}.${ignored}`;
  }
  return `Task class: ${result.taskClass} (${source}) — ${pool}.${ignored}`;
}

/**
 * The explicit-request line, printed only when one was simulated. Names the
 * `paseo.model-overridden-by-policy` label so what's visible here and what's
 * visible on a real overridden agent are recognizably the same fact.
 */
export function describeRequestedModel(result: RoleModelPolicyExplainResult): string | undefined {
  const override = result.requestedModelOverride;
  if (override === undefined) {
    return undefined;
  }
  if (override.honored) {
    return override.unadvertised
      ? `Explicit request ${override.requestedRef}: honored, UNVERIFIED — the provider's catalog doesn't list it; allowed by allowUnlistedModels. A real agent would carry paseo.model-unadvertised=${override.requestedRef}.`
      : `Explicit request ${override.requestedRef}: honored.`;
  }
  const why =
    override.reason === "not-currently-selectable"
      ? override.missingFromCatalog
        ? "approved for this role, but the provider's catalog doesn't list it and allowUnlistedModels doesn't name it"
        : "approved for this role, but not selectable right now (capped, budget-gated, or no viable account)"
      : "not a member of the pool this task class resolves to";
  return `Explicit request ${override.requestedRef}: overridden by policy → ${override.effectiveRef} (${why}). A real agent would carry paseo.model-overridden-by-policy=${override.requestedRef}.`;
}

/**
 * Pool entries the catalog doesn't list. Ordered selection skips them, so
 * without this line an entry that is "in the pool" but never picked looks
 * like a bug in the policy rather than the catalog check working.
 */
export function describeUnadvertisedEntries(result: RoleModelPolicyExplainResult): string | undefined {
  const entries = result.unadvertisedPoolEntries;
  if (entries === undefined || entries.length === 0) {
    return undefined;
  }
  return `Not in the provider's catalog: ${entries.join(", ")}. Ordered selection skips these; only an explicit request for one listed in allowUnlistedModels can run it.`;
}

/** Every line the panel prints, in order. */
export function explainSummaryLines(
  result: RoleModelPolicyExplainResult,
  role: RoleRecord | undefined,
): string[] {
  const requested = describeRequestedModel(result);
  const unadvertised = describeUnadvertisedEntries(result);
  return [
    describeOutcome(result),
    describeTaskClass(result, role),
    ...(requested ? [requested] : []),
    ...(unadvertised ? [unadvertised] : []),
  ];
}
