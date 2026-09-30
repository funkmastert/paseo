import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildChildrenByPpid, collectDescendants } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";
import { projectTimelineRows } from "./timeline-projection.js";

/**
 * An agent that ends its turn saying it is waiting on background work (a background shell, a
 * subagent, a workflow, CI) is idle, and nothing wakes an idle agent when that work ends. It sits
 * there until a person looks. The stalled-agent sweep resumes it once code can show the wait is
 * stuck: the agent is idle and quiet, its last message says it is waiting on background work, and
 * no shell or provider subagent is still running under it (docs/stalled-agents.md). No JEV: the
 * phrases and the process check are enough, and a wrong nudge costs one turn.
 */

/** Quiet time after the turn ended before the sweep looks. */
export const BACKGROUND_WAIT_QUIET_MS = 10 * 60_000;
/** Resumes per agent per rolling day, so an agent that keeps ending its turn the same way stops. */
export const MAX_BACKGROUND_WAIT_RESUMES_PER_DAY = 3;
/** Raw tail rows read to find the final message. */
export const BACKGROUND_WAIT_READ_ROWS = 80;
/** The wait statement must be in the message's end, where an agent says what it is doing next. */
const TAIL_CHARS = 600;
const QUOTE_CHARS = 160;

const WORK =
  "(?:background|bg|sub-?agents?|agents?|workflows?|builds?|tests?|test runs?|suites?|gates?|commands?|shells?|jobs?|tasks?|process(?:es)?|scripts?|monitors?|ci|pipelines?|checks|runs?|installs?|compil\\w*|typecheck\\w*|deploy\\w*|vitest|jest|gradle|xcodebuild|downloads?|uploads?|results?|findings|output|reports?)";

const WAIT_PATTERNS: readonly RegExp[] = [
  // "Waiting on the background typecheck", "I'll wait for the subagent".
  new RegExp(
    `\\b(?:wait(?:ing)?|standing by|hold(?:ing)? on)\\b[^.!?\\n]{0,40}?\\b(?:for|on|until)\\b[^.!?\\n]{0,60}?\\b${WORK}\\b`,
    "i",
  ),
  // "I'll be notified when it completes".
  /\b(?:i['’]ll|i will|i['’]m going to|i am going to|will)\s+(?:be\s+|get\s+)?(?:notified|woken|re-?invoked|pinged|alerted|a notification)\b/i,
  // "I'll report back when it finishes", "will continue once the build lands".
  /\b(?:i['’]ll|i will|will)\s+(?:check back|report back|continue|resume|pick (?:this|it) (?:back )?up|follow up|proceed|come back|get back)\b[^.!?\n]{0,60}?\b(?:when|once|after|as soon as)\b/i,
];
/** "The gate is running in the background": a wait unless the same sentence reports it done. */
const IN_BACKGROUND =
  /\b(?:running|launched|started|kicked off|spawned|dispatched|runs)\b[^.!?\n]{0,60}?\bin the background\b/i;
const REPORTS_DONE = /\b(?:passed|finished|completed|succeeded|failed|green|done)\b/i;
/**
 * Waiting for a person ("once you confirm", "on your review") is a finished turn, not a stuck one.
 * Only a person named after the connector counts: "I'll report back to you when it finishes" is
 * still a wait on background work.
 */
const WAITS_ON_PERSON =
  /\b(?:for|on|until|once|when|after)\b[^.!?\n]{0,40}?\b(?:you|your|tyler|the user|a human|a person|reviewers?|approv\w*|confirm\w*|go-ahead|decision|answer|reply|input|feedback|sign-?off)\b/i;

export interface BackgroundWaitMatch {
  /** The sentence that says it is waiting, clipped, for the nudge and the log. */
  quote: string;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function clipQuote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= QUOTE_CHARS ? line : `${line.slice(0, QUOTE_CHARS - 1)}…`;
}

/** Whether a final message says the agent is waiting on background work. Pure. */
export function findBackgroundWait(message: string): BackgroundWaitMatch | null {
  const trimmed = message.trim();
  // A question is for a person.
  if (!trimmed || trimmed.endsWith("?")) return null;
  const tail = trimmed.slice(-TAIL_CHARS);
  for (const sentence of sentences(tail)) {
    if (WAITS_ON_PERSON.test(sentence)) continue;
    const waits =
      WAIT_PATTERNS.some((pattern) => pattern.test(sentence)) ||
      (IN_BACKGROUND.test(sentence) && !REPORTS_DONE.test(sentence));
    if (waits) return { quote: clipQuote(sentence) };
  }
  return null;
}

export interface FinalMessage {
  text: string;
  /** The last row of the message: a new final message has a new one. */
  seq: number;
}

/**
 * The agent's last assistant message, when it is the newest thing in the tail: a tool call or a
 * user message after it means the turn went on, or a new one started.
 */
export function readFinalMessage(rows: readonly AgentTimelineRow[]): FinalMessage | null {
  const entries = projectTimelineRows({ rows, mode: "projected" }).filter(
    (entry) => entry.item.type !== "todo" && entry.item.type !== "notification",
  );
  const newest = entries.at(-1);
  if (newest?.item.type !== "assistant_message") return null;
  return { text: newest.item.text, seq: newest.seqEnd };
}

const SHELL =
  /^-?(?:.*[/\\])?(?:sh|bash|zsh|dash|fish|ksh|tcsh|csh|pwsh|powershell|cmd)(?:\.exe)?$/i;

function isDefunct(row: ProcessSampleRow): boolean {
  return row.command.includes("<defunct>");
}

function isShell(row: ProcessSampleRow): boolean {
  const first = row.command.trim().split(/\s+/)[0] ?? "";
  return SHELL.test(first);
}

/**
 * Live shells under the agent's root process. A provider runs every command through a shell
 * (`zsh -c …` for Claude, `bash -lc …` for Codex), and the shell lives until its command ends, so a
 * background command still running always has one. The root and its non-shell children (a stdio
 * MCP server) are not background work. `rootPid` undefined: no process, so nothing is running.
 */
export function findBackgroundShells(
  rows: readonly ProcessSampleRow[],
  rootPid: number | undefined,
): ProcessSampleRow[] {
  if (rootPid === undefined) return [];
  const rowsByPid = new Map(rows.map((row) => [row.pid, row] as const));
  const descendants = collectDescendants(rootPid, rowsByPid, buildChildrenByPpid(rows));
  return descendants.filter((row) => row.pid !== rootPid && !isDefunct(row) && isShell(row));
}

/** The nudge an idle agent gets, before its envelope. */
export function buildBackgroundWaitPrompt(input: { quietForMs: number; quote: string }): string {
  const minutes = Math.floor(input.quietForMs / 60_000);
  return [
    `Your last turn ended ${minutes} minutes ago saying you were waiting on background work: "${input.quote}"`,
    "Nothing wakes an idle agent when background work finishes, and the Paseo daemon sees no background command or subagent still running under you, so it sent this message.",
    "Check the result of what you were waiting on (its output, log or file, the agent, the build or test run) and continue. If the work is still running somewhere else, wait for it in the foreground instead of ending your turn.",
  ].join("\n\n");
}
