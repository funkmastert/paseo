import type { ResolvedJevConfig } from "../jev/config.js";
import type {
  JevAnswer,
  JevEgressScope,
  JevOutcome,
  JevQuestions,
  JevService,
} from "../jev/contract.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { isSystemInjectedEnvelope } from "./agent-prompt.js";
import {
  LEADER_COMPACTION_MESSAGE_HEADER,
  isLeaderCompactionCandidate,
  resolveLeaderCompactionConfig,
  type LeaderCompactionAgentInput,
  type LeaderCompactionSettings,
  type LeaderCompactionTiming,
} from "./leader-compaction-planner.js";
import { projectTimelineRows } from "./timeline-projection.js";

/**
 * Feature 9, compaction timing (docs/jev.md, "Feature 9: compaction timing"). After each leader
 * turn over `considerAtTokens`, JEV judges whether the leader is at a clean break or mid-way
 * through a multi-step edit. Code turns the answers into one verdict per agent, which
 * AgentLeaderCompactionMonitor reads at its next sweep: `startEarly` under the line, `defer` at
 * it. JEV decides when to compact, never what to keep. When a `prepare` step ends it also picks
 * the turn the live work starts at, for the `/compact` instructions.
 *
 * Nothing here is on the agent's path. The turn has ended before the advisor asks, the monitor
 * reads whatever verdict is ready, and every miss is today's behaviour.
 */

export const COMPACTION_TIMING_CALL_SITE = "leader-compaction.timing";
export const CUT_POINT_CALL_SITE = "leader-compaction.cut-point";
/** Raw rows read per question. A leader's turn is many rows: one per tool status, per text chunk. */
export const COMPACTION_TIMING_READ_ROWS = 400;

/** Growth since the last compaction before an early start can pay for its three turns. */
export const MIN_GROWTH_FOR_EARLY_START = 50_000;
/** The cut point is used at this confidence or more. */
export const CUT_POINT_FLOOR = 0.6;

const MID_OPERATION_FLOOR = 0.6;
const SWITCHED_FLOOR = 0.7;
const BOUNDARY_FLOOR = 0.6;
/** `needs_history` under this is "none of it": the new work stands alone. */
const NEEDS_HISTORY_CEILING = 1;

const REQUEST_CHARS = 600;
const PREVIOUS_USER_CHARS = 200;
const PREVIOUS_SYSTEM_CHARS = 120;
const RESTORE_NOTE_CHARS = 400;
const RECENT_TURN_CHARS = 600;
const PREVIOUS_MESSAGES = 40;
const CUT_POINT_TURNS = 60;
const CUT_POINT_TURN_CHARS = 120;

/** `agents.jev.compactionTiming`, less the switches every feature has. */
export type CompactionTimingSettings = Pick<
  ResolvedJevConfig["compactionTiming"],
  "considerAtTokens" | "ceilingTokens" | "maxDeferrals" | "cutPoint"
>;

// ─── The questions ───────────────────────────────────────────────────────────────────────────

/** Verbatim from the reference's level07/should-compact.ts. */
export function compactionTimingQuestions(): JevQuestions {
  return {
    switched_gears: {
      type: "noul",
      instructions: "Is `current_request` a different task from `previous_work`?",
      criteria: {
        true: "A new feature, a different file area, a different goal, or an unrelated question",
        false: "The same task continuing, a follow up, a fix to what was just done",
      },
    },
    at_boundary: {
      type: "noul",
      instructions: "Did `recent_turn` finish a unit of work?",
      criteria: {
        true: "Tests passed, a commit was made, a summary was given, or a question was asked of the user",
        false: "Mid task, more steps clearly remain",
      },
    },
    needs_history: {
      type: "score",
      instructions: "How much of `previous_work` does the next step need?",
      criteria: [
        "None; the new work stands alone",
        "Some references, a file name or a decision",
        "Most of it; the work continues directly from it",
      ],
    },
    mid_operation: {
      type: "noul",
      instructions:
        "Is the agent in the middle of a multi step edit whose partial state only exists in the conversation?",
      criteria: {
        true: "Half applied changes, a plan being executed step by step, an unfinished refactor",
        false: "A clean point, nothing half done",
      },
    },
  };
}

/**
 * From the reference's level07/pick-cut-point.ts. The turns travel in the criteria, keyed by
 * index, so the pick is always a real turn.
 */
export function cutPointQuestions(turns: readonly string[]): JevQuestions {
  const criteria: Record<string, string> = {};
  turns.forEach((turn, index) => {
    criteria[String(index)] = turn;
  });
  criteria["none"] = "Every turn is still live; keep the most recent context only";
  return {
    live_from: {
      type: "choice",
      instructions:
        "Which turn in `turns` starts the work that is still live? Earlier turns can be summarized briefly.",
      criteria,
    },
  };
}

// ─── The state ───────────────────────────────────────────────────────────────────────────────

export interface CompactionTimingState {
  current_request: string;
  previous_work: string;
  recent_turn: string;
  tools_this_turn: string[];
}

/** What one read of the timeline gives the advisor: the state and the facts its guards need. */
export interface CompactionTimingView {
  state: CompactionTimingState;
  /** The last turn left a tool call running. */
  unfinishedTool: boolean;
  /** The last turn started a child agent or a subagent. */
  startedChild: boolean;
  /** The monitor already sent a prepare step since the last compaction: an episode started. */
  prepareSent: boolean;
  /** The user turns since the last compaction, newest 60, oldest first, for the cut point. */
  turns: string[];
}

/** Tools that start an agent whose finish the leader has to remember. */
const CHILD_TOOL_NAME = /(?:^|__)create_agent$/;
const CHILD_COMMAND = /\bpaseo\s+run\b/;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, chars: number): string {
  const line = oneLine(text);
  return line.length <= chars ? line : `${line.slice(0, chars - 1)}…`;
}

function envelopeBody(text: string): string {
  return text.replace(/^<paseo-system>\n/, "").replace(/\n<\/paseo-system>$/, "");
}

type UserMessage =
  | { kind: "user"; text: string }
  | { kind: "system"; text: string }
  | { kind: "restore"; note: string | null }
  | { kind: "prepare" }
  | { kind: "compact" };

function classifyUserMessage(text: string): UserMessage {
  if (text.startsWith("/compact")) return { kind: "compact" };
  if (!isSystemInjectedEnvelope(text)) return { kind: "user", text };
  const body = envelopeBody(text);
  if (body.startsWith(`${LEADER_COMPACTION_MESSAGE_HEADER} 1 of 3`)) return { kind: "prepare" };
  if (body.startsWith(LEADER_COMPACTION_MESSAGE_HEADER)) {
    const note = /<restore-note>\n([\s\S]*?)\n<\/restore-note>/.exec(body)?.[1] ?? null;
    return { kind: "restore", note };
  }
  return { kind: "system", text: body };
}

function describeMessage(message: { kind: "user" | "system"; text: string }, chars: number) {
  return message.kind === "user"
    ? clip(message.text, chars)
    : `system: ${clip(message.text, Math.max(1, chars - "system: ".length))}`;
}

function isChildStart(item: Extract<AgentTimelineItem, { type: "tool_call" }>): boolean {
  if (CHILD_TOOL_NAME.test(item.name)) return true;
  if (item.detail.type === "sub_agent") return true;
  return item.detail.type === "shell" && CHILD_COMMAND.test(item.detail.command);
}

function readRecentTurn(rows: readonly AgentTimelineRow[]): {
  recentTurn: string;
  tools: string[];
  unfinishedTool: boolean;
  startedChild: boolean;
} {
  const start = rows.findLastIndex((row) => row.item.type === "user_message") + 1;
  const items = projectTimelineRows({ rows: rows.slice(start), mode: "projected" }).map(
    (entry) => entry.item,
  );
  const calls = items.filter(
    (item): item is Extract<AgentTimelineItem, { type: "tool_call" }> => item.type === "tool_call",
  );
  const tools = [...new Set(calls.map((call) => call.name))];
  const lastText = items.findLast(
    (item) => item.type === "assistant_message" && item.text.trim() !== "",
  );
  let recentTurn = "(no output)";
  if (lastText?.type === "assistant_message") {
    recentTurn = clip(lastText.text, RECENT_TURN_CHARS);
  } else if (tools.length > 0) {
    recentTurn = clip(`(tool calls only: ${tools.join(", ")})`, RECENT_TURN_CHARS);
  }
  return {
    recentTurn,
    tools,
    unfinishedTool: calls.some((call) => call.status === "running"),
    startedChild: calls.some(isChildStart),
  };
}

/** The state from a tail of the timeline: everything after the last `compaction` row. */
export function readCompactionTimingView(rows: readonly AgentTimelineRow[]): CompactionTimingView {
  const lastCompaction = rows.findLastIndex((row) => row.item.type === "compaction");
  const messages: UserMessage[] = [];
  for (const row of rows.slice(lastCompaction + 1)) {
    if (row.item.type === "user_message" && row.item.text.trim()) {
      messages.push(classifyUserMessage(row.item.text));
    }
  }
  const work = messages.filter(
    (message): message is Extract<UserMessage, { kind: "user" | "system" }> =>
      message.kind === "user" || message.kind === "system",
  );
  // The latest request a person made; with none since the compaction, the latest envelope.
  const lastUser = work.findLastIndex((message) => message.kind === "user");
  const currentIndex = lastUser === -1 ? work.length - 1 : lastUser;
  const current = work[currentIndex];

  const note = messages.findLast((message) => message.kind === "restore");
  const previous = [
    ...(note?.kind === "restore" && note.note
      ? [`restore note: ${clip(note.note, RESTORE_NOTE_CHARS)}`]
      : []),
    ...work
      .slice(0, Math.max(0, currentIndex))
      .slice(-PREVIOUS_MESSAGES)
      .map((message) =>
        message.kind === "user"
          ? `user: ${clip(message.text, PREVIOUS_USER_CHARS)}`
          : `system: ${clip(message.text, PREVIOUS_SYSTEM_CHARS)}`,
      ),
  ];
  const turn = readRecentTurn(rows);
  return {
    state: {
      current_request: current ? describeMessage(current, REQUEST_CHARS) : "(none)",
      previous_work: previous.length > 0 ? previous.join("\n") : "(none)",
      recent_turn: turn.recentTurn,
      tools_this_turn: turn.tools,
    },
    unfinishedTool: turn.unfinishedTool,
    startedChild: turn.startedChild,
    prepareSent: messages.some((message) => message.kind === "prepare"),
    turns: work
      .slice(-CUT_POINT_TURNS)
      .map((message) => describeMessage(message, CUT_POINT_TURN_CHARS)),
  };
}

// ─── The decision ────────────────────────────────────────────────────────────────────────────

export interface CompactionTimingAnswers {
  switchedGears: number;
  atBoundary: number;
  needsHistory: number;
  midOperation: number;
}

/** The four answers, or null when any is missing or the wrong shape. */
export function readCompactionTimingAnswers(
  answers: Record<string, JevAnswer>,
): CompactionTimingAnswers | null {
  const noul = (id: string) => {
    const answer = answers[id];
    return answer?.type === "noul" ? answer.noul : null;
  };
  const needs = answers["needs_history"];
  const switchedGears = noul("switched_gears");
  const atBoundary = noul("at_boundary");
  const midOperation = noul("mid_operation");
  if (switchedGears === null || atBoundary === null || midOperation === null) return null;
  if (needs?.type !== "score") return null;
  return { switchedGears, atBoundary, needsHistory: needs.score, midOperation };
}

export interface CompactionTimingDecisionInput {
  answers: CompactionTimingAnswers;
  usedTokens: number;
  prepareAtTokens: number;
  settings: CompactionTimingSettings;
  /** Consecutive `defer` verdicts before this one. */
  deferrals: number;
  guards: {
    unfinishedTool: boolean;
    startedChild: boolean;
    grownTokens: number;
    earlyStartUsed: boolean;
  };
}

export interface CompactionTimingDecision {
  timing: LeaderCompactionTiming | null;
  /** Why, in a few words, for the savings record and the log. */
  note: string;
}

const SWITCHED_REASON = "your work has moved on to a different task";
const BOUNDARY_REASON =
  "your last turn finished a unit of work, and the next step needs little of what came before";
const DEFER_REASON = "you are mid-way through a multi-step edit";

/** The reference's `decideTier`, with the lines and guards of docs/jev.md, "Thresholds". Pure. */
export function decideCompactionTiming(
  input: CompactionTimingDecisionInput,
): CompactionTimingDecision {
  const { answers, usedTokens, prepareAtTokens, settings, guards } = input;
  const mid = answers.midOperation > MID_OPERATION_FLOOR;
  if (usedTokens >= prepareAtTokens) {
    if (!mid) return { timing: null, note: "clean at the line" };
    if (usedTokens >= settings.ceilingTokens) return { timing: null, note: "at the ceiling" };
    if (input.deferrals >= settings.maxDeferrals) {
      return { timing: null, note: "deferrals used up" };
    }
    return {
      timing: { kind: "defer", ceilingTokens: settings.ceilingTokens, reason: DEFER_REASON },
      note: "mid-operation",
    };
  }
  if (usedTokens < settings.considerAtTokens) return { timing: null, note: "under the line" };
  if (mid) return { timing: null, note: "mid-operation" };
  const switched = answers.switchedGears > SWITCHED_FLOOR;
  const boundary =
    answers.atBoundary > BOUNDARY_FLOOR && answers.needsHistory < NEEDS_HISTORY_CEILING;
  if (!switched && !boundary) return { timing: null, note: "same work continuing" };
  if (guards.unfinishedTool) return { timing: null, note: "guard: a tool call is unfinished" };
  if (guards.startedChild) return { timing: null, note: "guard: a child was started" };
  if (guards.grownTokens < MIN_GROWTH_FOR_EARLY_START) {
    return { timing: null, note: "guard: under 50K of growth since the last compaction" };
  }
  if (guards.earlyStartUsed) return { timing: null, note: "guard: already started early" };
  return {
    timing: {
      kind: "startEarly",
      lineTokens: settings.considerAtTokens,
      reason: switched ? SWITCHED_REASON : BOUNDARY_REASON,
    },
    note: switched ? "switched gears" : "at a boundary",
  };
}

/** The `/compact` sentence for a confident pick, or null for `none` or under the floor. Pure. */
export function formatCutPoint(turns: readonly string[], answer: JevAnswer | undefined) {
  if (answer?.type !== "choice" || answer.choice === "none") return null;
  if (answer.confidence < CUT_POINT_FLOOR) return null;
  const turn = turns[Number(answer.choice)];
  if (turn === undefined) return null;
  return (
    `The live work starts at "${turn.replaceAll('"', "'")}". Summarize everything before it in ` +
    "a few lines; keep the decisions, file paths and open questions from there on in full."
  );
}

// ─── The advisor ─────────────────────────────────────────────────────────────────────────────

/** A verdict and whether it may act. A shadow answer only shapes a dry run's would-start. */
export interface LeaderCompactionTimingVerdict {
  timing: LeaderCompactionTiming;
  live: boolean;
}

/** What the monitor uses. */
export type LeaderCompactionTimingPort = Pick<
  LeaderCompactionTimingAdvisor,
  "verdictFor" | "noteEarlyStart" | "requestCutPoint" | "cutPointFor"
>;

interface LeaderCompactionTimingLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface LeaderCompactionTimingOptions {
  jev: Pick<JevService, "decide" | "isActive" | "checkScope" | "savings">;
  readAgent: (agentId: string) => LeaderCompactionAgentInput | null;
  /** The tail of the agent's timeline, `COMPACTION_TIMING_READ_ROWS` rows. */
  readTimeline: (agentId: string) => readonly AgentTimelineRow[];
  readLeaderCompaction: () => LeaderCompactionSettings | undefined;
  readTimingConfig: () => CompactionTimingSettings;
  /** The monitor's episode is open: its own prepare, compact and restore turns are not asked about. */
  isEpisodeOpen: (agentId: string) => boolean;
  logger: LeaderCompactionTimingLogger;
}

/**
 * One agent's memory. A "cycle" runs from one compaction to the next; a context that shrank is
 * taken as a compaction, whatever did it.
 */
interface AgentMemory {
  /** Bumped on every finished turn; an answer for an older turn is dropped. */
  turn: number;
  verdict: LeaderCompactionTimingVerdict | null;
  lastSeenTokens: number;
  /** The context at the start of this cycle, or when the advisor first saw the agent. */
  baselineTokens: number;
  earlyStartUsed: boolean;
  deferrals: number;
}

const WOULD_BE: Record<LeaderCompactionTiming["kind"], string> = {
  startEarly: "start-early",
  defer: "defer",
};

/** The answers of a call that reached JEV, shadow included; null for no usable answer. */
function answersOf(outcome: JevOutcome): Record<string, JevAnswer> | null {
  return outcome.kind === "answered" || outcome.kind === "shadow" ? outcome.answers : null;
}

interface TimingRecordInput {
  agentId: string;
  callId: string;
  live: boolean;
  usedTokens: number;
  prepareAtTokens: number;
  settings: CompactionTimingSettings;
  answers: CompactionTimingAnswers | null;
  decision: CompactionTimingDecision | null;
  /** The agent finished another turn before the answer came back. */
  stale: boolean;
}

/**
 * Asks after each leader turn and keeps one verdict per agent in memory. Every method is total:
 * a throw inside is logged and leaves the agent with no verdict, which is today's behaviour.
 */
export class LeaderCompactionTimingAdvisor {
  private readonly options: LeaderCompactionTimingOptions;
  private readonly memory = new Map<string, AgentMemory>();
  /** The `/compact` sentence per agent, from a live answer; replaced at each request. */
  private readonly cutPoints = new Map<string, string>();
  /** Calls in flight. Tests await them through `settle()`. */
  private readonly pending = new Set<Promise<void>>();

  constructor(options: LeaderCompactionTimingOptions) {
    this.options = options;
  }

  /** Fed by `onAgentTurnFinished`. Synchronous and in memory; the JEV call runs after it returns. */
  onTurnFinished(params: { agentId: string }): void {
    const { agentId } = params;
    try {
      const settings = this.options.readLeaderCompaction();
      if (settings?.enabled !== true) {
        this.memory.delete(agentId);
        return;
      }
      const config = resolveLeaderCompactionConfig(settings);
      const agent = this.options.readAgent(agentId);
      const used = agent?.contextWindowUsedTokens;
      if (!agent || !isLeaderCompactionCandidate(agent, config) || used === undefined) {
        this.memory.delete(agentId);
        return;
      }
      const memory = this.observe(agentId, used);
      if (this.options.isEpisodeOpen(agentId)) return;
      this.track(this.ask(agentId, memory.turn, used, config.prepareAtTokens));
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "Compaction timing: turn not considered");
    }
  }

  /** The verdict from the agent's last turn, or null. */
  verdictFor(agentId: string): LeaderCompactionTimingVerdict | null {
    return this.memory.get(agentId)?.verdict ?? null;
  }

  /**
   * The monitor started an episode early, or reported one in dry run. That uses the verdict up, and
   * the cycle's one early start.
   */
  noteEarlyStart(agentId: string): void {
    const memory = this.memory.get(agentId);
    if (!memory) return;
    memory.earlyStartUsed = true;
    memory.verdict = null;
  }

  /** A prepare step ended. The answer is used if it is ready by the sweep that sends `/compact`. */
  requestCutPoint(agentId: string): void {
    try {
      this.cutPoints.delete(agentId);
      if (!this.options.jev.isActive("compactionTiming")) return;
      if (!this.options.readTimingConfig().cutPoint) return;
      this.track(this.askCutPoint(agentId));
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "Compaction timing: no cut point");
    }
  }

  /** The sentence to append to `/compact`, from a live answer only. */
  cutPointFor(agentId: string): string | null {
    return this.cutPoints.get(agentId) ?? null;
  }

  /** Resolves once every call started so far has ended. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }

  /**
   * Records the reading and starts a new turn. The verdict is cleared now: it is replaced by this
   * turn's, or there is none.
   */
  private observe(agentId: string, used: number): AgentMemory {
    const existing = this.memory.get(agentId);
    if (!existing) {
      const memory: AgentMemory = {
        turn: 1,
        verdict: null,
        lastSeenTokens: used,
        baselineTokens: used,
        earlyStartUsed: false,
        deferrals: 0,
      };
      this.memory.set(agentId, memory);
      return memory;
    }
    existing.turn += 1;
    existing.verdict = null;
    if (used < existing.lastSeenTokens) {
      existing.baselineTokens = used;
      existing.earlyStartUsed = false;
      existing.deferrals = 0;
    }
    existing.lastSeenTokens = used;
    return existing;
  }

  private track(task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Compaction timing: call failed");
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }

  private scopeOf(agentId: string): JevEgressScope {
    return { cwds: [], agentIds: [agentId] };
  }

  /** The D7 check before the timeline is read. Excluded is counted, never sent. */
  private async inScope(agentId: string): Promise<boolean> {
    if ((await this.options.jev.checkScope(this.scopeOf(agentId))) === "ok") return true;
    this.options.jev.savings.countNotAsked("compactionTiming", "excluded");
    return false;
  }

  private async ask(
    agentId: string,
    turn: number,
    usedTokens: number,
    prepareAtTokens: number,
  ): Promise<void> {
    // The config and the JEV snapshot are read once the turn's own handling has returned.
    await Promise.resolve();
    if (!this.options.jev.isActive("compactionTiming")) return;
    const settings = this.options.readTimingConfig();
    if (usedTokens < settings.considerAtTokens) return;
    if (!(await this.inScope(agentId))) return;
    const view = readCompactionTimingView(this.options.readTimeline(agentId));
    const outcome = await this.options.jev.decide({
      feature: "compactionTiming",
      callSite: COMPACTION_TIMING_CALL_SITE,
      state: { ...view.state },
      questions: compactionTimingQuestions(),
      scope: this.scopeOf(agentId),
      subject: { agentId },
    });
    const raw = answersOf(outcome);
    const answers = raw ? readCompactionTimingAnswers(raw) : null;
    const memory = this.memory.get(agentId);
    // An answer for an older turn is recorded, never kept: the newer turn replaced its verdict.
    const current = memory?.turn === turn ? memory : null;
    const decision =
      answers && current
        ? decideCompactionTiming({
            answers,
            usedTokens,
            prepareAtTokens,
            settings,
            deferrals: current.deferrals,
            guards: {
              unfinishedTool: view.unfinishedTool,
              startedChild: view.startedChild,
              grownTokens: usedTokens - current.baselineTokens,
              earlyStartUsed: current.earlyStartUsed || view.prepareSent,
            },
          })
        : null;
    const live = outcome.kind === "answered";
    if (current && decision) {
      current.verdict = decision.timing ? { timing: decision.timing, live } : null;
      current.deferrals = decision.timing?.kind === "defer" ? current.deferrals + 1 : 0;
    }
    this.recordTiming({
      agentId,
      callId: outcome.callId,
      live,
      usedTokens,
      prepareAtTokens,
      settings,
      answers,
      decision,
      stale: current === null,
    });
  }

  /** One involvement per call that reached JEV; the ledger drops one that never left. */
  private recordTiming(input: TimingRecordInput): void {
    const { answers, decision } = input;
    const timing = decision?.timing ?? null;
    const wouldBe = timing ? WOULD_BE[timing.kind] : "at-line";
    const changed = input.live && timing !== null;
    this.options.jev.savings.record({
      feature: "compactionTiming",
      callSite: COMPACTION_TIMING_CALL_SITE,
      callId: input.callId,
      agentId: input.agentId,
      involvement: "Is this a clean point to compact the leader?",
      decision: { did: changed ? wouldBe : "at-line", wouldBe, changed },
      facts: {
        usedTokens: input.usedTokens,
        prepareAtTokens: input.prepareAtTokens,
        considerAtTokens: input.settings.considerAtTokens,
        verdict: timing?.kind ?? null,
        note: decision?.note ?? null,
        switchedGears: answers?.switchedGears ?? null,
        atBoundary: answers?.atBoundary ?? null,
        needsHistory: answers?.needsHistory ?? null,
        midOperation: answers?.midOperation ?? null,
        stale: input.stale,
      },
    });
  }

  private async askCutPoint(agentId: string): Promise<void> {
    if (!(await this.inScope(agentId))) return;
    const view = readCompactionTimingView(this.options.readTimeline(agentId));
    if (view.turns.length < 2) return;
    const outcome = await this.options.jev.decide({
      feature: "compactionTiming",
      callSite: CUT_POINT_CALL_SITE,
      state: {
        turns: `${view.turns.length} user turns since the last compaction, oldest first, numbered from 0. Each is an option.`,
        current_request: view.state.current_request,
      },
      questions: cutPointQuestions(view.turns),
      scope: this.scopeOf(agentId),
      subject: { agentId },
    });
    const answer = answersOf(outcome)?.["live_from"];
    const sentence = formatCutPoint(view.turns, answer);
    const changed = outcome.kind === "answered" && sentence !== null;
    if (changed) this.cutPoints.set(agentId, sentence);
    const wouldBe =
      sentence && answer?.type === "choice" ? `cut-at:${answer.choice}` : "default-summary";
    this.options.jev.savings.record({
      feature: "compactionTiming",
      callSite: CUT_POINT_CALL_SITE,
      callId: outcome.callId,
      agentId,
      involvement: "Which turn starts the leader's live work?",
      decision: { did: changed ? wouldBe : "default-summary", wouldBe, changed },
      facts: {
        turns: view.turns.length,
        choice: answer?.type === "choice" ? answer.choice : null,
        confidence: answer?.type === "choice" ? answer.confidence : null,
      },
    });
  }
}
