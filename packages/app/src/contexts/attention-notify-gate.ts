import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";

/**
 * Whether an agent attention event should raise an OS notification. A permission request always
 * does; a finish does only when it is a root agent's plain-text question
 * (`data.isQuestion`, set server-side by `attentionPushLevel`/`isQuestionEndingMessage`) — an
 * ordinary finish needs nobody now.
 */
export function shouldOsNotifyAgentAttention(params: {
  reason: AgentAttentionReason;
  isQuestion: boolean;
}): boolean {
  if (params.reason === "permission") return true;
  if (params.reason === "finished") return params.isQuestion;
  return false;
}

/** A finished terminal needs nobody now; only one waiting on input blocks on a person. */
export function shouldOsNotifyTerminalAttention(reason: "needs_input" | "finished"): boolean {
  return reason === "needs_input";
}
