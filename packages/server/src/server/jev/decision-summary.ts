import { JEV_FEATURE_LABELS } from "@getpaseo/protocol/jev/labels";
import type { JevDecisionRecord } from "./contract.js";

/**
 * A plain-words one-line summary of a decision (docs/jev.md, "Feature 11"), for the agent
 * header's JEV badge and the timeline marker. It says what JEV decided and what happened, read
 * from the record's verdict and action, so a marker never claims an outcome the decision didn't
 * have. One summarizer per feature; an id with none yet falls through to the generic line, so the
 * marker still reads rather than going blank.
 */
export function summarizeJevDecision(record: JevDecisionRecord): string {
  const summarize = SUMMARIZERS[record.feature];
  if (summarize) return summarize(record, isWatching(record));
  return `JEV ran ${JEV_FEATURE_LABELS[record.feature] ?? record.feature}: ${record.verdict}`;
}

/**
 * A plain-words second line for a decision whose outcome needs vocabulary `summary` has no room
 * for (docs/jev.md, "Feature 11"). Most features say everything in one line; null is normal.
 */
export function detailForJevDecision(record: JevDecisionRecord): string | null {
  const detail = DETAILS[record.feature];
  return detail ? detail(record) : null;
}

type Summarizer = (record: JevDecisionRecord, watching: boolean) => string;
type Detailer = (record: JevDecisionRecord) => string | null;

const SUMMARIZERS: Readonly<Record<string, Summarizer>> = {
  // None of these says "(watching only)" or "(dry run)" itself: the row already says that once,
  // from the record's `mode` (jev-marker-chip.tsx), and a summary repeating it would say the same
  // thing twice in two words apart.
  spawnHint: (record, watching) => {
    if (!record.wouldBe) return "JEV sized up this agent's work";
    const setup = prettyModels(record.wouldBe);
    if (record.applied) return `JEV picked the setup: ${setup}`;
    if (watching) return `JEV suggested ${setup}`;
    return `JEV checked the setup: ${setup}`;
  },
  stallJudgment: (record, watching) => {
    const label = verdictLabel(record.verdict);
    const state = STALL_STATES[label] ?? label.replaceAll("_", " ");
    return watching ? `JEV thinks it's ${state}` : `JEV: ${state}; ${record.action}`;
  },
  remediationTriage: (record) => `JEV on the problem: ${record.action}`,
  notificationTriage: (record) => `JEV on your phone alert: ${record.action}`,
  compactionTiming: (record, watching) =>
    watching
      ? `JEV on compaction timing: ${stripWouldHave(record.action)}`
      : `JEV on compaction timing: ${record.action}`,
  awayReply: (record) => {
    if (record.action.startsWith("replied")) return "JEV answered this agent for you";
    if (record.action.startsWith("would reply")) return "JEV would have answered for you";
    return `JEV didn't answer for you: ${record.action.replace(/^no reply( sent)?:\s*/, "")}`;
  },
  agentTools: (record) => {
    const risk = /^risk ([\d.]+)$/.exec(record.verdict)?.[1];
    const level = risk ? riskLevel(Number(risk)) : null;
    return level
      ? `JEV reviewed the change (${level}): ${record.action}`
      : `JEV reviewed the change: ${record.action}`;
  },
  askJev: (record) => {
    const [, label, confidenceText] = /^(.*?)\s*([\d.]+)$/.exec(record.verdict) ?? [];
    const confidence = confidenceText ? Number(confidenceText) : null;
    const confidenceWord =
      confidence !== null && confidence >= 0 && confidence <= 1
        ? describeConfidence(confidence)
        : null;
    if (label && confidenceWord) return `JEV answered your question: ${label} (${confidenceWord})`;
    if (label) return `JEV answered your question: ${label}`;
    if (confidenceWord) return `JEV answered your question (${confidenceWord})`;
    return "JEV answered your question";
  },
  readCheck: (record, watching) => {
    const file = /^Does this agent need (.+)\?$/.exec(record.question)?.[1] ?? "a file";
    if (watching || !record.applied) return `JEV would have skipped re-reading ${file}`;
    const tokens = /about ([\d,]+) tokens/.exec(record.action)?.[1];
    return tokens
      ? `JEV skipped re-reading ${file} (about ${tokens} tokens)`
      : `JEV skipped re-reading ${file}`;
  },
  titleRefresh: (record) =>
    record.action.startsWith("kept")
      ? "JEV kept the session title: it still fits"
      : "JEV asked for a fresh session title",
  finishReview: (record) =>
    FINISH_VERDICTS[verdictLabel(record.verdict)] ?? "JEV read the finish report",
};

const STALL_STATES: Readonly<Record<string, string>> = {
  progressing: "still making progress",
  looping: "looping on the same step",
  blocked_missing_info: "stuck, missing information",
  waiting_on_human: "waiting on a person",
};

const FINISH_VERDICTS: Readonly<Record<string, string>> = {
  done: "JEV: the report looks done",
  in_progress: "JEV: this turn isn't finished yet, not a gap in the report",
  missing_verification: "JEV: the report doesn't say the work was checked",
  missing_scope: "JEV: the report may cover only part of the task",
  missing_tests: "JEV: the report doesn't mention tests",
  unclear: "JEV couldn't tell whether the work is done",
  unsure: "JEV wasn't sure whether this report is done",
};

const DETAILS: Readonly<Record<string, Detailer>> = {
  // `summary` names the gap; this says what the daemon actually did about it, in the writer's
  // own action vocabulary (`finish-review.ts`'s `recordFinishReview`).
  finishReview: (record) => {
    if (record.action.startsWith("flagged in the report")) {
      return "JEV added a note to the report so you'd see this.";
    }
    if (record.action === "not confident enough to judge; no note added") {
      return "JEV wasn't sure enough to add a note.";
    }
    return null;
  },
};

/** `0.94` reads `sure`, `0.7` reads `fairly sure`, anything lower reads `unsure`. */
function describeConfidence(confidence: number): string {
  if (confidence >= 0.85) return "sure";
  if (confidence >= 0.65) return "fairly sure";
  return "unsure";
}

/** `ask_jev_diff_risk`'s 0-1 score, read as a level rather than shown as a number. */
function riskLevel(risk: number): string {
  if (risk >= 0.6) return "high risk";
  if (risk >= 0.3) return "some risk";
  return "low risk";
}

/** A shadow answer, or a live one recorded as what it would have done. */
function isWatching(record: JevDecisionRecord): boolean {
  return record.mode === "shadow" || record.action.startsWith("would have:");
}

/** `progressing (0.99)` reads `progressing`; a verdict with no label reads empty. */
function verdictLabel(verdict: string): string {
  return /^([a-z_]+)/.exec(verdict)?.[1] ?? "";
}

function stripWouldHave(action: string): string {
  return action.replace(/^would have:\s*/, "");
}

/** `standard on claude-sonnet-5` reads `standard on Sonnet 5`; `claude-haiku-4-5` reads `Haiku 4.5`. */
function prettyModels(text: string): string {
  return text.replace(
    /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?/g,
    (_match, family: string, major: string, minor?: string) =>
      `${family[0]!.toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`,
  );
}
