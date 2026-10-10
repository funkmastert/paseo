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
  /** Feature 14: answers a leader that has waited on Tyler past the threshold. */
  | "awayReply"
  /** Feature 15: a person's own question from the app's Ask JEV screen, over `jev.ask`. */
  | "askJev"
  /** Feature 16: whether an agent's large file read is needed, on the `reads` lane. */
  | "readCheck"
  /** Feature 17: whether a workspace's name still fits before spending a title regeneration. */
  | "titleRefresh";

/**
 * Slots, spend caps and circuits are per lane, so agent tools and file reads can neither starve
 * nor bankrupt the features that steer the daemon. `agentTools` is its own lane, a person's
 * questions from the app (`askJev`) are `interactive`, file-read checks (`readCheck`) are `reads`,
 * and every other feature is `control`.
 */
export type JevLane = "control" | "agentTools" | "interactive" | "reads";

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
  /**
   * Answer as `shadow` even when the feature is live: the answer is recorded, never acted on.
   * Feature 16 sends it for the agents outside `readCheck.liveShare`, its control arm, and for
   * reads too small to hold. It can only make a call shadow, never live.
   */
  shadow?: true;
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
  /**
   * Shadow or live, from the outcome. `applied: false` is not shadow: a live answer that kept
   * today's behaviour is not applied either. Absent from notes written before the savings track.
   */
  mode?: JevSavingsMode;
  /** `JevSavingsDecision.wouldBe`, so the per-agent list stops parsing `action`. */
  wouldBe?: string | null;
  /** The savings record for the same involvement, when there is one. */
  savingsId?: string;
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
  /** True when `provider` was read off the key's prefix rather than `agents.jev.provider`. */
  providerInferred: boolean;
  model: string;
  features: Record<JevFeatureId, JevFeatureStatus>;
  lanes: Record<JevLane, JevLaneStatus>;
  /** Read by the account-pool plugin on its 60-second poll. */
  spawnHint: { applyHard: boolean; applyRole: boolean; auditDeclared: boolean };
  /**
   * Read by the account-pool plugin to split eligible creates into the D8 arms. `served`: this
   * daemon registers the JEV agent tools for agents labelled `on`.
   */
  agentTools: { assignShare: number; served: boolean };
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
  isActive(feature: JevFeatureId, options?: { callerAgentId?: string }): boolean;
  /**
   * The D7 check alone, for call sites that would otherwise read files or a timeline for an
   * excluded subject. Any error answers `excluded`.
   */
  checkScope(scope: JevEgressScope): Promise<"ok" | "excluded">;
  status(): JevStatus;
  readonly decisions: JevDecisionSink;
  /** The savings ledger (docs/jev.md, "Savings"): one record per JEV involvement. */
  readonly savings: JevSavingsSink;
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

/*
 * Savings (docs/jev.md, "Savings"). One append-only record per JEV involvement, across every
 * feature, so the JEV dashboard reads one source. Types only: the savings track implements them
 * in `jev/savings.ts`, and the read-check track implements feature 16 against them.
 */

/** Every feature that can write a savings record. Feature 16 is `readCheck` in `JevFeatureId`. */
export type JevSavingsFeature = JevFeatureId;

export type JevSavingsMode = "shadow" | "live";

/**
 * What a feature's answer buys. Only `tokens` is summed into tokens saved; the others are shown as
 * counts in their own unit, never converted into tokens.
 */
export type JevBenefitKind = "tokens" | "attention" | "time" | "none";

/**
 * The dashboard's one unit: weighted tokens (docs/token-burn.md: fresh input 1, cache write 1.25,
 * cache read 0.1, output 5) priced at Claude Opus 5.5's list price. A model move saves no tokens,
 * only price, so every token figure is scaled by its model's price against Opus 5.5.
 */
export type JevSavingsUnit = "opus-equivalent-weighted-tokens";

/** A benefit that is not tokens: finish pushes held for the digest (3b), leader minutes (14). */
export interface JevOtherBenefit {
  unit: "pushes-held" | "minutes";
  value: number;
}

/**
 * Why a feature saw something and did not ask JEV. Counted per day, never written as a record:
 * feature 16 sees every file read, and most are too small to judge.
 */
export type JevNotAskedReason =
  /** Under the feature's size floor (feature 16's `minTokens`): a skip could not pay. */
  | "below-floor"
  /** The D7 exclusion: company code is never sent. */
  | "excluded"
  /** `isActive` said no: no key, a switch off, a spent lane or an open circuit. */
  | "inactive"
  /** An image, a PDF, a notebook, or a NUL byte in the first 8 KB. */
  | "not-text"
  /** A secret-shaped name (`jev/secret-paths.ts`), a personal location or a hard link, by any name it goes by. */
  | "secret-path"
  /** Outside the agent's cwd, which the file tools refuse too. */
  | "outside-cwd"
  /** Not inside a git work tree below the home directory: only project files are ever sent. */
  | "outside-repo"
  /** A Bash line that can print more than one file's text: several files, stdin, a redirect. */
  | "compound"
  /** Too many reads already being judged, or the lane's slot or rate token did not come in time. */
  | "saturated"
  /** The CLI answered `file_unchanged`: the read loaded nothing. */
  | "dedup"
  /** Judged for the same agent, path and range in the last 30 minutes; the verdict is reused. */
  | "repeat"
  /**
   * The file changed between the path checks and the read, or a `Read`'s text is not what is on
   * disk under the path the checks saw: what would be sent is not what was checked.
   */
  | "changed"
  /**
   * The `named` rule (R2): the reader's own brief or task, the current turn's latest prompt, or
   * recent assistant text already named this path or its file name. Deterministic, free, and
   * never asked.
   */
  | "named";

export interface JevSavingsDecision {
  /** What code did, in the feature's words: `start-agent`, `alert`, `class standard on claude-sonnet-5`. */
  did: string;
  /** What the answer maps to with every switch on, in either mode. Null when no usable answer came. */
  wouldBe: string | null;
  /** `did` differs from today's behaviour. Only a live answer can make it true. */
  changed: boolean;
  /** The facts the feature's formula reads (see `JevSavingsInput.facts`), echoed for the reader. */
  detail?: Record<string, string | number | boolean | null>;
}

/** How a token figure was reached, so any number on the dashboard can be recomputed by hand. */
export interface JevSavingsBasis {
  /** The feature's formula, with the names used in `inputs`: `W x (w(base) - w(did))`. */
  formula: string;
  /** Every input and constant the formula used, price weights and residency included. */
  inputs: Record<string, number | string | null>;
}

/**
 * Whether later events showed the answer right. `false-skip`: in shadow, the agent used what JEV
 * said it did not need. `regret`: in live, the agent fetched it anyway after the skip.
 * `contradicted`: an outcome went the other way (the fixer fixed it; Tyler answered at once).
 */
export interface JevSavingsValidation {
  outcome: "held" | "false-skip" | "regret" | "contradicted";
  /** What showed it: `edited`, `reread`, `quoted`, `fixed`, `messaged-within-30m`, `same-choice`. */
  signal: string | null;
  afterMinutes: number | null;
}

/** The first line for an id in `$PASEO_HOME/jev/savings.jsonl`. */
export interface JevSavingsRecord {
  v: 1;
  type: "involvement";
  /** `sv_` plus a time-ordered random id. */
  id: string;
  /** ISO. */
  at: string;
  feature: JevSavingsFeature;
  callSite: string;
  /** Joins the ledger and the audit. */
  callId: string;
  agentId: string | null;
  workspaceId: string | null;
  /** From the call's outcome: `shadow` is shadow, `answered` is live. Never inferred from `applied`. */
  mode: JevSavingsMode;
  outcome: JevOutcome["kind"];
  /** What JEV was asked, in a few words: "Does this agent need src/foo.ts?". */
  involvement: string;
  decision: JevSavingsDecision;
  benefit: JevBenefitKind;
  /** Opus-equivalent weighted tokens; null while pending, and always for a non-token benefit. */
  tokensSavedEstimate: number | null;
  otherBenefit: JevOtherBenefit | null;
  basis: JevSavingsBasis | null;
  /** Waits on a later fact: a child's spend, an episode's close, a validation window. */
  pending: boolean;
  /** The ledger's cost for `callId`; null when nothing was sent. */
  jevCostUsd: number | null;
}

/** A later line for the same id: the pending figure, now known. The newest settlement wins. */
export interface JevSavingsSettlement {
  v: 1;
  type: "settled";
  id: string;
  at: string;
  tokensSavedEstimate: number | null;
  otherBenefit: JevOtherBenefit | null;
  basis: JevSavingsBasis | null;
  /** The facts this settlement added, so a restart reprices from the same inputs. */
  facts?: Record<string, string | number | boolean | null>;
  /** Still waiting on another fact after this one. Absent: no longer pending. */
  pending?: boolean;
}

/** A later line for the same id: what the validation window saw. At most one per id. */
export interface JevSavingsValidationLine {
  v: 1;
  type: "validated";
  id: string;
  at: string;
  validation: JevSavingsValidation;
}

export type JevSavingsLine = JevSavingsRecord | JevSavingsSettlement | JevSavingsValidationLine;

/**
 * What a call site reports. Call sites report facts; the savings module prices them with the
 * feature's formula (docs/jev.md, "Formulas"), so no feature computes tokens saved itself.
 */
export interface JevSavingsInput {
  feature: JevSavingsFeature;
  callSite: string;
  callId: string;
  agentId?: string | null;
  workspaceId?: string | null;
  involvement: string;
  decision: JevSavingsDecision;
  /** The formula's inputs the call site knows now: `contextTokens`, `model`, `agentTotalTokens`. */
  facts: Record<string, string | number | boolean | null>;
  /** True when a fact arrives later through `settle`. */
  pending?: boolean;
}

/** `JevService.savings`. Every method appends off the caller's path and never throws. */
export interface JevSavingsSink {
  /**
   * Appends an involvement and returns its id. `mode`, `outcome`, `at` and `jevCostUsd` come from
   * the ledger entry for `callId`, so no call site can disagree with the ledger about them.
   */
  record(input: JevSavingsInput): string;
  /** Adds facts that arrived later and prices the record again. */
  settle(id: string, facts: Record<string, string | number | boolean | null>): void;
  validate(id: string, validation: JevSavingsValidation): void;
  countNotAsked(feature: JevSavingsFeature, reason: JevNotAskedReason): void;
  /**
   * Feature 16's observer reports every file read it sees, judged or not, so the savings module can
   * find regret reads after the agent tools (features 4 and 5) without a transcript.
   */
  noteRead(event: JevFileReadEvent): void;
}

/** One file read an agent made, as feature 16's observer saw it. */
export interface JevFileReadEvent {
  agentId: string;
  /** Real path. */
  path: string;
  tool: "Read" | "Bash";
  /** ISO. */
  at: string;
  /** Estimated from what the tool returned; null when the result never arrived. */
  contextTokens: number | null;
}

/** `today` is the daemon's local day; `all` is the rollup's whole retention, 400 days. */
export type JevSavingsRange = "today" | "7d" | "all";

export type JevFeatureState = "off" | "shadow" | "live" | "dormant";

export interface JevSavingsModeTotals {
  involvements: number;
  /** Live: answers that changed what code did. Shadow: answers that would have. */
  changed: number;
  tokens: number;
  /**
   * The part of `tokens` that is an estimate (a skipped agent priced at its kind's median), for the
   * dashboard to label "estimated", not "saved". Absent from an older daemon.
   */
  estimatedTokens?: number;
  otherBenefit: JevOtherBenefit | null;
  /** Involvements whose figure is still pending. */
  pending: number;
}

export interface JevSavingsFeatureSummary {
  feature: JevSavingsFeature;
  state: JevFeatureState;
  benefit: JevBenefitKind;
  asked: number;
  notAsked: Partial<Record<JevNotAskedReason, number>>;
  live: JevSavingsModeTotals;
  shadow: JevSavingsModeTotals;
  validation: { checked: number; held: number; wrong: number };
  jevUsd: number;
  /**
   * The evidence for flipping the feature's mode, against its pre-registered rule in code. `met`
   * is null until the rule's minimum count is reached. Code reports; Tyler flips (D6).
   */
  evidence: { rule: string; observed: string; met: boolean | null };
}

export interface JevSavingsTopEntry {
  /** An agent id or a workspace id. */
  id: string;
  label: string | null;
  involvements: number;
  liveTokens: number;
  shadowTokens: number;
}

export interface JevSavingsDay {
  /** The daemon's local calendar day, `YYYY-MM-DD`. */
  day: string;
  involvements: number;
  liveTokens: number;
  shadowTokens: number;
  jevUsd: number;
}

/** `jev.savings.summary`. */
export interface JevSavingsSummary {
  range: JevSavingsRange;
  /** ISO bounds of the range. */
  from: string;
  to: string;
  unit: JevSavingsUnit;
  live: { involvements: number; tokensSaved: number };
  shadow: { involvements: number; tokensWouldSave: number };
  /** Every lane's spend in the range, shadow calls included, from the ledger's daily totals. */
  jevSpend: { calls: number; usd: number; tokensEquivalent: number };
  /** `live.tokensSaved - jevSpend.tokensEquivalent`, and the same had every shadow answer applied. */
  net: { live: number; ifLive: number };
  features: JevSavingsFeatureSummary[];
  /** At most 10 each. For `all`, from the per-day rollup; the rest are summed into no entry. */
  topAgents: JevSavingsTopEntry[];
  topWorkspaces: JevSavingsTopEntry[];
  days: JevSavingsDay[];
}

/** `jev.savings.events`: one row per involvement, newest first, with its later lines folded in. */
export interface JevSavingsEvent {
  id: string;
  at: string;
  feature: JevSavingsFeature;
  agentId: string | null;
  /** Read at request time; null for an agent the daemon no longer holds. */
  agentTitle: string | null;
  workspaceId: string | null;
  mode: JevSavingsMode;
  outcome: JevOutcome["kind"];
  involvement: string;
  decision: JevSavingsDecision;
  benefit: JevBenefitKind;
  tokensSavedEstimate: number | null;
  otherBenefit: JevOtherBenefit | null;
  basis: JevSavingsBasis | null;
  pending: boolean;
  /** The figure is an estimate, not measured tokens. Absent from an older daemon. */
  estimated?: boolean;
  validation: JevSavingsValidation | null;
  jevCostUsd: number | null;
}

export interface JevSavingsEventsQuery {
  range: JevSavingsRange;
  feature?: JevSavingsFeature;
  agentId?: string;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** Default 50, at most 200. */
  limit?: number;
  /**
   * Only records in these workspaces; a record with no workspace is left out too. Absent for a
   * caller whose grant covers the daemon (docs/permissions.md, "Resources").
   */
  workspaceIds?: readonly string[];
}

export interface JevSavingsEventsPage {
  events: JevSavingsEvent[];
  nextCursor: string | null;
}

/** What the session calls for the two RPCs. The savings track implements it. */
export interface JevSavingsReader {
  summary(range: JevSavingsRange): JevSavingsSummary;
  events(query: JevSavingsEventsQuery): JevSavingsEventsPage;
}
