import type { JevDecisionNote, JevOutcome, JevQuestions, JevService } from "../jev/contract.js";
import type { AgentTimelineItem, ToolCallDetail } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { projectTimelineRows } from "./timeline-projection.js";

/**
 * Feature 10, the stall judgment (docs/jev.md, "Feature 10: stall judgment"). JEV reads the tail of
 * an agent's activity and says whether it is progressing, looping, blocked on missing information
 * or waiting on a person. The stalled-agent sweep stays the only stall system: code decides what
 * each answer changes, only inside what the sweep already does (hold one sweep window, reword the
 * nudge, ask the ladder for a person first), and a judgment never cancels or interrupts an agent.
 *
 * This file holds the question, the state builder, the pure decision function, the loop watch's
 * prefilter, the per-agent hourly cap and the JEV-backed judge the sweep is given.
 */

export type StallActivity =
  | "progressing"
  | "looping"
  | "blocked_missing_info"
  | "waiting_on_human"
  | "other";

export type StallJudgmentBranch = "candidate" | "loop-watch";

/** Projected entries in the state: the last 25 tool calls, texts and errors. */
export const STALL_JUDGMENT_RECENT_ENTRIES = 25;
/**
 * Raw rows read to find them. A tool call is a row per status and assistant text a row per chunk,
 * so 25 projected entries take several times as many rows.
 */
export const STALL_JUDGMENT_READ_ROWS = 400;
const TEXT_CHARS = 160;
const INPUT_CHARS = 200;
const ASSIGNMENT_CHARS = 800;

/** Confidence floors for a stall candidate. Code owns them (docs/jev.md, "Thresholds"). */
export const STALL_JUDGMENT_FLOORS: Readonly<Record<Exclude<StallActivity, "other">, number>> = {
  progressing: 0.85,
  looping: 0.75,
  blocked_missing_info: 0.75,
  waiting_on_human: 0.75,
};
/** The loop watch reports `looping` at or over this on two consecutive sweeps. */
export const LOOP_WATCH_FLOOR = 0.8;
export const LOOP_WATCH_CONSECUTIVE = 2;
/** Tool calls the prefilter looks back over. */
export const LOOP_WATCH_TOOL_WINDOW = 12;
export const LOOP_REPEATED_INPUT_COUNT = 4;
export const LOOP_REPEATED_ERROR_COUNT = 3;
/** After `progressing`, the loop watch leaves the agent alone this long unless the repeat changes. */
export const LOOP_WATCH_QUIET_MS = 30 * 60_000;
export const LOOP_WATCH_MAX_PER_SWEEP = 8;
/**
 * JEV calls per agent per rolling hour, across both branches, so a looping agent cannot spend the
 * control lane's budget: the loop watch asks at most every sweep, a candidate once per episode.
 */
export const MAX_JUDGMENTS_PER_AGENT_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

export const STALL_ACTIVITY_QUESTION_ID = "activity";

export const STALL_CANDIDATE_CALL_SITE = "stall-sweep.candidate";
export const LOOP_WATCH_CALL_SITE = "stall-sweep.loop-watch";

export function stallActivityQuestions(): JevQuestions {
  return {
    [STALL_ACTIVITY_QUESTION_ID]: {
      type: "choice",
      instructions:
        "`recent` is the tail of an agent's activity, oldest first, and `quiet_minutes` is how long it has shown nothing new. Which describes the agent now?",
      criteria: {
        progressing:
          "Each step builds on the last and the latest step is plausibly still running: a long build, a test run, a download, a wait on another agent or on CI",
        looping:
          "It repeats the same command, edit or failing check with no new information between tries",
        blocked_missing_info:
          "It says or shows it cannot continue without a file, credential, decision or fact it does not have",
        waiting_on_human:
          "It is waiting for a person: its last message asks a question or for approval, or its last command is waiting for interactive input",
        other: "None of these",
      },
    },
  };
}

// ─── State ───────────────────────────────────────────────────────────────────────────────────

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, chars: number): string {
  const line = oneLine(text);
  return line.length <= chars ? line : `${line.slice(0, chars - 1)}…`;
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

/** The part of a tool call that says what it was asked to do: never its output. */
function toolInput(detail: ToolCallDetail): unknown {
  switch (detail.type) {
    case "shell":
      return { command: detail.command };
    case "read":
      return { filePath: detail.filePath, offset: detail.offset, limit: detail.limit };
    case "edit":
      return {
        filePath: detail.filePath,
        oldString: detail.oldString,
        newString: detail.newString,
      };
    case "write":
      return { filePath: detail.filePath, content: detail.content };
    case "search":
      return { query: detail.query, toolName: detail.toolName };
    case "fetch":
      return { url: detail.url, prompt: detail.prompt };
    case "worktree_setup":
      return { worktreePath: detail.worktreePath, branchName: detail.branchName };
    case "sub_agent":
      return { subAgentType: detail.subAgentType, description: detail.description };
    case "plain_text":
      return { label: detail.label, text: detail.text };
    case "plan":
      return { text: detail.text };
    case "unknown":
      return detail.input;
  }
}

function toolInputSummary(detail: ToolCallDetail): string {
  switch (detail.type) {
    case "shell":
      return detail.command;
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search":
      return detail.query;
    case "fetch":
      return detail.url;
    case "worktree_setup":
      return detail.worktreePath;
    case "sub_agent":
      return [detail.subAgentType, detail.description].filter(Boolean).join(": ");
    case "plain_text":
      return detail.text ?? detail.label ?? "";
    case "plan":
      return detail.text;
    case "unknown":
      return safeJson(detail.input);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function toolErrorText(item: ToolCallItem): string | null {
  if (item.status === "failed") {
    const error = item.error;
    if (typeof error === "string") return error;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
    return safeJson(error) || "failed";
  }
  if (
    item.detail.type === "shell" &&
    typeof item.detail.exitCode === "number" &&
    item.detail.exitCode !== 0
  ) {
    return `exit ${item.detail.exitCode}`;
  }
  return null;
}

/** `tool Bash \`npm test\``: the call without its outcome. */
function describeToolStep(item: ToolCallItem): string {
  const input = clip(toolInputSummary(item.detail), INPUT_CHARS);
  return input ? `tool ${item.name} \`${input}\`` : `tool ${item.name}`;
}

function formatToolCall(item: ToolCallItem): string {
  const head = describeToolStep(item);
  const error = toolErrorText(item);
  return error
    ? `${head} -> ${item.status}: ${clip(error, TEXT_CHARS)}`
    : `${head} -> ${item.status}`;
}

/** One `recent` line, or null for a row the judgment does not read. */
function formatEntry(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "tool_call":
      return formatToolCall(item);
    case "assistant_message":
      return item.text.trim() ? `assistant: ${clip(item.text, TEXT_CHARS)}` : null;
    case "reasoning":
      return item.text.trim() ? `reasoning: ${clip(item.text, TEXT_CHARS)}` : null;
    case "error":
      return `error: ${clip(item.message, TEXT_CHARS)}`;
    default:
      return null;
  }
}

/** The projected items of a raw tail: one per tool call, one per assistant or reasoning run. */
export function projectActivity(rows: readonly AgentTimelineRow[]): AgentTimelineItem[] {
  return projectTimelineRows({ rows, mode: "projected" }).map((entry) => entry.item);
}

export interface StallJudgmentStateInput {
  title: string | null;
  assignment: string | null;
  quietMinutes: number;
  rows: readonly AgentTimelineRow[];
}

export interface StallJudgmentState {
  title: string;
  assignment: string;
  quiet_minutes: number;
  recent: string[];
}

export function buildStallJudgmentState(input: StallJudgmentStateInput): StallJudgmentState {
  const recent = projectActivity(input.rows)
    .map(formatEntry)
    .filter((line): line is string => line !== null)
    .slice(-STALL_JUDGMENT_RECENT_ENTRIES);
  return {
    title: input.title?.trim() ?? "",
    assignment: input.assignment ? input.assignment.trim().slice(0, ASSIGNMENT_CHARS) : "",
    quiet_minutes: Math.max(0, Math.floor(input.quietMinutes)),
    recent,
  };
}

/** Whether the newest thing the agent did is a tool call that has not returned. */
export function newestIsRunningTool(rows: readonly AgentTimelineRow[]): boolean {
  const newest = projectActivity(rows).at(-1);
  return newest?.type === "tool_call" && newest.status === "running";
}

/** The first user message among `rows`: the agent's assignment when `rows` start at its first row. */
export function firstUserMessage(rows: readonly AgentTimelineRow[]): string | null {
  for (const row of rows) {
    if (row.item.type === "user_message" && row.item.text.trim()) return row.item.text;
  }
  return null;
}

// ─── The loop prefilter ──────────────────────────────────────────────────────────────────────

/**
 * Calls that repeat by design: waiting on another agent, CI, a timer or a background shell. The
 * doc names `paseo wait`, `gh run watch`, `sleep` and the Paseo wait tools; reading a background
 * shell's output (`BashOutput`, `TaskOutput`) is the same kind of wait.
 */
const POLLER_TOOL_NAME = /(?:^|__)(?:wait_for_agent(?:_start)?|BashOutput|TaskOutput)$/;
const POLLER_COMMAND = /\bpaseo\s+wait\b|\bgh\s+run\s+watch\b|(?:^|[\s;&|(])sleep\s+\d/;

export function isKnownPoller(item: ToolCallItem): boolean {
  if (POLLER_TOOL_NAME.test(item.name)) return true;
  return item.detail.type === "shell" && POLLER_COMMAND.test(item.detail.command);
}

export interface LoopMatch {
  kind: "repeated-input" | "repeated-error";
  /** Identifies the repeat, so the quiet period ends when it changes. */
  signature: string;
  count: number;
  /** The repeated step, for the nudge line and the digest. */
  step: string;
}

/**
 * In the last 12 tool calls, one tool with the same input (first 200 characters of its JSON) 4 or
 * more times, or one error text 3 or more times. Known pollers are not counted.
 */
export function findLoop(rows: readonly AgentTimelineRow[]): LoopMatch | null {
  const calls = projectActivity(rows)
    .filter((item): item is ToolCallItem => item.type === "tool_call")
    .filter((item) => !isKnownPoller(item))
    .slice(-LOOP_WATCH_TOOL_WINDOW);
  const inputs = new Map<string, { count: number; item: ToolCallItem }>();
  const errors = new Map<string, { count: number; item: ToolCallItem }>();
  for (const item of calls) {
    const signature = `${item.name}:${safeJson(toolInput(item.detail)).slice(0, INPUT_CHARS)}`;
    const input = inputs.get(signature) ?? { count: 0, item };
    input.count += 1;
    input.item = item;
    inputs.set(signature, input);
    const errorText = item.status === "failed" ? toolErrorText(item) : null;
    if (errorText) {
      const key = clip(errorText, INPUT_CHARS);
      const error = errors.get(key) ?? { count: 0, item };
      error.count += 1;
      error.item = item;
      errors.set(key, error);
    }
  }
  const byCount = (map: Map<string, { count: number; item: ToolCallItem }>) =>
    [...map.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const input = byCount(inputs);
  if (input && input[1].count >= LOOP_REPEATED_INPUT_COUNT) {
    return {
      kind: "repeated-input",
      signature: `input:${input[0]}`,
      count: input[1].count,
      step: describeToolStep(input[1].item),
    };
  }
  const error = byCount(errors);
  if (error && error[1].count >= LOOP_REPEATED_ERROR_COUNT) {
    return {
      kind: "repeated-error",
      signature: `error:${error[0]}`,
      count: error[1].count,
      step: `${describeToolStep(error[1].item)} failing with "${clip(error[0], TEXT_CHARS)}"`,
    };
  }
  return null;
}

// ─── The decision ────────────────────────────────────────────────────────────────────────────

export interface StallJudgmentAnswer {
  activity: StallActivity;
  confidence: number;
}

export type StallJudgmentAction =
  /** `progressing` with a tool call still running: wait one more `stallMinutes`, once. */
  | { kind: "hold" }
  /** Nudge as today with one more line; `personFirst` asks the ladder for a person over an agent. */
  | { kind: "nudge"; line: string; personFirst: { reason: string; confidence: number } | null }
  /** Exactly today's behaviour. */
  | { kind: "today" };

const ACTIVITY_LABELS: ReadonlySet<string> = new Set<StallActivity>([
  "progressing",
  "looping",
  "blocked_missing_info",
  "waiting_on_human",
  "other",
]);

function formatConfidence(confidence: number): string {
  return confidence.toFixed(2);
}

/**
 * What a stall candidate's judgment changes, from the table in docs/jev.md. Pure. The caller applies
 * it only for an `answered` outcome; for a shadow it records it as what would have happened.
 */
export function decideStallAction(input: {
  answer: StallJudgmentAnswer | null;
  newestIsRunningTool: boolean;
  /** The episode has already been held once. */
  alreadyHeld: boolean;
  /** The repeated step the prefilter found, if any. */
  repeatedStep: string | null;
}): StallJudgmentAction {
  const { answer } = input;
  if (!answer || answer.activity === "other") return { kind: "today" };
  if (answer.confidence < STALL_JUDGMENT_FLOORS[answer.activity]) return { kind: "today" };
  const confidence = formatConfidence(answer.confidence);
  switch (answer.activity) {
    case "progressing":
      return input.newestIsRunningTool && !input.alreadyHeld ? { kind: "hold" } : { kind: "today" };
    case "looping":
      return {
        kind: "nudge",
        line: input.repeatedStep
          ? `You appear to be repeating: ${input.repeatedStep}. Try a different approach, or say what blocks you.`
          : "You appear to be repeating the same step. Try a different approach, or say what blocks you.",
        personFirst: null,
      };
    case "blocked_missing_info":
      return {
        kind: "nudge",
        line: "You appear unable to continue without something you do not have. Name exactly what you are missing (a file, credential, decision or fact) and end your turn with that, so a person can supply it.",
        personFirst: {
          reason: `JEV judged it blocked on missing information (${confidence})`,
          confidence: answer.confidence,
        },
      };
    case "waiting_on_human":
      return {
        kind: "nudge",
        line: "You appear to be waiting for a person. Do not wait inside a turn: end your turn with the question, so the person is told.",
        personFirst: {
          reason: `JEV judged it waiting on a person (${confidence})`,
          confidence: answer.confidence,
        },
      };
  }
}

/** Short words for what an action did, for the decision list and the measurement file. */
export function describeStallAction(action: StallJudgmentAction): string {
  switch (action.kind) {
    case "hold":
      return "held one more stall window before nudging";
    case "nudge":
      return action.personFirst
        ? "nudged with a line; asked the ladder for a person first"
        : "nudged with a line about the repeat";
    case "today":
      return "nudged as today";
  }
}

// ─── The per-agent hourly cap ────────────────────────────────────────────────────────────────

/** A rolling per-agent count of JEV calls. In memory: a restart only allows one more hour's worth. */
export class PerAgentHourlyCap {
  private readonly calls = new Map<string, number[]>();

  constructor(private readonly max: number) {}

  /** True, and the call counted, when the agent is under its cap for the last hour. */
  take(agentId: string, nowMs: number): boolean {
    const recent = (this.calls.get(agentId) ?? []).filter((at) => at > nowMs - HOUR_MS);
    if (recent.length >= this.max) {
      this.calls.set(agentId, recent);
      return false;
    }
    recent.push(nowMs);
    this.calls.set(agentId, recent);
    return true;
  }

  forget(agentId: string): void {
    this.calls.delete(agentId);
  }
}

// ─── The judge ───────────────────────────────────────────────────────────────────────────────

export interface StallJudgeRequest {
  agentId: string;
  branch: StallJudgmentBranch;
  title: string | null;
  assignment: string | null;
  quietMinutes: number;
  rows: readonly AgentTimelineRow[];
}

export type StallJudgment =
  | {
      kind: "judged";
      callId: string;
      answer: StallJudgmentAnswer;
      /** False for a shadow answer: the caller records what it would have done and does today's. */
      applied: boolean;
      costUsd: number | null;
    }
  /** No usable answer. Today's behaviour. `callId` is null when nothing reached `decide`. */
  | { kind: "none"; callId: string | null; reason: string; costUsd: number | null };

/** What the sweep is given. Every method is total: a throw inside is `none`, never an error. */
export interface StallJudge {
  /** Cheap: whether a judgment could be sent now (key, switches, the lane's budget and circuit). */
  isActive(): boolean;
  /** `agents.jev.stallJudgment.loopWatch`. */
  loopWatchEnabled(): boolean;
  judge(request: StallJudgeRequest): Promise<StallJudgment>;
  record(note: JevDecisionNote): void;
}

function costOf(outcome: JevOutcome): number | null {
  const meta = outcome.kind === "unavailable" ? null : outcome.meta;
  return meta && meta.cost.usd !== null ? meta.cost.usd : null;
}

/** The judgment an outcome carries: answered and shadow alike, so a shadow can be measured. */
export function readStallJudgment(outcome: JevOutcome): StallJudgment {
  if (outcome.kind === "answered" || outcome.kind === "shadow") {
    const answer = outcome.answers[STALL_ACTIVITY_QUESTION_ID];
    if (answer?.type === "choice" && ACTIVITY_LABELS.has(answer.choice)) {
      return {
        kind: "judged",
        callId: outcome.callId,
        answer: { activity: answer.choice as StallActivity, confidence: answer.confidence },
        applied: outcome.kind === "answered",
        costUsd: costOf(outcome),
      };
    }
    return {
      kind: "none",
      callId: outcome.callId,
      reason: "no-activity-answer",
      costUsd: costOf(outcome),
    };
  }
  return {
    kind: "none",
    callId: outcome.callId,
    reason: `${outcome.kind}:${outcome.reason}`,
    costUsd: costOf(outcome),
  };
}

export interface JevStallJudgeOptions {
  jev: Pick<JevService, "decide" | "isActive" | "checkScope" | "decisions">;
  /** `agents.jev.stallJudgment.loopWatch`, read fresh; a throw reads as off. */
  readLoopWatch: () => boolean;
  now?: () => number;
  maxPerAgentPerHour?: number;
}

/**
 * The production judge. It checks the D7 scope before building any state, holds each agent to
 * `MAX_JUDGMENTS_PER_AGENT_PER_HOUR`, and asks JEV with the agent as the scope. It never throws.
 */
export function createJevStallJudge(options: JevStallJudgeOptions): StallJudge {
  const now = options.now ?? Date.now;
  const cap = new PerAgentHourlyCap(options.maxPerAgentPerHour ?? MAX_JUDGMENTS_PER_AGENT_PER_HOUR);
  const { jev } = options;
  return {
    isActive: () => {
      try {
        return jev.isActive("stallJudgment");
      } catch {
        return false;
      }
    },
    loopWatchEnabled: () => {
      try {
        return options.readLoopWatch();
      } catch {
        return false;
      }
    },
    judge: async (request) => {
      try {
        const scope = { cwds: [], agentIds: [request.agentId] };
        if ((await jev.checkScope(scope)) === "excluded") {
          return { kind: "none", callId: null, reason: "excluded", costUsd: null };
        }
        if (!cap.take(request.agentId, now())) {
          return { kind: "none", callId: null, reason: "agent-hourly-cap", costUsd: null };
        }
        const outcome = await jev.decide({
          feature: "stallJudgment",
          callSite:
            request.branch === "candidate" ? STALL_CANDIDATE_CALL_SITE : LOOP_WATCH_CALL_SITE,
          state: { ...buildStallJudgmentState(request) },
          questions: stallActivityQuestions(),
          scope,
          subject: { agentId: request.agentId },
        });
        return readStallJudgment(outcome);
      } catch {
        return { kind: "none", callId: null, reason: "judge-threw", costUsd: null };
      }
    },
    record: (note) => {
      try {
        jev.decisions.record(note);
      } catch {
        // The decision list is best effort.
      }
    },
  };
}
