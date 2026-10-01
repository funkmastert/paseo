import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { buildChildrenByPpid, collectDescendants } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";
import { projectTimelineRows } from "./timeline-projection.js";

/**
 * An agent can end its turn waiting on something and have nothing left that will wake it. Claude's
 * own background shells, monitors, subagents and workflows do wake it: Claude Code starts a turn
 * when one ends. What is left are two classes (docs/stalled-agents.md):
 *
 * - **own work:** the final turn launched background work, nothing of it is still running, and the
 *   agent is still idle and quiet, so whatever should have woken it did not;
 * - **external wait:** the agent says it is waiting on CI, a PR, a deploy or a review, and nothing
 *   (no shell, no subagent, no schedule, no child) is watching it.
 *
 * The stalled-agent sweep records both. It resumes neither until `BACKGROUND_WAIT_LIVE` is
 * flipped. No JEV: the phrases, the timeline and the process check are enough.
 */

/**
 * Off: the sweep records `would-resume` and sends nothing, whatever `stalledAgents.dryRun` says.
 * A week of replayed endings found 1 true positive in 8 before the classes existed. Flip it once
 * the `background-wait` and `background-wait-outcome` lines show the rule earns it.
 */
export const BACKGROUND_WAIT_LIVE = false;

/** Quiet time after the turn ended before the sweep looks. */
export const BACKGROUND_WAIT_QUIET_MS = 10 * 60_000;
/** Resumes per agent per rolling day, so an agent that keeps ending its turn the same way stops. */
export const MAX_BACKGROUND_WAIT_RESUMES_PER_DAY = 3;
/** Raw tail rows read to find the final message and what the final turn launched. */
export const BACKGROUND_WAIT_READ_ROWS = 80;
/** The wait statement must be in the message's end, where an agent says what it is doing next. */
const TAIL_CHARS = 600;
const QUOTE_CHARS = 160;

export type BackgroundWaitClass = "own-work" | "external-wait";

/**
 * Work an agent starts and waits on. Generic nouns (reports, results, findings, output, runs,
 * checks) are left out: status reports and handoffs use them about other agents' work.
 */
const WORK =
  "(?:background|bg|sub-?agents?|agents?|workflows?|builds?|tests?|test runs?|suites?|gates?|commands?|shells?|jobs?|tasks?|process(?:es)?|scripts?|monitors?|ci|pipelines?|installs?|compil\\w*|typecheck\\w*|deploy\\w*|vitest|jest|gradle|xcodebuild|downloads?|uploads?)";

/** What an agent waits on outside its machine. Only these make an external wait. */
const EXTERNAL =
  "(?:(?:the|my|its) )?(?:(?:pr|ci|status|required) checks|checks on (?:the |my )?pr|(?:pr|code) reviews?|reviews? (?:on|of) (?:the |my )?(?:pr|#\\d+)|ci|github actions|pipelines?|bugbot|lore|pr|deploy(?:s|ment)?|rollout|merge queue|testflight|eas builds?|play console)|#\\d+";

const WAIT_VERB =
  "\\b(?:wait(?:ing)?|standing by|hold(?:ing)? on)\\b[^.!?\\n]{0,40}?\\b(?:for|on|until)\\b";
const RESUME_VERB =
  "\\b(?:i['’]ll|i will|will)\\s+(?:check back|report back|continue|resume|pick (?:this|it) (?:back )?up|follow up|proceed|come back|get back)\\b[^.!?\\n]{0,60}?\\b(?:when|once|after|as soon as)\\b";

const WAIT_PATTERNS: readonly RegExp[] = [
  // "Waiting on the background typecheck", "I'll wait for the subagent".
  new RegExp(`${WAIT_VERB}[^.!?\\n]{0,60}?\\b${WORK}\\b`, "i"),
  // "I'll be notified when it completes".
  /\b(?:i['’]ll|i will|i['’]m going to|i am going to|will)\s+(?:be\s+|get\s+)?(?:notified|woken|re-?invoked|pinged|alerted|a notification)\b/i,
  // "I'll report back when it finishes", "will continue once the build lands".
  new RegExp(RESUME_VERB, "i"),
];

/** "I started the gate in the background": a wait unless the same sentence reports it done. */
const IN_BACKGROUND: readonly RegExp[] = [
  /\b(?:i|we)(?:['’](?:ve|m|re))?\s+(?:have\s+|am\s+|are\s+)?(?:just\s+|now\s+|also\s+)?(?:running|launched|started|kicked off|spawned|dispatched|put|left)\b[^.!?\n]{0,60}?\bin the background\b/i,
  /\b(?:my|our)\b[^.!?\n]{0,40}?\b(?:is|are)\s+(?:still\s+|now\s+)?running\b[^.!?\n]{0,30}?\bin the background\b/i,
];
const REPORTS_DONE = /\b(?:passed|finished|completed|succeeded|failed|green|done)\b/i;

const EXTERNAL_PATTERNS: readonly RegExp[] = [
  // "Waiting on CI", "it's waiting on CI before I merge it".
  new RegExp(`${WAIT_VERB}[^.!?\\n]{0,60}?(?<![\\w-])(${EXTERNAL})(?![\\w-])`, "i"),
  // "I'll merge once CI is green", "will continue after the deploy".
  new RegExp(
    `\\b(?:i['’]ll|i will|will)\\s+(?:merge|land|ship|release|continue|resume|proceed|check back|report back|follow up|pick (?:this|it) (?:back )?up)\\b[^.!?\\n]{0,60}?\\b(?:when|once|after|as soon as)\\b[^.!?\\n]{0,40}?(?<![\\w-])(${EXTERNAL})(?![\\w-])`,
    "i",
  ),
];
/**
 * Waiting for a person ("once you confirm", "on your review") is a finished turn, not a stuck one.
 * Only a person named after the connector counts: "I'll report back to you when it finishes" is
 * still a wait on background work.
 */
const WAITS_ON_PERSON =
  /\b(?:for|on|until|once|when|after)\b[^.!?\n]{0,40}?\b(?:you|your|tyler|the user|a human|a person|reviewers?|approv\w*|confirm\w*|go-ahead|decision|answer|reply|input|feedback|sign-?off)\b/i;

/** A table row or a list item: a status line about something, not what the agent does next. */
const TABLE_OR_LIST = /^\s*(?:\||[-*+•]\s|\d+[.)]\s)/;

export interface BackgroundWaitMatch {
  /** The sentence that says it is waiting, clipped, for the prompt and the log. */
  quote: string;
}

export interface ExternalWaitMatch extends BackgroundWaitMatch {
  /** What it waits on, as the agent named it ("CI", "the PR"). */
  target: string;
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .filter((line) => !TABLE_OR_LIST.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function clipQuote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= QUOTE_CHARS ? line : `${line.slice(0, QUOTE_CHARS - 1)}…`;
}

/**
 * A question is for a person. Markdown around it (`**Merge now?**`) and a `?` before the last
 * sentence of the last paragraph still make one; a `?` in a URL or a code span does not.
 */
function endsWithQuestion(message: string): boolean {
  const paragraphs = message.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  const last = (paragraphs.at(-1) ?? "").replace(/`[^`]*`/g, "").replace(/https?:\/\/\S+/g, "");
  return last.includes("?");
}

/** The tail's sentences that can carry a wait, or none when the message ends on a question. */
function waitSentences(message: string): string[] {
  const trimmed = message.trim();
  if (!trimmed || endsWithQuestion(trimmed)) return [];
  return sentences(trimmed.slice(-TAIL_CHARS)).filter(
    (sentence) => !WAITS_ON_PERSON.test(sentence),
  );
}

/** Whether a final message says the agent is waiting on background work. Pure. */
export function findBackgroundWait(message: string): BackgroundWaitMatch | null {
  for (const sentence of waitSentences(message)) {
    const waits =
      WAIT_PATTERNS.some((pattern) => pattern.test(sentence)) ||
      (IN_BACKGROUND.some((pattern) => pattern.test(sentence)) && !REPORTS_DONE.test(sentence));
    if (waits) return { quote: clipQuote(sentence) };
  }
  return null;
}

/** Whether a final message says the agent is waiting on CI, a PR, a deploy or a review. Pure. */
export function findExternalWait(message: string): ExternalWaitMatch | null {
  for (const sentence of waitSentences(message)) {
    for (const pattern of EXTERNAL_PATTERNS) {
      const target = sentence.match(pattern)?.[1];
      if (target) return { quote: clipQuote(sentence), target };
    }
  }
  return null;
}

export interface FinalMessage {
  text: string;
  /** The last row of the message: a new final message has a new one. */
  seq: number;
}

function projected(rows: readonly AgentTimelineRow[]) {
  return projectTimelineRows({ rows, mode: "projected" }).filter(
    (entry) => entry.item.type !== "todo" && entry.item.type !== "notification",
  );
}

/**
 * The agent's last assistant message, when it is the newest thing in the tail: a tool call or a
 * user message after it means the turn went on, or a new one started.
 */
export function readFinalMessage(rows: readonly AgentTimelineRow[]): FinalMessage | null {
  const newest = projected(rows).at(-1);
  if (newest?.item.type !== "assistant_message") return null;
  return { text: newest.item.text, seq: newest.seqEnd };
}

export interface FinalTurnWork {
  /** Background work the final turn started, one short label each ("background shell"). */
  launched: string[];
  /** It set up something that wakes it: a wakeup, a schedule or a heartbeat. */
  watcher: string | null;
}

type ToolCall = Extract<AgentTimelineItem, { type: "tool_call" }>;

/** Claude's answer to a `run_in_background` Bash call. */
const BACKGROUND_SHELL_OUTPUT = /\brunning in background with ID\b/i;
const MONITOR_TOOL = /(?:^|__|\.)Monitor$/;
const WORKFLOW_TOOL = /(?:^|__|\.)Workflow$/;
const SUBAGENT_TOOL = /^(?:Agent|Task)$/;
const CREATE_AGENT_TOOL = /(?:^|__|\.)create_agent$/;
const WATCHER_TOOL = /(?:^|__|\.)(?:ScheduleWakeup|create_schedule|create_heartbeat)$/;

function describeLaunch(item: ToolCall): string | null {
  if (item.detail.type === "shell") {
    return BACKGROUND_SHELL_OUTPUT.test(item.detail.output ?? "") ? "a background shell" : null;
  }
  if (MONITOR_TOOL.test(item.name)) return "a monitor";
  if (WORKFLOW_TOOL.test(item.name)) return "a workflow";
  // A Task card cannot say whether it ran in the background. A foreground one finished inside
  // the turn, and a provider subagent still running keeps the agent out of the rule anyway.
  if (item.detail.type === "sub_agent" || SUBAGENT_TOOL.test(item.name)) return "a subagent";
  if (CREATE_AGENT_TOOL.test(item.name)) return "a Paseo agent";
  return null;
}

/**
 * What the final turn launched and whether it set up a watcher, read from the tool calls since
 * the last user message. A turn a background task started on its own has no user message, so the
 * turn before it counts too: it launched the work being waited on.
 */
export function readFinalTurnWork(rows: readonly AgentTimelineRow[]): FinalTurnWork {
  const entries = projected(rows);
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.item.type === "user_message") {
      start = index + 1;
      break;
    }
  }
  const launched: string[] = [];
  let watcher: string | null = null;
  for (const entry of entries.slice(start)) {
    const item = entry.item;
    if (item.type !== "tool_call") continue;
    if (WATCHER_TOOL.test(item.name)) watcher = item.name.replace(/^.*(?:__|\.)/, "");
    const launch = describeLaunch(item);
    if (launch && !launched.includes(launch)) launched.push(launch);
  }
  return { launched, watcher };
}

const SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "tcsh",
  "csh",
  "pwsh",
  "powershell",
  "cmd",
]);

/**
 * The executable a row runs. Windows has the image name (`bash.exe`) in the sampler's `Name`
 * column; elsewhere it is the command line's first word, which on Windows can be a quoted path
 * with spaces (`"C:\Program Files\Git\bin\bash.exe" -c …`) or an unquoted one.
 */
function executableOf(row: ProcessSampleRow): string {
  if (row.name) return row.name;
  const command = row.command.trim();
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1);
    return end > 0 ? command.slice(1, end) : command.slice(1);
  }
  const windowsPath = /^[a-z]:[\\/]/i.test(command) ? command.match(/^.*?\.exe(?=\s|$)/i) : null;
  if (windowsPath) return windowsPath[0];
  return command.split(/\s+/)[0] ?? "";
}

function isShell(row: ProcessSampleRow): boolean {
  const base = (executableOf(row).split(/[\\/]/).at(-1) ?? "")
    .toLowerCase()
    .replace(/^-/, "")
    .replace(/\.exe$/, "");
  return SHELL_NAMES.has(base);
}

function isDefunct(row: ProcessSampleRow): boolean {
  return row.command.includes("<defunct>");
}

/**
 * Live shells under the agent's root process. Claude runs every command through a shell (`zsh -c
 * …`, Git Bash on Windows), and the shell lives until its command ends, so a background command
 * still running always has one. The root and its non-shell children (a stdio MCP server) are not
 * background work. Only an attributed root says anything: the sweep skips an agent whose tree it
 * cannot find unless its provider is Claude-family, whose root is always attributable.
 */
export function findBackgroundShells(
  rows: readonly ProcessSampleRow[],
  rootPid: number,
): ProcessSampleRow[] {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row] as const));
  const descendants = collectDescendants(rootPid, rowsByPid, buildChildrenByPpid(rows));
  return descendants.filter((row) => row.pid !== rootPid && !isDefunct(row) && isShell(row));
}

/** Both prompts say this; the outcome line reads it to tell a resume from any other prompt. */
export const BACKGROUND_WAIT_PROMPT_MARK = /so the Paseo daemon sent this message/;

/** The prompt for own work, before its envelope. */
export function buildBackgroundWaitPrompt(input: {
  quietForMs: number;
  quote: string;
  launched: readonly string[];
}): string {
  const minutes = Math.floor(input.quietForMs / 60_000);
  return [
    `Your last turn started background work (${input.launched.join(", ")}) and ended ${minutes} minutes ago saying: "${input.quote}"`,
    "Nothing of it is still running under you, and nothing woke you when it ended, so the Paseo daemon sent this message.",
    "Check the result of that work (its output, log or file, the agent, the build or test run) and continue.",
  ].join("\n\n");
}

/** The prompt for an external wait nothing watches, before its envelope. */
export function buildExternalWaitPrompt(input: {
  quietForMs: number;
  quote: string;
  target: string;
}): string {
  const minutes = Math.floor(input.quietForMs / 60_000);
  return [
    `Your last turn ended ${minutes} minutes ago saying you were waiting on ${input.target}: "${input.quote}"`,
    `Nothing is watching ${input.target}: no background command, subagent, child agent or schedule will wake you when it changes, so the Paseo daemon sent this message.`,
    `Check ${input.target} now. If it is still not done, set up a watcher (a background command that waits for it) before you end your turn.`,
  ].join("\n\n");
}
