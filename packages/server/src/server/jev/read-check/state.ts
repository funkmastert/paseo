import type { AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import type { JevQuestions } from "../contract.js";
import { estimateContextTokens } from "../savings-formulas.js";
import { READ_CHECK_QUESTION_ID } from "./decision.js";
import type { FileReadRange } from "./recognize.js";

/**
 * What feature 16 sends and how it sizes a read (docs/jev.md, "State and question" and "What
 * counts as a read"). Pure.
 */

/** `Read` prefixes every line with its number and a tab: about 7 characters a line. */
export const READ_TOOL_LINE_PREFIX_CHARS = 7;
/** `Read` cuts any longer line. */
const READ_TOOL_MAX_LINE_CHARS = 2000;

export const READ_CHECK_MAX_STATE_BYTES = 10_000;
const TASK_ASSIGNMENT_CHARS = 800;
const RECENT_ROWS = 8;
const RECENT_ASSISTANT_CHARS = 600;
const RECENT_OTHER_CHARS = 300;
const WHY_CHARS = 300;
export const READ_CHECK_OUTLINE_CHARS = 2000;
export const READ_CHECK_EXCERPT_CHARS = 6000;
const MIN_EXCERPT_CHARS = 1500;

/** Tokens a read loads, at the savings ledger's one rate (`savings-formulas.ts`). */
export function estimateReadTokens(characters: number): number {
  return estimateContextTokens(characters);
}

export interface RangeSlice {
  text: string;
  /** 1-based, inclusive; zero lines when the range is past the end. */
  firstLine: number;
  lastLine: number;
  totalLines: number;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The part of `text` a reader prints for `range`. */
export function sliceRange(text: string, range: FileReadRange): RangeSlice {
  const lines = splitLines(text);
  const totalLines = lines.length;
  switch (range.kind) {
    case "all":
      return { text, firstLine: 1, lastLine: totalLines, totalLines };
    case "lines": {
      const first = Math.max(1, range.first);
      const last = Math.min(totalLines, range.last ?? totalLines);
      const picked = first <= last ? lines.slice(first - 1, last) : [];
      return {
        text: picked.length > 0 ? `${picked.join("\n")}\n` : "",
        firstLine: first,
        lastLine: first + picked.length - 1,
        totalLines,
      };
    }
    case "last-lines": {
      const picked = range.count > 0 ? lines.slice(-range.count) : [];
      return {
        text: picked.length > 0 ? `${picked.join("\n")}\n` : "",
        firstLine: totalLines - picked.length + 1,
        lastLine: totalLines,
        totalLines,
      };
    }
    case "first-bytes": {
      const picked = Buffer.from(text, "utf8").subarray(0, range.count).toString("utf8");
      return { text: picked, firstLine: 1, lastLine: splitLines(picked).length, totalLines };
    }
    case "last-bytes": {
      const buffer = Buffer.from(text, "utf8");
      const picked = buffer.subarray(Math.max(0, buffer.length - range.count)).toString("utf8");
      const count = splitLines(picked).length;
      return { text: picked, firstLine: totalLines - count + 1, lastLine: totalLines, totalLines };
    }
  }
}

/** A pipeline's filters (`| head -100`) applied in order to what the readers before printed. */
export function applyFilters(text: string, filters: readonly FileReadRange[]): string {
  let current = text;
  for (const filter of filters) current = sliceRange(current, filter).text;
  return current;
}

/** Characters `Read` puts in context for `text`: its lines, each cut and numbered. */
export function readToolCharacters(text: string): number {
  let characters = 0;
  const lines = splitLines(text);
  for (const line of lines) {
    characters += Math.min(line.length, READ_TOOL_MAX_LINE_CHARS) + 1 + READ_TOOL_LINE_PREFIX_CHARS;
  }
  return characters;
}

const DECLARATION_RE =
  /^\s*(?:import\b|export\b|from\s+\S+\s+import\b|(?:abstract\s+|async\s+|public\s+|private\s+|protected\s+|static\s+|pub(?:\(crate\))?\s+|default\s+)*(?:class|interface|type|enum|function|def|fn|func|struct|impl|trait|module|namespace|package|const\s+\w+\s*=\s*(?:async\s*)?\(|let\s+\w+\s*=\s*(?:async\s*)?\()\b|#{1,6}\s|describe\(|test\(|it\()/;

/** Declaration lines from the range: imports, exports, classes, functions, headings. */
export function outlineOf(text: string, maxChars = READ_CHECK_OUTLINE_CHARS): string {
  const picked: string[] = [];
  let used = 0;
  for (const line of splitLines(text)) {
    if (!DECLARATION_RE.test(line)) continue;
    const clipped = line.trimEnd().slice(0, 160);
    if (used + clipped.length + 1 > maxChars) break;
    picked.push(clipped);
    used += clipped.length + 1;
  }
  return picked.join("\n");
}

export function describeSize(input: {
  firstLine: number;
  lastLine: number;
  totalLines: number;
  tokens: number;
}): string {
  const tokens = input.tokens.toLocaleString("en-US");
  if (input.lastLine < input.firstLine)
    return `no lines of ${input.totalLines}, about ${tokens} tokens`;
  if (input.firstLine === 1 && input.lastLine === input.totalLines) {
    return `all ${input.totalLines} lines, about ${tokens} tokens`;
  }
  return `lines ${input.firstLine}-${input.lastLine} of ${input.totalLines}, about ${tokens} tokens`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function toolSummary(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const detail = item.detail;
  let summary: string;
  switch (detail.type) {
    case "shell":
      summary = `\`${clip(detail.command, 200)}\``;
      break;
    case "read":
    case "edit":
    case "write":
      summary = detail.filePath;
      break;
    case "search":
      summary = clip(detail.query, 120);
      break;
    case "fetch":
      summary = detail.url;
      break;
    default:
      summary = "";
  }
  const outcome = item.status === "failed" ? " -> failed" : "";
  return clip(`tool ${item.name}${summary ? ` ${summary}` : ""}${outcome}`, RECENT_OTHER_CHARS);
}

/** One line of `recent`, or null for rows that say nothing about intent. */
export function recentLine(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "assistant_message":
      return item.text.trim() ? `assistant: ${clip(item.text, RECENT_ASSISTANT_CHARS)}` : null;
    case "user_message":
      return item.text.trim() ? `user: ${clip(item.text, RECENT_OTHER_CHARS)}` : null;
    case "reasoning":
      return item.text.trim() ? `thinking: ${clip(item.text, RECENT_OTHER_CHARS)}` : null;
    case "tool_call":
      return toolSummary(item);
    // An error row carries a tool's stderr, which can quote a credential, and says little
    // about what the agent means to do.
    default:
      return null;
  }
}

/** A subagent's own Agent/Task brief (R1): the one shape shared by the provider, the observer, and the state. */
export interface SubagentBrief {
  description: string | null;
  prompt: string | null;
}

/**
 * Whether `brief` has anything to judge a read against. A declared-but-empty brief (both fields
 * null or blank) is content-free and must be treated exactly like a brief that was never found
 * (R4): the never-deny guarantee in `decision.ts` depends on this, not on whether a brief object
 * merely exists.
 */
export function hasSubagentBriefContent(brief: SubagentBrief | null | undefined): boolean {
  return Boolean(brief?.description?.trim() || brief?.prompt?.trim());
}

export interface ReadCheckStateInput {
  title: string | null;
  assignment: string | null;
  /**
   * Present when this read is inside a subagent whose own brief was found and has content (R1,
   * R4): its Agent/Task call's own description and prompt. Absent for a main agent's read, and
   * for a subagent's read whose brief could not be found or was content-free — both fall back to
   * the legacy task below (R4, "judged as today").
   */
  subagentBrief?: SubagentBrief;
  /**
   * The current turn's latest prompt from the leader or Tyler (R3), added after a main agent's
   * assignment. Ignored for a subagent read: R1 keeps the parent's task to one line.
   */
  latestPrompt?: string | null;
  /**
   * The agent's timeline tail, oldest first; the read's own tool call already removed. For a
   * subagent read with a brief, this is the subagent's own recent tool calls (R1), not the
   * parent's.
   */
  recent: readonly AgentTimelineItem[];
  /** A line kept in `recent` past the row cap: the search call that named this read's path (R3). */
  pinnedRecentLine?: string | null;
  why: string | null;
  /** Relative to the agent's cwd. */
  displayPath: string;
  size: string;
  /** The text of the range being read. */
  rangeText: string;
}

/**
 * `task`, by reader (docs/jev.md, Feature 16, R1 and R3). A subagent whose brief was found is
 * judged against that brief, with its parent's title kept as one line of context. Everyone else —
 * a main agent, or a subagent whose brief could not be found — keeps the legacy task: title,
 * assignment, and (R3) the current turn's latest prompt.
 */
function buildTask(input: ReadCheckStateInput): string {
  const subagentBrief = input.subagentBrief;
  if (subagentBrief && hasSubagentBriefContent(subagentBrief)) {
    const brief = [subagentBrief.description, subagentBrief.prompt]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .slice(0, TASK_ASSIGNMENT_CHARS);
    const parentLine = input.title?.trim() ? `(parent task: ${input.title.trim()})` : null;
    return [brief, parentLine].filter((part): part is string => Boolean(part)).join("\n");
  }
  return [
    input.title?.trim() || "(untitled agent)",
    input.assignment?.slice(0, TASK_ASSIGNMENT_CHARS),
    input.latestPrompt?.slice(0, TASK_ASSIGNMENT_CHARS),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

export interface ReadCheckState {
  task: string;
  recent: string[];
  why?: string;
  path: string;
  size: string;
  outline: string;
  excerpt: string;
}

function stateBytes(state: ReadCheckState): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

/** The state, at most `READ_CHECK_MAX_STATE_BYTES`: the excerpt shrinks first, then `recent`. */
export function buildReadCheckState(input: ReadCheckStateInput): ReadCheckState {
  const task = buildTask(input);
  const recent = input.recent
    .map(recentLine)
    .filter((line): line is string => line !== null)
    .slice(-RECENT_ROWS);
  if (input.pinnedRecentLine && !recent.includes(input.pinnedRecentLine)) {
    recent.unshift(input.pinnedRecentLine);
    // Keeps the pinned line and the newest rows; the next-oldest ordinary row is what the cap
    // would have dropped anyway.
    if (recent.length > RECENT_ROWS) recent.splice(1, 1);
  }
  const state: ReadCheckState = {
    task,
    recent,
    ...(input.why ? { why: clip(input.why, WHY_CHARS) } : {}),
    path: input.displayPath,
    size: input.size,
    outline: outlineOf(input.rangeText),
    excerpt: input.rangeText.slice(0, READ_CHECK_EXCERPT_CHARS),
  };
  let over = stateBytes(state) - READ_CHECK_MAX_STATE_BYTES;
  if (over > 0 && state.excerpt.length > MIN_EXCERPT_CHARS) {
    // Bytes, not characters, but every character is at least one byte: cutting `over` characters
    // removes at least `over` bytes.
    state.excerpt = state.excerpt.slice(
      0,
      Math.max(MIN_EXCERPT_CHARS, state.excerpt.length - over),
    );
    over = stateBytes(state) - READ_CHECK_MAX_STATE_BYTES;
  }
  while (over > 0 && state.recent.length > 0) {
    state.recent.shift();
    over = stateBytes(state) - READ_CHECK_MAX_STATE_BYTES;
  }
  if (over > 0) {
    state.outline = state.outline.slice(0, Math.max(0, state.outline.length - over));
    over = stateBytes(state) - READ_CHECK_MAX_STATE_BYTES;
  }
  if (over > 0) state.excerpt = state.excerpt.slice(0, Math.max(0, state.excerpt.length - over));
  return state;
}

/** The one question (docs/jev.md, "State and question"). Instructions name state fields only. */
export const READ_CHECK_QUESTIONS: JevQuestions = {
  [READ_CHECK_QUESTION_ID]: {
    type: "choice",
    instructions:
      "An agent working on `task` is about to load the file at `path` (`size`); `excerpt` and `outline` show what it holds, and `recent` is what the agent did last. Does the agent's next step need what this read loads?",
    criteria: {
      needed:
        "The next steps depend on the file's contents: the agent will change it, quote it, follow its code, or its details decide what to do next",
      part_needed:
        "Only a small part matters, one function or one section; the range is far more than the next step needs",
      not_needed:
        "Unrelated to `task` and `recent`: a wrong guess, a file already understood, or one the agent will not use",
      other: "Cannot tell from what is shown",
    },
  },
};
