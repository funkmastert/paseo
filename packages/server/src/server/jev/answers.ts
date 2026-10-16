import type { JevAnswer, JevOutcome } from "./contract.js";

/**
 * Reading an outcome at a call site (docs/jev.md, "The outcome"). Each helper answers null unless
 * the outcome is `answered` and the answer clears the floor, so `null` is today's behaviour and a
 * call site cannot act on a shadow, an outage or a low-confidence answer by mistake. Floors are
 * the call site's constants: code owns the numbers.
 */

function answeredAnswer(outcome: JevOutcome, questionId: string): JevAnswer | null {
  if (outcome.kind !== "answered") return null;
  return outcome.answers[questionId] ?? null;
}

/** The chosen option when its confidence is at least `floor`. */
export function confidentChoice(
  outcome: JevOutcome,
  questionId: string,
  floor: number,
): string | null {
  const answer = answeredAnswer(outcome, questionId);
  if (answer?.type !== "choice" || answer.confidence < floor) return null;
  return answer.choice;
}

/** The yes-probability, when answered. The caller compares it with its own floor. */
export function noulOf(outcome: JevOutcome, questionId: string): number | null {
  const answer = answeredAnswer(outcome, questionId);
  return answer?.type === "noul" ? answer.noul : null;
}

/** The score when its confidence is at least `floor` (default 0: any answered score). */
export function confidentScore(outcome: JevOutcome, questionId: string, floor = 0): number | null {
  const answer = answeredAnswer(outcome, questionId);
  if (answer?.type !== "score" || answer.confidence < floor) return null;
  return answer.score;
}

/** The answers a shadow call would have acted on, for the call site's "would have" record. */
export function shadowAnswers(outcome: JevOutcome): Record<string, JevAnswer> | null {
  return outcome.kind === "shadow" ? outcome.answers : null;
}
