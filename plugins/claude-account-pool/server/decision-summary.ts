import type { AgentDecision } from "./classifier";
import { AGENT_ROLE_LABEL, AGENT_TYPE_LABEL, TASK_CLASS_LABEL, THINKING_OVERRIDDEN_LABEL } from "../shared/role-policy-schema";

/**
 * One `AgentDecision` rendered as plain text, for a caller asking what a task
 * SHOULD run as before it spawns anything — the `agent_model_policy` MCP tool
 * (server/classifier-tool.ts).
 *
 * It states the decision and the classifier's own reasons, then the labels
 * that would make it stick. That last part is the whole reason the tool
 * exists: an agent that learns "a guessed role can't set tools" is only
 * helped if it also learns which label to set instead.
 */
export function describeDecision(decision: AgentDecision): string {
  const { role, taskClass, model, tools, account, thinking } = decision;
  const lines: string[] = [];

  lines.push(`Role: ${role.role.name} (${role.source}) — ${role.reason}`);
  lines.push(`Task class: ${taskClass.taskClass ?? "none"} (${taskClass.source}) — ${taskClass.reason}`);

  const target =
    model.outcome === "unconfigured"
      ? "whatever model the request names (this role has no pool)"
      : model.provider === null
        ? `${model.model} on whichever pooled account is healthy`
        : `${model.provider}/${model.model}`;
  lines.push(`Model: ${target} — ${model.reason}`);
  lines.push(`Pool (${model.poolSlot}): ${model.pool.length > 0 ? model.pool.join(", ") : "empty"}`);
  lines.push(
    `Thinking: ${thinking.reason}${thinking.override ? ` The create would be labelled ${THINKING_OVERRIDDEN_LABEL}=${thinking.override.requested}.` : ""}`,
  );

  lines.push(
    tools.deniedTools.length === 0
      ? `Tools: nothing denied — ${tools.reason}`
      : `Tools denied: ${tools.deniedTools.join(", ")} — ${tools.reason}`,
  );
  if (tools.withheld) {
    lines.push(`Tools withheld: ${tools.withheld.reason}`);
  }

  if (account.kind !== "not-evaluated") {
    lines.push(`Account: ${account.providerId ?? account.kind} — ${account.reason}`);
  }

  lines.push(`To get exactly this, label the create: ${labelAdvice(decision)}`);
  return lines.join("\n");
}

/**
 * The labels that would make this decision explicit rather than guessed.
 *
 * A role that was guessed gets `paseo.agent-role` named outright — that is the
 * difference between a profile that applies and one that is withheld. A task
 * class that was guessed or defaulted gets `paseo.task-class`, because the
 * seeds only recognize fairly unambiguous text and everything else silently
 * lands on the standard pool.
 */
function labelAdvice(decision: AgentDecision): string {
  const parts: string[] = [];
  if (decision.role.source === "agent-type-mapping") {
    parts.push(`${AGENT_TYPE_LABEL}=<the mapped agent type> (already explicit)`);
  } else if (decision.role.source === "leader-tier") {
    parts.push("nothing — a root agent is the leader by structure");
  } else {
    parts.push(`${AGENT_ROLE_LABEL}=${decision.role.role.name.toLowerCase()}`);
  }
  parts.push(`${TASK_CLASS_LABEL}=${decision.taskClass.taskClass ?? "standard"}`);
  return parts.join(", ");
}
