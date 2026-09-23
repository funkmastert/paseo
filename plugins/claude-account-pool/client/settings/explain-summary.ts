import type { RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";

/**
 * Turns a `role-model-policy.explain` result into the lines the "Test This
 * Name" panel prints.
 *
 * This file states no rule. Every sentence about WHY a decision came out the
 * way it did is `result.reasons.*`, written by the classifier that made the
 * decision (server/classifier.ts). It used to re-derive some of them here —
 * it re-implemented `classModels`'s "this class's pool is empty, so the
 * standard pool decided" fallback, and printed the role's CONFIGURED tool
 * profile even where the create hook would have withheld it — and both
 * drifted from the hook. What's left below is formatting: labels, ordering,
 * and the target spelling.
 *
 * Pure and RN-free on purpose: this is the only part of that panel worth
 * asserting on, and importing the component itself would drag react-native
 * into a node test environment.
 */

/** A bare ref has no provider: say which one, rather than printing "undefined/model". */
export function describeTarget(result: RoleModelPolicyExplainResult): string {
  return result.provider === undefined
    ? `${result.model} on whichever pooled account is healthy`
    : `${result.provider}/${result.model}`;
}

export function describeRole(result: RoleModelPolicyExplainResult): string {
  return `Role: ${result.reasons.role}`;
}

export function describeTaskClass(result: RoleModelPolicyExplainResult): string {
  return `Task class: ${result.reasons.taskClass}`;
}

/** The model line: what would run, then the classifier's own sentence for why. */
export function describeOutcome(result: RoleModelPolicyExplainResult): string {
  const target =
    result.outcome === "unconfigured" ? "the model is left as requested" : `would route to ${describeTarget(result)}`;
  return `Model: ${target} — ${result.reasons.model}`;
}

/**
 * The tools line. `deniedTools` is what would ACTUALLY be removed; a withheld
 * profile is named separately, because "this role is configured read-only but
 * the hook won't enforce it here" is a different fact from either one alone,
 * and showing only the configured profile is what made the preview lie.
 */
export function describeTools(result: RoleModelPolicyExplainResult): string {
  const applied =
    result.deniedTools.length === 0 ? "Tools: nothing denied" : `Tools denied: ${result.deniedTools.join(", ")}`;
  const withheld = result.toolsWithheld
    ? ` Withheld: the ${result.toolsWithheld.profileKind} profile (${result.toolsWithheld.deniedTools.join(", ")}) would apply if the agent were labelled.`
    : "";
  return `${applied} — ${result.reasons.tools}${withheld}`;
}

/** The account line — which pooled account serves it, from the same ladder the account router walks. */
export function describeAccount(result: RoleModelPolicyExplainResult): string {
  const target = result.account.providerId ? `${result.account.providerId} — ` : "";
  return `Account: ${target}${result.reasons.account}`;
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
    return `Explicit request ${override.requestedRef}: honored.`;
  }
  const why =
    override.reason === "not-currently-selectable"
      ? "approved for this role, but not selectable right now (capped, budget-gated, or missing from the catalog)"
      : "not a member of the pool this task class resolves to";
  return `Explicit request ${override.requestedRef}: overridden by policy → ${override.effectiveRef} (${why}). A real agent would carry paseo.model-overridden-by-policy=${override.requestedRef}.`;
}

/** Every line the panel prints, in order. */
export function explainSummaryLines(result: RoleModelPolicyExplainResult): string[] {
  const requested = describeRequestedModel(result);
  return [
    describeRole(result),
    describeTaskClass(result),
    describeOutcome(result),
    describeTools(result),
    describeAccount(result),
    ...(requested ? [requested] : []),
  ];
}
