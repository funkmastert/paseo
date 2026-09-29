import { createHash } from "node:crypto";

import { isSystemInjectedEnvelope } from "../agent/agent-prompt.js";
import type { AgentTimelineItem, ToolCallTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { normalizeForScan } from "./safety.js";

/**
 * The thread as the away auto-reply reads it (docs/jev.md, "Feature 14"): everything since Tyler
 * last wrote, not just the agent's last message. A plan or a tool call written earlier in the turn
 * is what "keep going" would approve, so the deterministic scan reads all of it, and JEV sees it
 * too, with Tyler's own recent messages.
 *
 * Tyler is known by the daemon, not by the text: a message counts as his only when the session
 * that sent it was an app client (`AgentManager.recordHumanPrompt`). A prompt from another agent,
 * the CLI, or anything forging the auto-reply marker is someone else.
 */

/** What JEV sees of the thread since Tyler, newest kept. */
const JEV_THREAD_CHARS = 6000;
const TYLER_MESSAGES = 3;
const TYLER_MESSAGE_CHARS = 1000;
const TOOL_INPUT_CHARS = 4000;
/** Written scripts run later; their content is part of what the agent means to do. */
const SCRIPT_FILE = /\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd|command)$/i;

/**
 * Tyler telling the agent to stop, wait, or leave it: the job then never replies, whatever JEV
 * says. Broad on purpose; a false hit costs one reply he writes himself.
 */
const HOLD =
  /\bstop|\bwait|\bhold\b|\bhold\s+(?:off|on)\b|\bpaus(?:e|ed|ing)\b|\bdon'?t\b|\bdo\s+not\b|\bnot\s+yet\b|\b(?:un)?til+\s+i\b|\bleave\s+(?:it|this|that|them)\b|\bi'?(?:ll|will)\s+(?:decide|check|look|review|handle|do\s+it|get\s+back|come\s+back|think|let\s+you\s+know|take\s+(?:it|over)|be\s+back)|\bstand\s*(?:by|down)\b|\bhang\s+on\b|\bhalt|\bfreeze\b|\bdo\s+nothing\b|\bnothing\s+(?:else|more|further)\b|\bno\s+more\b|\bpark\b|\bsit\s+tight\b|\blet\s+me\s+(?:check|think|look|review|decide|see|get\s+back|handle)|\bcheck\s+with\s+me\b|\bask\s+me\b|\bbefore\s+you\s+(?:do|go|proceed|continue|start|change|run|touch)|\bwhen\s+i(?:'m|\s+am|\s+get)?\s+back\b|\bbrb\b|\baway\b|\blater\b|\btomorrow\b|\bno\b(?!\s+(?:problem|worries|rush))|\bnope\b|\bcancel|\babort|\bquit\b|\bcease\b|\bblock(?:ed)?\s+on\s+me\b|\bneed\s+to\s+(?:think|check|decide|look)|\bi'?ll\s+decide\b|\bmy\s+call\b|\bnever\s*mind\b/i;

/** Whether Tyler's message (or any other message after it) says to hold. */
export function isHoldMessage(text: string): boolean {
  return HOLD.test(normalizeForScan(text));
}

/** How the job recognises its own replies in the timeline. */
export function replyTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ThreadIdentity {
  /** `clientMessageId`s of Tyler's messages, from the daemon's own record. */
  humanMessageIds: ReadonlySet<string>;
  /** Hashes of the texts this job sent. */
  sentHashes: ReadonlySet<string>;
}

export interface AwayReplyThread {
  /** Tyler's messages in the tail, newest last. */
  tylerMessages: string[];
  /** Everything since Tyler's last message, for the deterministic scan. Our replies left out. */
  scanText: string;
  /** Messages and tool calls since Tyler's last message, newest kept, for JEV. */
  jevText: string;
  /**
   * Messages after Tyler's last that neither he nor this job wrote and the daemon did not inject:
   * another agent, the CLI, a voice message it could not tie to him. Checked for a hold like his.
   */
  otherUserMessages: string[];
  /** The agent laid out a plan of two or more steps since Tyler last wrote. */
  hasPlan: boolean;
}

export type AwayReplyThreadResult =
  | { ok: true; thread: AwayReplyThread }
  | { ok: false; reason: string };

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** A written file's path, and its content when it is a script something may run next. */
function writtenFileText(filePath: string, content: string | undefined): string {
  return SCRIPT_FILE.test(filePath) ? `${filePath}\n${content ?? ""}` : filePath;
}

function toolCallBody(detail: ToolCallTimelineItem["detail"]): string {
  switch (detail.type) {
    case "shell":
      return detail.command;
    case "read":
      return detail.filePath;
    case "edit":
      return writtenFileText(detail.filePath, detail.newString ?? detail.unifiedDiff);
    case "write":
      return writtenFileText(detail.filePath, detail.content);
    case "search":
      return detail.query;
    case "fetch":
      return `${detail.url} ${detail.prompt ?? ""}`;
    case "worktree_setup":
      return detail.commands.map((command) => command.command).join("\n");
    case "sub_agent":
      return detail.description ?? "";
    case "plain_text":
      return `${detail.label ?? ""} ${detail.text ?? ""}`;
    case "plan":
      return detail.text;
    case "unknown":
      return json(detail.input);
  }
}

function toolCallText(item: ToolCallTimelineItem): string {
  return `${item.name}: ${toolCallBody(item.detail).slice(0, TOOL_INPUT_CHARS)}`;
}

type RowRole = "tyler" | "own" | "other-user" | "agent" | "none";

function classify(item: AgentTimelineItem, identity: ThreadIdentity): RowRole {
  if (item.type === "user_message") {
    if (item.clientMessageId && identity.humanMessageIds.has(item.clientMessageId)) return "tyler";
    if (identity.sentHashes.has(replyTextHash(item.text))) return "own";
    return "other-user";
  }
  if (item.type === "compaction" || item.type === "plugin") return "none";
  return "agent";
}

/** The text of an agent-side row, for the scan; null for rows with none. */
function agentText(item: AgentTimelineItem): { scan: string; jev: string | null } | null {
  switch (item.type) {
    case "assistant_message":
      return { scan: item.text, jev: `agent: ${item.text}` };
    case "reasoning":
      return { scan: item.text, jev: null };
    case "tool_call": {
      const text = toolCallText(item);
      return { scan: text, jev: `tool call ${text}` };
    }
    case "todo":
      return { scan: item.items.map((entry) => json(entry)).join("\n"), jev: null };
    case "error":
    case "notification":
      return { scan: item.message, jev: null };
    default:
      return null;
  }
}

const PLAN_STEP = /^\s*(?:[-*]\s*)?(?:step\s*)?\d{1,2}[.):]\s+\S/i;

function hasNumberedPlan(text: string): boolean {
  return text.split(/\r?\n/).filter((line) => PLAN_STEP.test(line)).length >= 2;
}

/**
 * The thread since Tyler's last message. When the tail holds no message of his, nothing can say
 * what he last asked for, so there is no thread to answer.
 */
export function readThread(
  rows: readonly AgentTimelineRow[],
  identity: ThreadIdentity,
): AwayReplyThreadResult {
  const roles = rows.map((row) => classify(row.item, identity));
  const lastTyler = roles.lastIndexOf("tyler");
  if (lastTyler === -1) return { ok: false, reason: "no-tyler-message" };

  const tylerMessages: string[] = [];
  for (let index = lastTyler; index >= 0 && tylerMessages.length < TYLER_MESSAGES; index -= 1) {
    const item = rows[index].item;
    if (roles[index] === "tyler" && item.type === "user_message") {
      tylerMessages.unshift(item.text.slice(0, TYLER_MESSAGE_CHARS));
    }
  }

  const scan: string[] = [];
  const jev: string[] = [];
  const otherUserMessages: string[] = [];
  let hasPlan = false;
  for (let index = lastTyler + 1; index < rows.length; index += 1) {
    const item = rows[index].item;
    const role = roles[index];
    if (role === "own" || role === "none") continue;
    if (role === "other-user" && item.type === "user_message") {
      const system = isSystemInjectedEnvelope(item.text);
      if (!system) otherUserMessages.push(item.text);
      scan.push(item.text);
      jev.push(`${system ? "system notice" : "message not from Tyler"}: ${item.text}`);
      continue;
    }
    const text = agentText(item);
    if (!text) continue;
    scan.push(text.scan);
    if (text.jev) jev.push(text.jev);
    if (item.type === "assistant_message" && hasNumberedPlan(item.text)) hasPlan = true;
    if (item.type === "tool_call" && item.detail.type === "plan") hasPlan = true;
  }

  const jevText = jev.join("\n");
  return {
    ok: true,
    thread: {
      tylerMessages,
      scanText: scan.join("\n"),
      jevText: jevText.length > JEV_THREAD_CHARS ? jevText.slice(-JEV_THREAD_CHARS) : jevText,
      otherUserMessages,
      hasPlan,
    },
  };
}

/** Why the thread says to hold, or null: Tyler's latest message, or any message after it. */
export function holdReason(thread: AwayReplyThread): string | null {
  const latest = thread.tylerMessages.at(-1);
  if (latest !== undefined && isHoldMessage(latest)) return "tyler-said-hold";
  if (thread.otherUserMessages.some(isHoldMessage)) return "hold-after-tyler";
  return null;
}
