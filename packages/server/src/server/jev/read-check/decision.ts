import { createHash } from "node:crypto";

import type { JevAnswer } from "../contract.js";

/**
 * Feature 16's decision (docs/jev.md, "Decision" and "Live mode (D11)"). Pure: code owns every
 * threshold here, and JEV's answer is one input.
 */

/** A `not_needed` answer at or over this records `would-skip`. */
export const READ_CHECK_SKIP_CONFIDENCE = 0.8;
/** A `part_needed` answer at or over this records `would-narrow`. */
export const READ_CHECK_NARROW_CONFIDENCE = 0.8;
/** Live mode denies only a `not_needed` answer at or over this. */
export const READ_CHECK_LIVE_DENY_CONFIDENCE = 0.85;
/** Live mode stops denying an agent with this many regrets in the last hour. */
export const READ_CHECK_MAX_REGRETS_PER_HOUR = 2;

export const READ_CHECK_QUESTION_ID = "need";
export const READ_CHECK_CHOICES = ["needed", "part_needed", "not_needed", "other"] as const;
export type ReadCheckChoice = (typeof READ_CHECK_CHOICES)[number];

export type ReadCheckVerdict = "would-skip" | "would-narrow" | "needed";

export interface ReadCheckAnswer {
  verdict: ReadCheckVerdict;
  /** JEV's choice, or null when no usable answer came. */
  choice: ReadCheckChoice | null;
  confidence: number | null;
}

function isReadCheckChoice(value: string): value is ReadCheckChoice {
  return (READ_CHECK_CHOICES as readonly string[]).includes(value);
}

/** Maps the `need` answer to a verdict. Anything unusable is `needed`: the read runs. */
export function readCheckAnswerOf(answer: JevAnswer | undefined): ReadCheckAnswer {
  if (answer?.type !== "choice" || !isReadCheckChoice(answer.choice)) {
    return { verdict: "needed", choice: null, confidence: null };
  }
  const confidence = Number.isFinite(answer.confidence) ? answer.confidence : 0;
  let verdict: ReadCheckVerdict = "needed";
  if (answer.choice === "not_needed" && confidence >= READ_CHECK_SKIP_CONFIDENCE) {
    verdict = "would-skip";
  } else if (answer.choice === "part_needed" && confidence >= READ_CHECK_NARROW_CONFIDENCE) {
    verdict = "would-narrow";
  }
  return { verdict, choice: answer.choice, confidence };
}

/**
 * Whether live mode applies to this agent: a hash of its id under `liveShare`, so an agent stays
 * on one side for its whole life and the other side is the control on the same days.
 */
export function isLiveShareAgent(agentId: string, liveShare: number): boolean {
  if (liveShare <= 0) return false;
  if (liveShare >= 1) return true;
  const digest = createHash("sha256").update(agentId).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < liveShare;
}

export interface LiveDenyInput {
  answer: ReadCheckAnswer;
  /** The JEV outcome was `answered`: live, not shadow, not a failure. */
  answered: boolean;
  /** A `Read`, or a Bash line that only reads this one file. */
  plainRead: boolean;
  /** This agent was denied this path before in its session. */
  deniedBefore: boolean;
  /** This agent edited this path in its session. */
  editedBefore: boolean;
  deniesLastHour: number;
  regretsLastHour: number;
  maxDeniesPerAgentPerHour: number;
}

export type LiveDenyReason =
  | "not-answered"
  | "not-confident"
  | "not-plain-read"
  | "denied-before"
  | "edited"
  | "deny-cap"
  | "regret-cap";

/** Every live condition must hold for a deny; the first that fails is the reason it ran. */
export function decideLiveDeny(
  input: LiveDenyInput,
): { deny: true } | { deny: false; reason: LiveDenyReason } {
  if (!input.answered) return { deny: false, reason: "not-answered" };
  if (
    input.answer.choice !== "not_needed" ||
    (input.answer.confidence ?? 0) < READ_CHECK_LIVE_DENY_CONFIDENCE
  ) {
    return { deny: false, reason: "not-confident" };
  }
  if (!input.plainRead) return { deny: false, reason: "not-plain-read" };
  if (input.deniedBefore) return { deny: false, reason: "denied-before" };
  if (input.editedBefore) return { deny: false, reason: "edited" };
  if (input.deniesLastHour >= input.maxDeniesPerAgentPerHour) {
    return { deny: false, reason: "deny-cap" };
  }
  if (input.regretsLastHour >= READ_CHECK_MAX_REGRETS_PER_HOUR) {
    return { deny: false, reason: "regret-cap" };
  }
  return { deny: true };
}

function formatTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
}

/** The deny reason the agent reads. The file tools are named only to agents that have them. */
export function formatReadDenial(input: {
  displayPath: string;
  tokens: number;
  confidence: number;
  tool: "Read" | "Bash";
  hasJevFileTools: boolean;
}): string {
  const retry =
    input.tool === "Read"
      ? "run the same Read again; it goes through without a check."
      : "run the same command again; it goes through without a check.";
  const sentences = [
    `JEV judged ${input.displayPath} (about ${formatTokens(input.tokens)} tokens) not needed for your task (${input.confidence.toFixed(2)}).`,
    `If you need it, ${retry}`,
  ];
  if (input.hasJevFileTools) {
    sentences.push(
      "To ask about it without loading it, use mcp__paseo__ask_jev_file_bool or mcp__paseo__ask_jev_file_choice.",
    );
  }
  return sentences.join(" ");
}
