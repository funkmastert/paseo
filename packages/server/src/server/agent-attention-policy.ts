import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";
import type { NotifyLevel } from "./notify-policy/levels.js";

export const PRESENCE_THRESHOLD_MS = 180_000;

export interface ClientPresenceState {
  appVisible: boolean;
  lastActivityAtMs: number | null;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
}

export type AttentionFocusTarget = { kind: "agent"; id: string } | { kind: "terminal"; id: string };

export interface NotificationPlan {
  inAppRecipientIndex: number | null;
  shouldPush: boolean;
}

interface ComputeNotificationPlanInput {
  allStates: ClientPresenceState[];
  // A present, app-visible client focused on the attention target suppresses the
  // notification entirely. Pass null when the target should not suppress notifications.
  focusTarget: AttentionFocusTarget | null;
  // Whether a push notification is allowed when no client is present.
  pushEligible: boolean;
  nowMs: number;
}

function isFocusedOnTarget(
  state: ClientPresenceState,
  target: AttentionFocusTarget | null,
): boolean {
  if (target === null) {
    return false;
  }
  if (target.kind === "agent") {
    return state.focusedAgentId === target.id;
  }
  return state.focusedTerminalId === target.id;
}

export function computeNotificationPlan({
  allStates,
  focusTarget,
  pushEligible,
  nowMs,
}: ComputeNotificationPlanInput): NotificationPlan {
  let mostRecentPresentIndex: number | null = null;
  let mostRecentPresentAtMs = Number.NEGATIVE_INFINITY;

  for (const [clientIndex, state] of allStates.entries()) {
    const clampedActivityAtMs =
      state.lastActivityAtMs === null ? null : Math.min(state.lastActivityAtMs, nowMs);
    const isPresent =
      clampedActivityAtMs !== null && nowMs - clampedActivityAtMs <= PRESENCE_THRESHOLD_MS;

    if (!isPresent) {
      continue;
    }

    if (state.appVisible && isFocusedOnTarget(state, focusTarget)) {
      return { inAppRecipientIndex: null, shouldPush: false };
    }

    if (clampedActivityAtMs > mostRecentPresentAtMs) {
      mostRecentPresentIndex = clientIndex;
      mostRecentPresentAtMs = clampedActivityAtMs;
    }
  }

  if (mostRecentPresentIndex !== null) {
    return { inAppRecipientIndex: mostRecentPresentIndex, shouldPush: false };
  }

  return { inAppRecipientIndex: null, shouldPush: pushEligible };
}

export function isPushEligibleAttentionReason(reason: AgentAttentionReason): boolean {
  return reason !== "error";
}

const CODE_SPANS = /```[\s\S]*?```|`[^`\n]*`/g;
/** Trailing markdown emphasis/link marks and quote marks, straight or curly, folded by NFKC. */
const TRAILING_WRAPPER_CHARS = /[\s"'`*_)\]>‘’‛′ʼ＇“”]+$/;

/**
 * Whether a root agent's finish asks something in plain text instead of through
 * `AskUserQuestion` — the gap a Claude root agent's Stop hook already catches
 * (docs/ask-user-question.md), but Codex, Pi, OMP, Copilot and OpenCode have no hook for. Only
 * the final message's last non-empty line counts, after code spans and trailing markdown or
 * quote marks are stripped: a `?` earlier in the message, or inside a code block or inline code,
 * is not an ask.
 */
export function isQuestionEndingMessage(finalMessage: string | null): boolean {
  if (!finalMessage) return false;
  const withoutCode = finalMessage.normalize("NFKC").replace(CODE_SPANS, " ");
  const lines = withoutCode.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    return line.replace(TRAILING_WRAPPER_CHARS, "").endsWith("?");
  }
  return false;
}

/**
 * How urgent an agent's attention push is. A permission request blocks the agent on a person, so
 * it is an alert. A finish is a notice — nothing it reports needs interrupting Tyler for, and
 * anything he must actually answer arrives as a permission request instead — unless a ROOT
 * agent's finish asks something in plain text (`isQuestionEndingMessage`): nothing catches that
 * for the providers with no Stop hook, so it is kept an alert instead of silently dropping to a
 * digest. A delegated child's question is never promoted; its parent reads the result in-band. A
 * child whose finish never reaches its parent is escalated separately (docs/finish-reports.md).
 */
export function attentionPushLevel(
  reason: AgentAttentionReason,
  input?: { isRootAgent: boolean; finalMessage: string | null },
): NotifyLevel {
  if (reason !== "finished") return "alert";
  return input?.isRootAgent && isQuestionEndingMessage(input.finalMessage) ? "alert" : "notice";
}
