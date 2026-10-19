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

type Summarizer = (record: JevDecisionRecord, watching: boolean) => string;

const SUMMARIZERS: Readonly<Record<string, Summarizer>> = {
  spawnHint: (record, watching) => {
    if (!record.wouldBe) return "JEV sized up this agent's work";
    const setup = prettyModels(record.wouldBe);
    if (record.applied) return `JEV picked the setup: ${setup}`;
    if (watching) return `JEV suggested ${setup} (watching only)`;
    return `JEV checked the setup: ${setup}`;
  },
  stallJudgment: (record, watching) => {
    const label = verdictLabel(record.verdict);
    const state = STALL_STATES[label] ?? label.replaceAll("_", " ");
    return watching
      ? `JEV thinks it's ${state} (watching only)`
      : `JEV: ${state}; ${record.action}`;
  },
  remediationTriage: (record) => `JEV on the problem: ${record.action}`,
  notificationTriage: (record) => `JEV on your phone alert: ${record.action}`,
  compactionTiming: (record, watching) =>
    watching
      ? `JEV on compaction timing: ${stripWouldHave(record.action)} (watching only)`
      : `JEV on compaction timing: ${record.action}`,
  awayReply: (record) => {
    if (record.action.startsWith("replied")) return "JEV answered this agent for you";
    if (record.action.startsWith("would reply")) return "JEV would have answered for you (dry run)";
    return `JEV didn't answer for you: ${record.action.replace(/^no reply( sent)?:\s*/, "")}`;
  },
  agentTools: (record) => `JEV helped the agent: ${record.verdict}; ${record.action}`,
  askJev: (record) => `JEV answered your question: ${record.verdict}`,
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
  missing_verification: "JEV: the report doesn't say the work was checked",
  missing_scope: "JEV: the report may cover only part of the task",
  missing_tests: "JEV: the report doesn't mention tests",
  unclear: "JEV couldn't tell whether the work is done",
};

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
