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
const URL_PATTERN = /https?:\/\/\S+/gi;
const LEADING_BLOCKQUOTE = /^>+\s*/;

/**
 * Trailing markdown emphasis/link marks and quote marks, straight or curly, folded by NFKC, plus
 * whitespace. An end-index walk over a `Set`, not a regex: a `[chars]+$` character-class trim
 * re-tries the quantifier at every position on a long line with no trailing match, which is
 * quadratic on a pathological input (a 60k-char line with nothing to strip). The walk is one pass.
 */
const TRAILING_WRAPPER_CHAR_SET = new Set([
  '"',
  "'",
  "`",
  "*",
  "_",
  ")",
  "]",
  ">",
  "‘",
  "’",
  "‛",
  "′",
  "ʼ",
  "＇",
  "“",
  "”",
]);

const WHITESPACE = /\s/;

function isTrailingWrapperChar(ch: string): boolean {
  return TRAILING_WRAPPER_CHAR_SET.has(ch) || WHITESPACE.test(ch);
}

function stripTrailingWrapperChars(text: string): string {
  let end = text.length;
  while (end > 0 && isTrailingWrapperChar(text[end - 1]!)) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * Strips closed code spans/fences, an unclosed fence's tail (its content doesn't count either),
 * and URLs — the same scrub `findFinishVeto` (`attention-push-triage.ts`) applies before its own
 * "?" check, shared so the two agree on what counts as a question mark.
 */
export function stripCodeAndUrls(text: string): string {
  const withoutClosedSpans = text.replace(CODE_SPANS, " ");
  const unclosedFenceAt = withoutClosedSpans.indexOf("```");
  const withoutCode =
    unclosedFenceAt === -1 ? withoutClosedSpans : withoutClosedSpans.slice(0, unclosedFenceAt);
  return withoutCode.replace(URL_PATTERN, " ");
}

const LIST_LINE = /^(?:[-*•]|\d+[.)])\s+\S/;
/** How many trailing list-item lines (an `AskUserQuestion`-style numbered/bulleted menu) count. */
const MAX_LIST_LINES = 6;
/** How many trailing non-list lines, past the list block, are read looking for the question. */
const MAX_NON_LIST_LINES = 3;

const TRAILING_EMOJI = /[\p{Extended_Pictographic}️‍\s]+$/u;
const TRAILING_PARENTHETICAL = /\s*\([^()\n]{1,20}\)\s*$/;
/** "Want me to continue? Let me know." / "...? Thanks." — a short sign-off after the question. */
const SIGN_OFF_PHRASES = ["let me know", "thanks", "thank you", "appreciate it", "cheers"];
const TRAILING_SIGN_OFF = new RegExp(
  `(?:^|(?<=[.!?]))\\s*(?:${SIGN_OFF_PHRASES.join("|")})[.!]?\\s*$`,
  "i",
);

/** Strips trailing emoji and a short trailing parenthetical, e.g. "Proceed? (y/n)" -> "Proceed?". */
function stripTrailingDecoration(line: string): string {
  let text = line;
  for (;;) {
    const withoutEmoji = text.replace(TRAILING_EMOJI, "");
    const withoutParenthetical = withoutEmoji.replace(TRAILING_PARENTHETICAL, "");
    if (withoutParenthetical === text) return text;
    text = withoutParenthetical;
  }
}

function endsWithQuestionMark(line: string): boolean {
  let text = line;
  for (;;) {
    const stripped = stripTrailingWrapperChars(stripTrailingDecoration(text));
    if (stripped.endsWith("?")) return true;
    const withoutSignOff = text.replace(TRAILING_SIGN_OFF, "");
    if (withoutSignOff === text) return false;
    text = withoutSignOff;
  }
}

/** A line that is nothing but a sign-off, e.g. a trailing "Let me know." line of its own. */
function isPureSignOff(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.replace(TRAILING_SIGN_OFF, "").length === 0;
}

/**
 * Whether a root agent's finish asks something in plain text instead of through
 * `AskUserQuestion` — the gap a Claude root agent's Stop hook already catches
 * (docs/ask-user-question.md), but Codex, Pi, OMP, Copilot and OpenCode have no hook for. Reads at
 * most the last `MAX_NON_LIST_LINES` non-list lines, plus one trailing list block of up to
 * `MAX_LIST_LINES` lines (an options menu after the question) — never more, so a `?` buried
 * earlier in a long report never counts. A `?` inside a code block, inline code, or a URL is not
 * an ask, and a leading blockquote `>` is stripped before a line is read. A trailing emoji, a
 * short parenthetical (`(y/n)`), or a short sign-off sentence (`Let me know.`, `Thanks.`) after
 * the question mark does not hide it.
 */
export function isQuestionEndingMessage(finalMessage: string | null): boolean {
  if (!finalMessage) return false;
  const withoutCode = stripCodeAndUrls(finalMessage.normalize("NFKC"));
  const rawLines = withoutCode.split("\n");

  const nonEmptyLines: string[] = [];
  for (
    let i = rawLines.length - 1;
    i >= 0 && nonEmptyLines.length < MAX_LIST_LINES + MAX_NON_LIST_LINES;
    i -= 1
  ) {
    const line = rawLines[i]!.replace(LEADING_BLOCKQUOTE, "").trim();
    if (line.length === 0) continue;
    nonEmptyLines.push(line);
  }
  if (nonEmptyLines.length === 0) return false;

  // A list line that itself ends in "?" is the question, not an option to skip past — e.g. the
  // last line of "Pick a size:\n1. small\n2. large?" is itself the ask.
  let idx = 0;
  while (
    idx < nonEmptyLines.length &&
    idx < MAX_LIST_LINES &&
    LIST_LINE.test(nonEmptyLines[idx]!) &&
    !endsWithQuestionMark(nonEmptyLines[idx]!)
  ) {
    idx += 1;
  }

  const candidates = nonEmptyLines.slice(idx, idx + MAX_NON_LIST_LINES);
  for (const candidate of candidates) {
    if (isPureSignOff(candidate)) continue;
    return endsWithQuestionMark(candidate);
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
