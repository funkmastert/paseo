/**
 * The JEV contract every track builds against (docs/jev.md). Types only: the foundation track
 * implements them in this directory, and no other track redefines them.
 *
 * The wire types (`JevState` through `JevWireResponse`) are adapted from
 * disler/ten-levels-of-jev, apps/ten-levels/src/core/types.ts, MIT License,
 * Copyright (c) 2026 IndyDevDan / AgenticEngineer.com.
 */

/** What JEV evaluates. A string, an object with named fields, or an array. Text only. */
export type JevState = string | { [key: string]: unknown } | unknown[];

/** A question in plain text, or an object that puts the question in one field and data in others. */
export type JevInstructions = string | { [key: string]: unknown };

export interface JevNoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevInstructions;
  /** Option key to description, at most 255 keys. Always include an `other` or `none` exit. */
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: JevInstructions;
  /** 2 to 10 level descriptions, lowest first. Describe situations, not degrees. */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** Question ids are for code. JEV never sees them, so instructions name state fields instead. */
export type JevQuestions = Record<string, JevQuestion>;

export interface JevNoulAnswer {
  type: "noul";
  /** Probability of yes, 0 to 1. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  /** Always one of the declared keys. */
  choice: string;
  /** Every declared key; sums to 1 within 0.025. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevScoreAnswer {
  type: "score";
  /** Probability-weighted position, 0 to levels - 1. */
  score: number;
  /** Level index as a string to the declared description. */
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevWireRequest {
  model: string;
  state: JevState;
  questions: JevQuestions;
}

export interface JevWireResponse {
  /** The versioned model that answered. Recorded on every ledger entry. */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: unknown };
}

/** One per call site that may reach JEV. Each has its own switch under `agents.jev`. */
export type JevFeatureId =
  | "spawnHint"
  | "remediationTriage"
  | "notificationTriage"
  | "agentTools"
  | "compactionTiming"
  | "stallJudgment";

export interface JevSubject {
  /** The agent the decision is about. Absent for a spawn hint: the agent does not exist yet. */
  agentId?: string;
  callerAgentId?: string;
}

export interface JevDecideInput {
  feature: JevFeatureId;
  /** Names the code path in the ledger and audit, e.g. `classifier.spawn-hint`, `tools.ask_jev_files`. */
  callSite: string;
  state: JevState;
  questions: JevQuestions;
  subject?: JevSubject;
  /** Clamped to `agents.jev.<feature>.timeoutMs`. Covers every retry. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

export type JevCost =
  | { usd: number; source: "reported" | "estimated" | "fake" }
  | { usd: null; source: "unknown" };

export interface JevCallMeta {
  model: string;
  elapsedMs: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  /** UTF-8 bytes of the state after redaction: what left the machine. */
  stateBytes: number;
  cost: JevCost;
}

/** Nothing was sent. The call site runs today's behaviour. */
export type JevUnavailableReason =
  | "no-key"
  | "disabled"
  | "feature-disabled"
  | "daily-budget"
  | "agent-budget"
  | "key-rejected"
  | "circuit-open";

/** Something was sent and no usable answer came back. The call site runs today's behaviour. */
export type JevFailureReason =
  | "timeout"
  | "aborted"
  | "http"
  | "network"
  | "contract"
  | "state-too-large"
  | "invalid-request";

/**
 * `decide` never rejects. Only `answered` may change behaviour. `shadow` carries real answers
 * that the call site records as "would have" and does not act on, so a call site that handles
 * only `answered` gets shadow mode right by construction.
 */
export type JevOutcome =
  | { kind: "answered"; callId: string; answers: Record<string, JevAnswer>; meta: JevCallMeta }
  | { kind: "shadow"; callId: string; answers: Record<string, JevAnswer>; meta: JevCallMeta }
  | { kind: "unavailable"; callId: string; reason: JevUnavailableReason }
  | { kind: "failed"; callId: string; reason: JevFailureReason; meta: JevCallMeta | null };

/** A decision worth showing in an agent's timeline (feature 11). */
export interface JevDecisionNote {
  agentId: string;
  callId: string;
  feature: JevFeatureId;
  /** A short label for what was asked, e.g. "Does this finish need Tyler?". */
  question: string;
  /** What JEV answered, e.g. "routine (0.91)". */
  verdict: string;
  confidence: number | null;
  /** What code did with it, e.g. "sent as a digest notice instead of an alert". */
  action: string;
  /** False in shadow mode: the action was only recorded. */
  applied: boolean;
}

/** The foundation ships a ledger-only sink; the ui track replaces it with timeline rows. */
export interface JevDecisionSink {
  record(note: JevDecisionNote): void;
}

export interface JevFeatureStatus {
  enabled: boolean;
  shadow: boolean;
}

export interface JevSpendTotals {
  calls: number;
  answered: number;
  failed: number;
  unavailable: number;
  inputTokens: number;
  usd: number;
  usdSource: "reported" | "estimated" | "mixed" | "none";
}

export interface JevStatus {
  available: boolean;
  /** Null when available. */
  reason: JevUnavailableReason | null;
  provider: "openrouter" | "typesafe" | "fake";
  model: string;
  features: Record<JevFeatureId, JevFeatureStatus>;
  today: JevSpendTotals;
  todayByFeature: Record<JevFeatureId, JevSpendTotals>;
  last7Days: JevDaySpend[];
}

export interface JevDaySpend {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  calls: number;
  usd: number;
}

export interface JevService {
  decide(input: JevDecideInput): Promise<JevOutcome>;
  /**
   * Cheap and synchronous: whether a call for `feature` would be sent right now. Call sites use it
   * to skip building state (reading files, a timeline tail) when the answer would be `unavailable`.
   */
  isActive(feature: JevFeatureId): boolean;
  status(): JevStatus;
  readonly decisions: JevDecisionSink;
}

export interface JevTransportResponse {
  status: number;
  /** From `Retry-After`, when the response carried a usable one. */
  retryAfterMs: number | null;
  /** Parsed JSON, or null when the body was not JSON. Never logged. */
  body: unknown;
}

/** One HTTP attempt. The service owns retries, deadlines, validation and the ledger. */
export interface JevTransport {
  readonly provider: "openrouter" | "typesafe" | "fake";
  send(request: JevWireRequest, options: { signal: AbortSignal }): Promise<JevTransportResponse>;
}

/**
 * How `ask_jev` asks the catastrophe gate (feature 1) whether its `command` may run. The tools
 * track codes against this; bootstrap adapts the gate's real export to it.
 */
export interface CommandGateVerdict {
  allowed: boolean;
  /** Set when refused: the rule that matched, in words the agent can read. */
  reason: string | null;
}

export type CommandGate = (input: { command: string; cwd: string }) => CommandGateVerdict;
