import { confidentChoice, rawChoice } from "./answers.js";
import type { JevDecisionNote, JevOutcome, JevQuestions, JevService } from "./contract.js";
import { decideWithHardTimeout } from "./decide-with-hard-timeout.js";

/**
 * Feature 18, finish review (docs/jev.md). When a child's finish report is about to be delivered
 * to its parent, JEV reads the task and the child's final message and judges whether the work
 * looks done. Live from the start: no shadow mode. Fail open in every direction — no key, the
 * switch off, a timeout, an outage or a low-confidence answer all mean the report goes out
 * exactly as it would have without this feature. `reviewFinishReport` never throws.
 */

export const FINISH_REVIEW_CALL_SITE = "finish-obligation.finish-review";
/** A hard bound past `jev.decide`'s own deadline, so a hang can never hold up delivery. */
export const FINISH_REVIEW_HARD_TIMEOUT_MS = 5_000;
export const FINISH_REVIEW_TASK_CHARS = 800;
export const FINISH_REVIEW_FINAL_MESSAGE_CHARS = 4_000;
export const FINISH_REVIEW_DEFAULT_MIN_CONFIDENCE = 0.75;

export const FINISH_REVIEW_QUESTIONS: JevQuestions = {
  finish_quality: {
    type: "choice",
    instructions:
      "`task` is what the agent was asked to do; `final_message` is its own account of finishing. Judge whether the work looks done.",
    criteria: {
      done: "The final message describes work that answers the task, with nothing obviously missing",
      in_progress:
        "The final message says the agent is pausing or waiting on work it started itself — a background command, a subagent, CI, a review — before it is actually done. Not a gap in the report: the turn just is not finished yet",
      missing_verification:
        "The final message does not say whether the change was run, tested or otherwise checked to work",
      missing_scope:
        "The final message covers only part of what the task asked for, or leaves a stated step undone",
      missing_tests:
        "The task implies a code change and the final message does not mention adding or updating tests for it",
      unclear: "Not enough information in `task` or `final_message` to judge",
      other: "None of these",
    },
  },
};

/** Choices that earn a note on the delivered report. `unclear` and `other` are not confident claims. */
const FLAGGED_CHOICES = new Set([
  "missing_verification",
  "missing_scope",
  "missing_tests",
  "in_progress",
]);

const FLAGGED_NOTES: Readonly<Record<string, string>> = {
  missing_verification:
    "JEV flagged this report: it doesn't say whether the change was verified to work.",
  missing_scope: "JEV flagged this report: it may cover only part of what was asked.",
  missing_tests: "JEV flagged this report: it doesn't mention tests for the change.",
  in_progress:
    "JEV flagged this report: the final message reads like the agent is still waiting on its own work, not finished yet.",
};

export function buildFinishReviewState(input: {
  title: string | null;
  task: string | null;
  finalMessage: string;
}): { title: string; task: string; final_message: string } {
  return {
    title: input.title?.trim() ?? "",
    task: input.task ? input.task.trim().slice(0, FINISH_REVIEW_TASK_CHARS) : "",
    final_message: input.finalMessage.slice(-FINISH_REVIEW_FINAL_MESSAGE_CHARS),
  };
}

export interface ReviewFinishReportInput {
  jev: JevService;
  childAgentId: string;
  ownerAgentId: string;
  title: string | null;
  /** The task the child was given, when it could be read. Null skips nothing: JEV still judges. */
  task: string | null;
  /** The child's final message. Empty or null: nothing to judge, and the function is a no-op. */
  finalMessage: string | null;
  minConfidence: number;
  hardTimeoutMs?: number;
}

/**
 * Judges one child's finish report and returns the line to add to it, or null when nothing was
 * flagged or JEV could not be asked. Also records the verdict in the decision store for both the
 * child and the owner (docs/jev.md, "Decision store") and one savings involvement. Never throws.
 */
export async function reviewFinishReport(input: ReviewFinishReportInput): Promise<string | null> {
  try {
    const finalMessage = input.finalMessage?.trim();
    if (!finalMessage) return null;
    if (!input.jev.isActive("finishReview")) return null;
    const outcome = await decideWithHardTimeout(input.jev, {
      feature: "finishReview",
      callSite: FINISH_REVIEW_CALL_SITE,
      state: buildFinishReviewState({ title: input.title, task: input.task, finalMessage }),
      questions: FINISH_REVIEW_QUESTIONS,
      scope: { cwds: [], agentIds: [input.childAgentId] },
      subject: { agentId: input.childAgentId },
      hardTimeoutMs: input.hardTimeoutMs ?? FINISH_REVIEW_HARD_TIMEOUT_MS,
    });
    if (outcome === "error") return null;
    const confident = confidentChoice(outcome, "finish_quality", input.minConfidence);
    const note = confident && FLAGGED_CHOICES.has(confident) ? FLAGGED_NOTES[confident] : null;
    recordFinishReview(input, { outcome, confident, flagged: Boolean(note) });
    return note ?? null;
  } catch {
    return null;
  }
}

function recordFinishReview(
  input: ReviewFinishReportInput,
  result: { outcome: JevOutcome; confident: string | null; flagged: boolean },
): void {
  const { outcome, confident, flagged } = result;
  if (outcome.kind !== "answered") return;
  try {
    const { choice, confidence } = rawChoice(outcome, "finish_quality");
    // Below the floor, the record says JEV could not tell rather than naming a specific choice —
    // a low-confidence `missing_scope` must never read like a verdict (docs/jev.md, feature 18).
    const label = confident ?? "unsure";
    const verdict = choice === null ? "no answer" : `${label} (${confidence?.toFixed(2) ?? "?"})`;
    const action = (() => {
      if (flagged) return `flagged in the report to ${input.ownerAgentId}`;
      if (choice !== null && !confident) return "not confident enough to judge; no note added";
      return "looks done; no note added";
    })();
    const savingsId = input.jev.savings.record({
      feature: "finishReview",
      callSite: FINISH_REVIEW_CALL_SITE,
      callId: outcome.callId,
      agentId: input.childAgentId,
      involvement: "Does this child's finish report look done?",
      decision: { did: action, wouldBe: action, changed: flagged },
      facts: { choice: choice ?? "none", confidence: confidence ?? 0 },
    });
    const note: JevDecisionNote = {
      agentId: input.childAgentId,
      callId: outcome.callId,
      feature: "finishReview",
      question: "Does this finish look done?",
      verdict,
      confidence,
      action,
      applied: flagged,
      mode: "live",
      savingsId,
    };
    input.jev.decisions.record(note);
    // Shows on both ends: the child it judged and the owner whose report it may have annotated.
    input.jev.decisions.record({ ...note, agentId: input.ownerAgentId });
  } catch {
    // The record never affects the report.
  }
}
