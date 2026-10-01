import type { NotifyAvailabilityMode } from "@getpaseo/protocol/notify-policy/types";
import type { Logger } from "pino";

import type { AgentManager, AgentOperatorSignal } from "./agent/agent-manager.js";
import { confidentChoice } from "./jev/answers.js";
import type {
  JevDecisionNote,
  JevOutcome,
  JevQuestions,
  JevSavingsSink,
  JevService,
} from "./jev/contract.js";
import type { JsonlAppender } from "./jsonl-appender.js";
import { recordFinishSavings, validateFinishFollowup } from "./jev/savings-hooks.js";
import { levelAtLeast, type NotifyLevel } from "./notify-policy/levels.js";

/**
 * Feature 3b, finish triage (docs/jev.md). A root agent's finish pushes an `alert`; JEV reads the
 * final message and can move a routine one to a `notice`, which the notify policy holds for the
 * digest. It only ever lowers an `alert` to a `notice`, never drops or raises a push, and never
 * sees a permission, an error or a delegated child's finish. In shadow it changes nothing and the
 * push is not delayed. While Tyler is away or off it asks nothing: a notice would be held for
 * hours, long enough for the away auto-reply (feature 14) to answer the finish first.
 */

export const FINISH_TRIAGE_CALL_SITE = "attention.finish-triage";
export const ROUTINE_FLOOR = 0.85;
export const FINAL_MESSAGE_CHARS = 4000;
/** The veto words are read from this much of the message's end; a question mark from all of it. */
export const VETO_TAIL_CHARS = 1_500;
/** The push step's own bound, past the service's 3-second deadline: a hung triage still sends. */
export const FINISH_TRIAGE_HARD_TIMEOUT_MS = 5_000;
/** How long after a triaged finish a message from Tyler counts as him needing it. */
export const FOLLOWUP_WINDOW_MS = 2 * 60 * 60_000;
export const FINISH_TRIAGE_FILE_MAX_BYTES = 2_000_000;

export const FINISH_TRIAGE_QUESTIONS: JevQuestions = {
  needs_person: {
    type: "choice",
    instructions:
      "`final_message` is the last thing an agent said before it stopped. What does it need from the person who started it?",
    criteria: {
      answer_or_decision:
        "It asks a question, asks for approval, offers options to choose from, or says it is waiting for input",
      failure:
        "It says it could not finish, hit an error or a limit, or left something broken or half done",
      result_to_review:
        "It finished and hands over something to look at: a pull request, a report, a design, an answer to the question it was given",
      routine:
        "Nothing to look at: an acknowledgement, a status line, a cleanup or bookkeeping step that went as expected",
      other: "None of these",
    },
  },
};

/**
 * Words in the message's tail that keep the alert without asking, matched anywhere in a word:
 * `fail` also catches `failed`. The doc's list, plus the ways an agent asks without a question mark.
 */
const VETO_WORDS = [
  "error",
  "fail",
  "couldn't",
  "cannot",
  "can't",
  "unable",
  "blocked",
  "limit",
  "denied",
  "revert",
  "approve",
  "approval",
  "confirm",
  "permission",
  "should i",
  "shall i",
  "do you want",
  "would you like",
  "let me know",
  "waiting for",
  "waiting on",
  "your call",
  "decide",
  "decision",
];

/**
 * Whole words and phrases, matched only at word boundaries so `pick` does not catch `picked`.
 * They are the adversarial review's 20 ways of asking (finding 4, the fixture in the test file):
 * offers, handoffs, sign-in and credential asks, stalls, and a message talking to the triage.
 */
const VETO_PHRASES = [
  // Offers and asks for a choice.
  "want me to",
  "tell me",
  "pick one",
  "pick",
  "choose",
  "which option",
  "reply",
  "say the word",
  "ping me",
  "advise",
  "prefer",
  // Handing the next step to him.
  "over to you",
  "awaiting",
  "i'll wait",
  "until you",
  "unless you",
  "need you",
  "needs your",
  "your input",
  "your review",
  "go-ahead",
  "sign-off",
  "sign off",
  // Something only a person can do.
  "sign in",
  "log in",
  "re-auth",
  "reauth",
  "credentials",
  "expired",
  "rejected",
  // It stopped short.
  "blocker",
  "timed out",
  "stuck",
  "paused",
  "won't",
  "hold on",
  // A message addressed to whatever triages it.
  "triage",
  "needs no attention",
  "no attention",
  "ignore previous",
  "ignore your",
];

const PULL_REQUEST_OR_ISSUE_URL = /https?:\/\/\S+\/(?:pulls?|issues|merge_requests)\/\d+/i;
/** A pull request or issue named without a URL: `PR #4712`, `PR 4712`, `#4712`. */
const PULL_REQUEST_OR_ISSUE_REF = /\bPR\s*#?\d+\b|(?:^|[^\w&])#\d{3,}\b/i;
const URL = /https?:\/\/\S+/gi;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const WORD_CHAR = /[a-z0-9]/;

/**
 * One spelling for what the vetoes read: curly and prime apostrophes as `'`, and the full-width
 * question mark (and the rest of the full-width forms) folded by NFKC.
 */
function normalizeForVeto(text: string): string {
  return text.normalize("NFKC").replace(/[\u2018\u2019\u201B\u2032\u02BC\uFF07]/g, "'");
}

function containsPhrase(lower: string, phrase: string): boolean {
  let from = 0;
  for (;;) {
    const at = lower.indexOf(phrase, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : lower[at - 1]!;
    const after = lower[at + phrase.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

export interface FinishFacts {
  title: string | null;
  lastToolCallFailed: boolean;
  /** A child still owes this agent a finish report (docs/finish-reports.md). */
  owesChildReport: boolean;
  pendingPermissionCount: number;
}

/**
 * Why the alert is kept without a call, or null when JEV may be asked. A backstop, not the guard:
 * it catches the plain ways of asking, and JEV's `routine` floor decides the rest.
 */
export function findFinishVeto(finalMessage: string | null, facts: FinishFacts): string | null {
  const text = normalizeForVeto(finalMessage?.trim() ?? "");
  if (text.length === 0) return "empty-message";
  if (facts.pendingPermissionCount > 0) return "pending-permission";
  if (facts.lastToolCallFailed) return "last-tool-call-failed";
  if (facts.owesChildReport) return "child-report-owed";
  // A question anywhere counts; a `?` in a URL's query or in code is not one.
  if (text.replace(CODE, " ").replace(URL, " ").includes("?")) return "question-mark";
  const tail = text.slice(-VETO_TAIL_CHARS);
  if (PULL_REQUEST_OR_ISSUE_URL.test(tail)) return "pull-request-or-issue-url";
  if (PULL_REQUEST_OR_ISSUE_REF.test(tail.replace(URL, " "))) return "pull-request-or-issue-ref";
  const lower = tail.toLowerCase();
  const word =
    VETO_WORDS.find((candidate) => lower.includes(candidate)) ??
    VETO_PHRASES.find((candidate) => containsPhrase(lower, candidate));
  return word ? `word:${word}` : null;
}

/** Availability modes that hold a notice for hours: a finish is never lowered in these. */
const HOLDING_AVAILABILITY: ReadonlySet<NotifyAvailabilityMode> = new Set(["away", "off"]);

export function buildFinishTriageState(input: { title: string | null; finalMessage: string }) {
  return {
    title: input.title ?? "",
    final_message: input.finalMessage.slice(-FINAL_MESSAGE_CHARS),
  };
}

/**
 * The level the finish push goes out at. Only an answered `routine` at or over the floor lowers
 * an `alert`, and only to a `notice` the notify policy will still post (`postFloor` is its
 * `minPostLevel`): a notice under the floor would be logged, not delivered.
 */
export function finishedPushLevel(
  base: NotifyLevel,
  outcome: JevOutcome,
  postFloor: NotifyLevel,
): NotifyLevel {
  if (base !== "alert" || !levelAtLeast("notice", postFloor)) return base;
  return confidentChoice(outcome, "needs_person", ROUTINE_FLOOR) === "routine" ? "notice" : base;
}

/** What a shadow answer would have sent, for the record. */
function wouldBeLevel(base: NotifyLevel, outcome: JevOutcome, postFloor: NotifyLevel): NotifyLevel {
  if (outcome.kind !== "shadow") return finishedPushLevel(base, outcome, postFloor);
  return finishedPushLevel(base, { ...outcome, kind: "answered" }, postFloor);
}

function readChoice(outcome: JevOutcome): { choice: string | null; confidence: number | null } {
  if (outcome.kind !== "answered" && outcome.kind !== "shadow") {
    return { choice: null, confidence: null };
  }
  const answer = outcome.answers.needs_person;
  return answer?.type === "choice"
    ? { choice: answer.choice, confidence: answer.confidence }
    : { choice: null, confidence: null };
}

/** One JSON line per root finish JEV could have judged, and one follow-up per triaged finish. */
export type FinishTriageLine =
  | {
      type: "finish";
      at: string;
      agentId: string;
      callId: string | null;
      /** `vetoed`, or the JEV outcome kind, or `error`. */
      outcome: string;
      reason: string | null;
      choice: string | null;
      confidence: number | null;
      base: NotifyLevel;
      sent: NotifyLevel;
      wouldBe: NotifyLevel;
      shadow: boolean;
    }
  | {
      type: "followup";
      at: string;
      agentId: string;
      callId: string | null;
      /** Minutes from the push to Tyler's first message to the agent; null when none was seen. */
      messagedAfterMinutes: number | null;
      /**
       * `message`: he wrote to the agent. `window`: 2 hours passed without one. `superseded`: the
       * agent finished again first, and `evicted`: the pending list overflowed; both are censored,
       * not "no message". A restart drops pending entries without a line, so a triaged finish with
       * no followup line is censored too.
       */
      closedBy: "message" | "window" | "superseded" | "evicted";
      sent: NotifyLevel;
      wouldBe: NotifyLevel;
      choice: string | null;
      confidence: number | null;
    };

interface PendingFollowup {
  agentId: string;
  callId: string | null;
  atMs: number;
  sent: NotifyLevel;
  wouldBe: NotifyLevel;
  choice: string | null;
  confidence: number | null;
}

const MAX_PENDING_FOLLOWUPS = 500;

/**
 * The "pays if" half of 3b: whether Tyler messaged a triaged agent within 2 hours of its finish
 * push, read from the operator signals an app client raises (`human-prompt`). Opening the agent
 * without writing is not visible here. Pending entries live in memory; a restart drops them.
 */
export class FinishFollowups {
  private readonly pending = new Map<string, PendingFollowup>();
  private readonly write: (line: FinishTriageLine) => void;
  private readonly now: () => number;

  constructor(options: { write: (line: FinishTriageLine) => void; now?: () => number }) {
    this.write = options.write;
    this.now = options.now ?? Date.now;
  }

  track(entry: PendingFollowup): void {
    this.sweep();
    const previous = this.pending.get(entry.agentId);
    if (previous) {
      this.pending.delete(entry.agentId);
      this.emit(previous, null, "superseded");
    }
    this.pending.set(entry.agentId, entry);
    if (this.pending.size > MAX_PENDING_FOLLOWUPS) {
      const [oldestId, oldest] = this.pending.entries().next().value ?? [];
      if (oldestId !== undefined && oldest) {
        this.pending.delete(oldestId);
        this.emit(oldest, null, "evicted");
      }
    }
  }

  onSignal(signal: AgentOperatorSignal): void {
    this.sweep();
    if (signal.kind !== "human-prompt") return;
    const entry = this.pending.get(signal.agentId);
    if (!entry) return;
    this.pending.delete(signal.agentId);
    this.emit(entry, Math.round((signal.at.getTime() - entry.atMs) / 6_000) / 10, "message");
  }

  /** Closes every entry past the window as "no message". */
  sweep(): void {
    const nowMs = this.now();
    for (const [agentId, entry] of this.pending) {
      if (nowMs - entry.atMs < FOLLOWUP_WINDOW_MS) continue;
      this.pending.delete(agentId);
      this.emit(entry, null, "window");
    }
  }

  private emit(
    entry: PendingFollowup,
    messagedAfterMinutes: number | null,
    closedBy: Extract<FinishTriageLine, { type: "followup" }>["closedBy"],
  ): void {
    this.write({
      type: "followup",
      at: new Date(this.now()).toISOString(),
      agentId: entry.agentId,
      callId: entry.callId,
      messagedAfterMinutes,
      closedBy,
      sent: entry.sent,
      wouldBe: entry.wouldBe,
      choice: entry.choice,
      confidence: entry.confidence,
    });
  }
}

export interface AttentionPushInput {
  reason: "finished" | "error" | "permission";
  /** `attentionPushLevel`: `alert` for a root's finish, `notice` for a delegated child's. */
  base: NotifyLevel;
  agentId: string;
  finalMessage: string | null;
  jev: JevService | null | undefined;
  /** Read only when a finish could be triaged. A throw keeps the alert. */
  readFacts: () => FinishFacts;
  /** The notify policy's `minPostLevel`. A throw keeps the alert. */
  readPostFloor: () => NotifyLevel;
  /** Tyler's availability mode in force. `away` or `off`, or a throw, keeps the alert. */
  readAvailability: () => NotifyAvailabilityMode;
  send: (level: NotifyLevel) => Promise<void>;
  record?: FinishTriageRecorder | null;
  logger: Logger;
  now?: () => number;
  hardTimeoutMs?: number;
}

export interface FinishTriageRecorder {
  line(line: FinishTriageLine): void;
  followups: FinishFollowups | null;
}

/**
 * Sends one attention push, exactly once, and never rejects. Every path that does not triage sends
 * before the first `await`, so the caller's in-app messages never wait on JEV. A live triage sends
 * from a `finally`. Any throw anywhere, the vetoes and the record included, sends the base level
 * if nothing was sent yet: the caller detaches this promise, and the daemon exits on an unhandled
 * rejection.
 */
export async function sendAttentionPush(input: AttentionPushInput): Promise<void> {
  let sentOnce = false;
  const send = async (level: NotifyLevel): Promise<void> => {
    if (sentOnce) return;
    sentOnce = true;
    try {
      await input.send(level);
    } catch (error) {
      input.logger.warn({ err: error, agentId: input.agentId }, "Failed to send push notification");
    }
  };
  try {
    await triageAndSend(input, send);
  } catch (error) {
    input.logger.warn(
      { err: error, agentId: input.agentId },
      "Finish triage failed; sending as is",
    );
    await send(input.base);
  }
}

async function triageAndSend(
  input: AttentionPushInput,
  send: (level: NotifyLevel) => Promise<void>,
): Promise<void> {
  const { base, jev } = input;
  const now = input.now ?? Date.now;
  if (input.reason !== "finished" || base !== "alert" || !jev) return send(base);

  let facts: FinishFacts;
  let postFloor: NotifyLevel;
  let shadow: boolean;
  let veto: string | null;
  try {
    if (!jev.isActive("notificationTriage")) return send(base);
    facts = input.readFacts();
    postFloor = input.readPostFloor();
    shadow = jev.status().features.notificationTriage.shadow;
    const availability = input.readAvailability();
    veto = HOLDING_AVAILABILITY.has(availability)
      ? `availability:${availability}`
      : findFinishVeto(input.finalMessage, facts);
  } catch {
    return send(base);
  }
  if (veto !== null || input.finalMessage === null) {
    const sending = send(base);
    recordFinish(input, {
      at: now(),
      callId: null,
      outcome: "vetoed",
      reason: veto,
      choice: null,
      confidence: null,
      sent: base,
      wouldBe: base,
      shadow,
    });
    return sending;
  }

  const finalMessage = input.finalMessage;
  const triage = triageFinish({
    jev,
    agentId: input.agentId,
    title: facts.title,
    finalMessage,
    hardTimeoutMs: input.hardTimeoutMs ?? FINISH_TRIAGE_HARD_TIMEOUT_MS,
  });

  if (shadow) {
    // Shadow never delays or changes the push; the triage only feeds the record.
    const sending = send(base);
    const outcome = await triage;
    recordTriaged(input, { outcome, base, sent: base, postFloor, shadow: true, at: now() });
    return sending;
  }

  let level: NotifyLevel = base;
  let outcome: JevOutcome | "error" = "error";
  try {
    outcome = await triage;
    if (outcome !== "error") level = finishedPushLevel(base, outcome, postFloor);
  } catch {
    level = base;
  } finally {
    await send(level);
  }
  recordTriaged(input, { outcome, base, sent: level, postFloor, shadow: false, at: now() });
}

async function triageFinish(input: {
  jev: JevService;
  agentId: string;
  title: string | null;
  finalMessage: string;
  hardTimeoutMs: number;
}): Promise<JevOutcome | "error"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const decide = input.jev.decide({
      feature: "notificationTriage",
      callSite: FINISH_TRIAGE_CALL_SITE,
      state: buildFinishTriageState({ title: input.title, finalMessage: input.finalMessage }),
      questions: FINISH_TRIAGE_QUESTIONS,
      scope: { cwds: [], agentIds: [input.agentId] },
      subject: { agentId: input.agentId },
    });
    const timeout = new Promise<"error">((resolve) => {
      timer = setTimeout(() => resolve("error"), input.hardTimeoutMs);
    });
    return await Promise.race([decide, timeout]);
  } catch {
    return "error";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recordTriaged(
  input: AttentionPushInput,
  result: {
    outcome: JevOutcome | "error";
    base: NotifyLevel;
    sent: NotifyLevel;
    postFloor: NotifyLevel;
    shadow: boolean;
    at: number;
  },
): void {
  try {
    recordTriagedUnguarded(input, result);
  } catch (error) {
    // The record never affects the push.
    input.logger.warn({ err: error, agentId: input.agentId }, "Finish triage record failed");
  }
}

function recordTriagedUnguarded(
  input: AttentionPushInput,
  result: Parameters<typeof recordTriaged>[1],
): void {
  const { outcome } = result;
  const { choice, confidence } =
    outcome === "error" ? { choice: null, confidence: null } : readChoice(outcome);
  const wouldBe =
    outcome === "error" ? result.base : wouldBeLevel(result.base, outcome, result.postFloor);
  const callId = outcome === "error" ? null : outcome.callId;
  recordFinish(input, {
    at: result.at,
    callId,
    outcome: outcome === "error" ? "error" : outcome.kind,
    reason:
      outcome !== "error" && (outcome.kind === "unavailable" || outcome.kind === "failed")
        ? outcome.reason
        : null,
    choice,
    confidence,
    sent: result.sent,
    wouldBe,
    shadow: result.shadow,
  });
  if (callId === null) return;
  // The savings ledger (docs/jev.md, "Savings"); its record never affects the push.
  const savingsId = recordFinishSavings(input.jev?.savings, {
    agentId: input.agentId,
    callId,
    base: result.base,
    sent: result.sent,
    wouldBe,
    choice,
    confidence,
    shadow: result.shadow,
  });
  try {
    input.jev?.decisions.record({
      agentId: input.agentId,
      callId,
      feature: "notificationTriage",
      question: "Does this finish need Tyler?",
      verdict:
        choice === null
          ? `${outcome === "error" ? "error" : outcome.kind}: no answer`
          : `${choice} (${confidence?.toFixed(2) ?? "?"})`,
      confidence,
      action: describeFinishAction(result.sent, wouldBe, result.base),
      applied: !result.shadow && result.sent !== result.base,
      ...noteSavingsFields(outcome, wouldBe, savingsId),
    });
    if (choice !== null) {
      input.record?.followups?.track({
        agentId: input.agentId,
        callId,
        atMs: result.at,
        sent: result.sent,
        wouldBe,
        choice,
        confidence,
      });
    }
  } catch {
    // The record never affects the push.
  }
}

/** The decision note's `mode`, `wouldBe` and `savingsId` (docs/jev.md, "Decision store"). */
function noteSavingsFields(
  outcome: JevOutcome | "error",
  wouldBe: NotifyLevel,
  savingsId: string,
): Pick<JevDecisionNote, "mode" | "wouldBe" | "savingsId"> {
  const answered =
    outcome !== "error" && (outcome.kind === "answered" || outcome.kind === "shadow");
  return {
    ...(answered ? { mode: outcome.kind === "shadow" ? "shadow" : "live" } : {}),
    wouldBe,
    ...(savingsId ? { savingsId } : {}),
  };
}

function recordFinish(
  input: AttentionPushInput,
  line: Omit<Extract<FinishTriageLine, { type: "finish" }>, "type" | "at" | "agentId" | "base"> & {
    at: number;
  },
): void {
  try {
    const full: FinishTriageLine = {
      ...line,
      type: "finish",
      at: new Date(line.at).toISOString(),
      agentId: input.agentId,
      base: input.base,
    };
    input.logger.info({ finishTriage: full }, "finish-triage");
    input.record?.line(full);
  } catch {
    // The record never affects the push.
  }
}

function describeFinishAction(sent: NotifyLevel, wouldBe: NotifyLevel, base: NotifyLevel): string {
  if (sent !== base) return `sent as a digest ${sent} instead of an ${base}`;
  if (wouldBe !== base) return `sent as an ${base}; would have sent a ${wouldBe} (shadow)`;
  return `sent as an ${base}`;
}

/** The daemon's facts for the vetoes: the last tool call's status and any owed child report. */
export function readFinishFacts(
  agentManager: Pick<AgentManager, "getAgent" | "fetchTimeline" | "listAgents">,
  agentId: string,
): FinishFacts {
  const agent = agentManager.getAgent(agentId);
  if (!agent) throw new Error(`agent ${agentId} is not loaded`);
  const rows = agentManager.fetchTimeline(agentId, { direction: "tail", limit: 50 }).rows;
  let lastToolCallFailed = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]!.item;
    if (item.type !== "tool_call") continue;
    lastToolCallFailed = item.status === "failed";
    break;
  }
  return {
    title: agent.config.title ?? null,
    lastToolCallFailed,
    owesChildReport: agentManager
      .listAgents()
      .some((candidate) => candidate.owedFinishReport?.ownerAgentId === agentId),
    pendingPermissionCount: agent.pendingPermissions.size,
  };
}

const recorders = new WeakMap<object, FinishTriageRecorder>();

/**
 * One recorder per agent manager, subscribed to its operator signals once. Keyed by the manager
 * so the WebSocket server needs no field of its own for it.
 */
export function finishTriageRecorderFor(input: {
  agentManager: Pick<AgentManager, "subscribeOperatorSignals">;
  file: () => JsonlAppender;
  /** The savings ledger validates a would-be or held notice from its follow-up line. */
  savings?: JevSavingsSink | null;
}): FinishTriageRecorder {
  const existing = recorders.get(input.agentManager);
  if (existing) return existing;
  const file = input.file();
  const line = (entry: FinishTriageLine): void => {
    file.append({ v: 1, ...entry });
    validateFinishFollowup(input.savings, entry);
  };
  const followups = new FinishFollowups({ write: line });
  if (typeof input.agentManager.subscribeOperatorSignals === "function") {
    input.agentManager.subscribeOperatorSignals((signal) => followups.onSignal(signal));
  }
  const recorder: FinishTriageRecorder = { line, followups };
  recorders.set(input.agentManager, recorder);
  return recorder;
}
