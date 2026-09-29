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
  | "stallJudgment"
  /** Feature 15: a person's own question from the app's Ask JEV screen, over `jev.ask`. */
  | "askJev";

/**
 * Slots, spend caps and circuits are per lane, so agent tools can neither starve nor bankrupt
 * the features that steer the daemon. `agentTools` is its own lane, a person's questions from the
 * app (`askJev`) are `interactive`, and every other feature is `control`.
 */
export type JevLane = "control" | "agentTools" | "interactive";

/**
 * What a call's state is about, for the D7 exclusion (docs/jev.md, "The D7 exclusion"). Required
 * on every call: the service resolves every path, the agents' cwds and their git signals, and
 * sends nothing when any of them is under an excluded root or remote.
 */
export interface JevEgressScope {
  /** Working directories whose content feeds the state. */
  cwds: string[];
  /** Files whose content or diff is in the state. Relative paths resolve against `baseCwd`. */
  files?: string[];
  /** An agent's recorded cwd, never `process.cwd()`. A relative file with no `baseCwd` is excluded. */
  baseCwd?: string;
  /**
   * Agents whose prompt, conversation or timeline is in the state. The service adds their cwds,
   * every ancestor's cwd, and every descendant's cwd (live, or archived in the last 24 h). An id
   * the daemon has no record of excludes the call: its cwd cannot be checked.
   */
  agentIds?: string[];
  /**
   * The caller could not name what the state is about, e.g. a `jev.decide` RPC that carried no
   * scope. The call is excluded and the ledger records it.
   */
  missing?: true;
}

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
  /** Required. `decide` checks it itself and never trusts an earlier `checkScope` by the caller. */
  scope: JevEgressScope;
  /** Ledger and audit attribution. Not used for the exclusion: that is `scope`. */
  subject?: JevSubject;
  /** Clamped to `agents.jev.<feature>.timeoutMs`. Covers the queue, every retry and the body. */
  deadlineMs?: number;
  signal?: AbortSignal;
  /**
   * `agentTools` only: the id of the tool call this JEV call belongs to, so
   * `agentTools.maxConcurrentPerCall` (2) bounds one `ask_jev_files` while other agents' calls
   * use the lane's remaining slots. Absent: the call is its own group.
   */
  callGroup?: string;
}

/**
 * How `agentTools` states are shaped, so the audit keeps paths and hashes, never file content
 * (docs/jev.md, "Audit"): a single-file tool's content is `state.content`; a multi-file state's
 * contents are the values of `state.files`, keyed by path. The audit replaces each with
 * `{ sha256, bytes }` and keeps every other field like a `control` state.
 */
export const JEV_AGENT_TOOLS_CONTENT_FIELDS = { single: "content", multi: "files" } as const;

export type JevCost =
  | { usd: number; source: "reported" | "estimated" | "fake" }
  | { usd: null; source: "unknown" };

export interface JevCallMeta {
  model: string;
  elapsedMs: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  /** UTF-8 bytes of the state after redaction. */
  stateBytes: number;
  /** UTF-8 bytes of the whole serialized body after redaction: what left the machine. */
  bodyBytes: number;
  /** How many values redaction replaced. `ask_jev` reports it to the agent. */
  redactions: number;
  cost: JevCost;
}

/** Nothing was sent. The call site runs today's behaviour. */
export type JevUnavailableReason =
  | "no-key"
  | "disabled"
  | "feature-disabled"
  /** The lane's daily cap, or the call's estimate would pass it. Resets at local midnight. */
  | "daily-budget"
  /** `agentTools.maxUsdPerAgentPerHour`. */
  | "agent-budget"
  | "key-rejected"
  /** The lane's circuit is open. */
  | "circuit-open"
  /** The deadline passed while waiting for a lane slot or a rate token. Never counts toward a circuit. */
  | "saturated"
  /** The D7 exclusion matched, or resolving the scope or the text scan threw. */
  | "excluded"
  /** `config.json` could not be read. */
  | "config-unreadable";

/**
 * No usable answer. `redaction`, `invalid-request`, `state-too-large` and `request-too-large`
 * stop before sending; the rest were sent. The call site runs today's behaviour.
 */
export type JevFailureReason =
  | "timeout"
  | "aborted"
  | "http"
  | "network"
  | "contract"
  | "state-too-large"
  | "request-too-large"
  | "invalid-request"
  /** Redaction or a size check threw. Nothing was sent and nothing audited. */
  | "redaction";

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

/** A decision worth showing for an agent (feature 11). Never a timeline row. */
export interface JevDecisionNote {
  /**
   * The agent it is about. Null for a spawn hint, recorded before the agent exists;
   * `jev.decisions.list` attaches it through the agent's `paseo.jev-call` label.
   */
  agentId: string | null;
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

/** What `jev.decisions.list` returns per decision. */
export interface JevDecisionRecord extends JevDecisionNote {
  /** ISO time the decision was recorded. */
  at: string;
  costUsd: number | null;
}

/** The foundation's in-memory store (`decisions.ts`). Feature tracks only call `record`. */
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

export interface JevLaneStatus {
  today: JevSpendTotals;
  maxUsdPerDay: number;
  /** True once today's spend reached the cap. */
  exhausted: boolean;
  circuit: "closed" | "open" | "half-open";
  /** ISO time of the next local midnight, when the cap resets. */
  resetsAt: string;
}

export interface JevStatus {
  available: boolean;
  /** Null when available. */
  reason: JevUnavailableReason | null;
  /** Whether a key is present. Never the value, a prefix, the last characters or a hash. */
  keyPresent: boolean;
  provider: "openrouter" | "typesafe" | "fake";
  model: string;
  features: Record<JevFeatureId, JevFeatureStatus>;
  lanes: Record<JevLane, JevLaneStatus>;
  /** Read by the account-pool plugin on its 60-second poll. */
  spawnHint: { applyHard: boolean; applyRole: boolean };
  /** Read by the account-pool plugin to split eligible creates into the D8 arms. */
  agentTools: { assignShare: number };
  todayByFeature: Record<JevFeatureId, JevSpendTotals>;
  last7Days: JevDaySpend[];
}

export interface JevDaySpend {
  /** The daemon's local calendar day, `YYYY-MM-DD`. */
  day: string;
  calls: number;
  usd: number;
}

export interface JevService {
  decide(input: JevDecideInput): Promise<JevOutcome>;
  /**
   * Cheap and synchronous: whether a call for `feature` could be sent right now (key, switches,
   * the lane's budget and circuit). Call sites use it to skip building state when the answer would
   * be `unavailable`.
   */
  isActive(feature: JevFeatureId): boolean;
  /**
   * The D7 check alone, for call sites that would otherwise read files or a timeline for an
   * excluded subject. Any error answers `excluded`.
   */
  checkScope(scope: JevEgressScope): Promise<"ok" | "excluded">;
  status(): JevStatus;
  readonly decisions: JevDecisionSink;
  /** The agent's decisions, newest first, including its spawn hint. Serves `jev.decisions.list`. */
  listDecisions(agentId: string): JevDecisionRecord[];
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
 * track codes against this; bootstrap adapts `checkCatastrophe(command, cwd,
 * resolveCurrentBranchWithGit)` and `formatCatastropheDenial` from `agent/catastrophe-gate.ts` to
 * it, honouring `agents.catastropheGate.enabled` as the Bash hook does.
 */
export interface CommandGateVerdict {
  allowed: boolean;
  /** Set when refused: the rule that matched, in words the agent can read. */
  reason: string | null;
}

/**
 * Async, like the gate: a force push that names no ref asks git which branch is checked out.
 * A throw or rejection means refused. `ask_jev` never calls it on Windows, where it refuses
 * `command` outright: the gate reads POSIX shell and resolves only POSIX cwds.
 */
export type CommandGate = (input: { command: string; cwd: string }) => Promise<CommandGateVerdict>;
