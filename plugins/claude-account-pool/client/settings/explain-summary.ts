import type { RoleModelPolicyExplainResult } from "../../shared/role-policy-rpc";
import { MCP_SCOPE_LABEL, THINKING_OVERRIDDEN_LABEL } from "../../shared/role-policy-schema";
import { THINKING_LEVEL_LABELS, type ThinkingLevelId } from "../../shared/thinking-levels";

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
    result.outcome === "unconfigured"
      ? "the model is left as requested"
      : `would route to ${describeTarget(result)}${result.modelUnadvertised ? " (UNVERIFIED: the provider's catalog doesn't list it; allowUnlistedModels vouches for it)" : ""}`;
  return `Model: ${target} — ${result.reasons.model}`;
}

/** A level's display name, or the raw id for one this plugin doesn't know (another provider's own token). */
function thinkingLabel(optionId: string): string {
  return THINKING_LEVEL_LABELS[optionId as ThinkingLevelId] ?? optionId;
}

/**
 * The thinking line, the classifier's own sentence. Absent when the plugin
 * predates the thinking decision and sent no reason for it.
 */
export function describeThinking(result: RoleModelPolicyExplainResult): string | undefined {
  return result.reasons.thinking === undefined ? undefined : `Thinking: ${result.reasons.thinking}`;
}

/** The output style line, the classifier's own sentence. Absent when the plugin predates the decision. */
export function describeOutputStyle(result: RoleModelPolicyExplainResult): string | undefined {
  return result.reasons.outputStyle === undefined ? undefined : `Output style: ${result.reasons.outputStyle}`;
}

/**
 * The explicit-thinking line, printed only when a requested level was
 * simulated. Names `paseo.thinking-overridden-by-policy` for the same reason
 * `describeRequestedModel` names its label.
 */
export function describeRequestedThinking(result: RoleModelPolicyExplainResult): string | undefined {
  const requested = result.thinking?.requested;
  if (requested === undefined) {
    return undefined;
  }
  const override = result.thinking?.override;
  if (override === undefined) {
    return `Explicit thinking request ${thinkingLabel(requested)}: honored.`;
  }
  const outcome = override.applied === undefined ? "removed by policy" : `overridden by policy → ${thinkingLabel(override.applied)}`;
  return `Explicit thinking request ${thinkingLabel(requested)}: ${outcome}. A real agent would carry ${THINKING_OVERRIDDEN_LABEL}=${requested}.`;
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

/**
 * The MCP line: the servers the agent would be spawned with, the label a real
 * one would carry, and the classifier's sentence. Absent when the plugin
 * predates MCP scoping.
 */
export function describeMcp(result: RoleModelPolicyExplainResult): string | undefined {
  const mcp = result.mcp;
  if (mcp === undefined || result.reasons.mcp === undefined) {
    return undefined;
  }
  if (!mcp.scoped) {
    return `MCP servers: all — ${result.reasons.mcp}`;
  }
  const servers = mcp.gatewayServers.length > 0 ? mcp.gatewayServers.join(", ") : "none from the gateway";
  const connectors = mcp.claudeAiConnectors ? " + claude.ai connectors" : "";
  return `MCP servers: ${servers}${connectors} — ${result.reasons.mcp} A real agent would carry ${MCP_SCOPE_LABEL}=${mcp.scopeLabel ?? ""}.`;
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
 * Pool entries the catalog doesn't list and the operator hasn't allowlisted.
 * Ordered selection skips them, so without this line an entry that is "in the
 * pool" but never picked looks like a bug in the policy rather than the
 * catalog check working.
 */
export function describeUnadvertisedEntries(result: RoleModelPolicyExplainResult): string | undefined {
  const entries = result.unadvertisedPoolEntries;
  if (entries === undefined || entries.length === 0) {
    return undefined;
  }
  return `Skipped, not in the provider's catalog and not in allowUnlistedModels: ${entries.join(", ")}. Add an id to allowUnlistedModels if the provider does accept it.`;
}

/** Every line the panel prints, in order. */
export function explainSummaryLines(result: RoleModelPolicyExplainResult): string[] {
  const thinking = describeThinking(result);
  const outputStyle = describeOutputStyle(result);
  const requested = describeRequestedModel(result);
  const requestedThinking = describeRequestedThinking(result);
  const unadvertised = describeUnadvertisedEntries(result);
  const mcp = describeMcp(result);
  return [
    describeRole(result),
    describeTaskClass(result),
    describeOutcome(result),
    ...(thinking ? [thinking] : []),
    describeTools(result),
    ...(outputStyle ? [outputStyle] : []),
    ...(mcp ? [mcp] : []),
    describeAccount(result),
    ...(requested ? [requested] : []),
    ...(requestedThinking ? [requestedThinking] : []),
    ...(unadvertised ? [unadvertised] : []),
  ];
}
