import { z } from "zod";

// The wire shapes for JEV (docs/jev.md, "RPCs"), following `agent.context_usage.read`
// (packages/protocol/src/context-usage/rpc-schemas.ts). Outcome, reason and feature travel as
// plain strings with the known values listed in a comment, so a new one never narrows the schema.
// Question and answer schemas mirror `packages/server/src/server/jev/contract.ts`'s
// `JevQuestion`/`JevAnswer` discriminated unions; counts (question limits, criteria lengths) are
// validated by the daemon, not the schema.

export const JevInstructionsSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

export const JevNoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: JevInstructionsSchema,
  criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).optional(),
});

export const JevChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: JevInstructionsSchema,
  criteria: z.record(z.string(), z.string().nullable()),
});

export const JevScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: JevInstructionsSchema,
  criteria: z.array(z.string()),
});

export const JevQuestionSchema = z.discriminatedUnion("type", [
  JevNoulQuestionSchema,
  JevChoiceQuestionSchema,
  JevScoreQuestionSchema,
]);

export const JevQuestionsSchema = z.record(z.string(), JevQuestionSchema);

export const JevNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

export const JevChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

export const JevScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

export const JevAnswerSchema = z.discriminatedUnion("type", [
  JevNoulAnswerSchema,
  JevChoiceAnswerSchema,
  JevScoreAnswerSchema,
]);

export const JevAnswersSchema = z.record(z.string(), JevAnswerSchema);

// jev.decide

// COMPAT(jev): added in v0.8.x, remove gate after 2027-03-28. Gated on
// `server_info.features.jev`. `feature` is a plain string; only "spawnHint" is accepted from a
// client (docs/jev.md, "RPCs") — every other feature is daemon-internal.
export const JevDecideRequestSchema = z.object({
  type: z.literal("jev.decide.request"),
  requestId: z.string(),
  feature: z.string(),
  callSite: z.string(),
  state: z.unknown(),
  questions: JevQuestionsSchema,
  scope: z.object({ cwd: z.string(), parentAgentId: z.string().optional() }).optional(),
  deadlineMs: z.number().optional(),
  // Answer as shadow even when the feature is live; it can only make a call shadow, never live
  // (docs/jev.md, "Feature 2"). The spawn hint's declared-label audit sends it so a declared
  // child's call never counts as a live answer.
  shadow: z.literal(true).optional(),
});

export const JevDecideResponseSchema = z.object({
  type: z.literal("jev.decide.response"),
  payload: z.object({
    requestId: z.string(),
    callId: z.string(),
    // "answered" | "shadow" | "unavailable" | "failed"
    outcome: z.string(),
    reason: z.string().nullable(),
    answers: JevAnswersSchema.nullable(),
    model: z.string().nullable(),
    elapsedMs: z.number(),
  }),
});

// jev.status

export const JevFeatureStatusSchema = z.object({
  enabled: z.boolean(),
  shadow: z.boolean(),
});

export const JevSpendTotalsSchema = z.object({
  calls: z.number(),
  answered: z.number(),
  failed: z.number(),
  unavailable: z.number(),
  inputTokens: z.number(),
  usd: z.number(),
  // "reported" | "estimated" | "mixed" | "none"
  usdSource: z.string(),
});

export const JevLaneStatusSchema = z.object({
  today: JevSpendTotalsSchema,
  maxUsdPerDay: z.number(),
  exhausted: z.boolean(),
  // "closed" | "open" | "half-open"
  circuit: z.string(),
  resetsAt: z.string(),
});

export const JevDaySpendSchema = z.object({
  day: z.string(),
  calls: z.number(),
  usd: z.number(),
});

export const JevStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  keyPresent: z.boolean(),
  // "openrouter" | "typesafe" | "fake"
  provider: z.string(),
  // Absent from an older daemon: whether `provider` was read off the key's prefix.
  providerInferred: z.boolean().optional(),
  model: z.string(),
  features: z.record(z.string(), JevFeatureStatusSchema),
  lanes: z.record(z.string(), JevLaneStatusSchema),
  spawnHint: z.object({
    applyHard: z.boolean(),
    applyRole: z.boolean(),
    // Absent from an older daemon: `agents.jev.spawnHint.auditDeclared` (docs/jev.md "Feature 2").
    auditDeclared: z.boolean().optional(),
  }),
  agentTools: z.object({
    assignShare: z.number(),
    // Absent from a daemon without the JEV agent tools: true when this daemon lists them to the
    // agents labelled `on`. The account-pool plugin gives no create an arm until it is.
    served: z.boolean().optional(),
  }),
  todayByFeature: z.record(z.string(), JevSpendTotalsSchema),
  last7Days: z.array(JevDaySpendSchema),
});

// COMPAT(jev): added in v0.8.x, remove gate after 2027-03-28. Gated on
// `server_info.features.jev`.
export const JevStatusRequestSchema = z.object({
  type: z.literal("jev.status.request"),
  requestId: z.string(),
});

export const JevStatusResponseSchema = z.object({
  type: z.literal("jev.status.response"),
  payload: z.object({
    requestId: z.string(),
    status: JevStatusSchema,
  }),
});

// jev.scope.check

// COMPAT(jev): added in v0.8.x, remove gate after 2027-03-28. Gated on
// `server_info.features.jev`.
export const JevScopeCheckRequestSchema = z.object({
  type: z.literal("jev.scope.check.request"),
  requestId: z.string(),
  cwd: z.string(),
  parentAgentId: z.string().optional(),
});

export const JevScopeCheckResponseSchema = z.object({
  type: z.literal("jev.scope.check.response"),
  payload: z.object({
    requestId: z.string(),
    // "ok" | "excluded"
    scope: z.string(),
  }),
});

// jev.decisions.list

export const JevDecisionRecordSchema = z.object({
  agentId: z.string().nullable(),
  callId: z.string(),
  feature: z.string(),
  question: z.string(),
  verdict: z.string(),
  confidence: z.number().nullable(),
  action: z.string(),
  applied: z.boolean(),
  // Absent from a daemon before the savings ledger. "shadow" | "live": `applied: false` is not
  // shadow, because a live answer that kept today's behaviour is not applied either.
  mode: z.string().optional(),
  // What the answer maps to with every switch on, in either mode.
  wouldBe: z.string().nullable().optional(),
  // The savings record for the same involvement (`jev.savings.events`).
  savingsId: z.string().optional(),
  at: z.string(),
  costUsd: z.number().nullable(),
});

// COMPAT(jev): added in v0.8.x, remove gate after 2027-03-28. Gated on
// `server_info.features.jev`.
export const JevDecisionsListRequestSchema = z.object({
  type: z.literal("jev.decisions.list.request"),
  requestId: z.string(),
  agentId: z.string(),
});

export const JevDecisionsListResponseSchema = z.object({
  type: z.literal("jev.decisions.list.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    decisions: z.array(JevDecisionRecordSchema),
  }),
});

// jev.ask

// Feature 15 (docs/jev.md, "Feature 15: Ask JEV"): a person's own question from the app. It runs
// through the same `JevService.decide` as every other feature, on its own `interactive` lane.
// COMPAT(jevAsk): added in v0.8.x, remove gate after 2027-03-29. Gated on
// `server_info.features.jevAsk`.
export const JevAskRequestSchema = z.object({
  type: z.literal("jev.ask.request"),
  requestId: z.string(),
  /** What the person pasted. Empty when the question stands alone. */
  context: z.string(),
  question: JevQuestionSchema,
  /**
   * Adds this agent's recent activity to the state. The daemon reads it; the agent, its ancestors
   * and its descendants are then in the D7 scope.
   */
  agentId: z.string().optional(),
  deadlineMs: z.number().optional(),
});

export const JevAskCostSchema = z.object({
  usd: z.number().nullable(),
  // "reported" | "estimated" | "fake" | "unknown"
  source: z.string(),
});

export const JevAskResponseSchema = z.object({
  type: z.literal("jev.ask.response"),
  payload: z.object({
    requestId: z.string(),
    callId: z.string(),
    // "answered" | "unavailable" | "failed"
    outcome: z.string(),
    // A `JevUnavailableReason` or `JevFailureReason` from the daemon's contract; null when answered.
    reason: z.string().nullable(),
    answer: JevAnswerSchema.nullable(),
    model: z.string().nullable(),
    elapsedMs: z.number(),
    /** Null when nothing was sent. */
    cost: JevAskCostSchema.nullable(),
    /** How many values redaction replaced before sending. */
    redactions: z.number(),
  }),
});

// jev.savings.*

// The savings ledger (docs/jev.md, "Savings"), mirroring `JevSavingsSummary` and `JevSavingsEvent`
// in the daemon's `jev/contract.ts`. Tokens are Opus-equivalent weighted tokens. Feature, mode,
// outcome, benefit, state and validation outcome are plain strings with the known values in a
// comment, so a new feature or reason never narrows the schema.

export const JevSavingsOtherBenefitSchema = z.object({
  // "pushes-held" | "minutes"
  unit: z.string(),
  value: z.number(),
});

export const JevSavingsModeTotalsSchema = z.object({
  involvements: z.number(),
  // Live: answers that changed what code did. Shadow: answers that would have.
  changed: z.number(),
  tokens: z.number(),
  // The part of `tokens` that is a median estimate, not measured. Optional: absent from an older daemon.
  estimatedTokens: z.number().optional(),
  otherBenefit: JevSavingsOtherBenefitSchema.nullable(),
  pending: z.number(),
});

export const JevSavingsFeatureSummarySchema = z.object({
  // A `JevFeatureId`, or "readCheck"
  feature: z.string(),
  // "off" | "shadow" | "live" | "dormant"
  state: z.string(),
  // "tokens" | "attention" | "time" | "none"
  benefit: z.string(),
  asked: z.number(),
  // Keyed by reason: "below-floor" | "excluded" | "inactive" | "not-text" | "secret-path" |
  // "outside-cwd" | "outside-repo" | "compound" | "saturated" | "dedup" | "repeat" | "changed"
  notAsked: z.record(z.string(), z.number()),
  live: JevSavingsModeTotalsSchema,
  shadow: JevSavingsModeTotalsSchema,
  validation: z.object({ checked: z.number(), held: z.number(), wrong: z.number() }),
  jevUsd: z.number(),
  // `met` is null until the rule's minimum count is reached.
  evidence: z.object({ rule: z.string(), observed: z.string(), met: z.boolean().nullable() }),
});

export const JevSavingsTopEntrySchema = z.object({
  // An agent id or a workspace id.
  id: z.string(),
  label: z.string().nullable(),
  involvements: z.number(),
  liveTokens: z.number(),
  shadowTokens: z.number(),
});

export const JevSavingsDaySchema = z.object({
  // The daemon's local calendar day, YYYY-MM-DD.
  day: z.string(),
  involvements: z.number(),
  liveTokens: z.number(),
  shadowTokens: z.number(),
  jevUsd: z.number(),
});

export const JevSavingsSummarySchema = z.object({
  // "today" | "7d" | "all"
  range: z.string(),
  from: z.string(),
  to: z.string(),
  // "opus-equivalent-weighted-tokens"
  unit: z.string(),
  live: z.object({ involvements: z.number(), tokensSaved: z.number() }),
  shadow: z.object({ involvements: z.number(), tokensWouldSave: z.number() }),
  jevSpend: z.object({ calls: z.number(), usd: z.number(), tokensEquivalent: z.number() }),
  net: z.object({ live: z.number(), ifLive: z.number() }),
  features: z.array(JevSavingsFeatureSummarySchema),
  topAgents: z.array(JevSavingsTopEntrySchema),
  topWorkspaces: z.array(JevSavingsTopEntrySchema),
  days: z.array(JevSavingsDaySchema),
});

export const JevSavingsDecisionSchema = z.object({
  did: z.string(),
  wouldBe: z.string().nullable(),
  changed: z.boolean(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export const JevSavingsBasisSchema = z.object({
  formula: z.string(),
  inputs: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
});

export const JevSavingsValidationSchema = z.object({
  // "held" | "false-skip" | "regret" | "contradicted"
  outcome: z.string(),
  signal: z.string().nullable(),
  afterMinutes: z.number().nullable(),
});

export const JevSavingsEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  feature: z.string(),
  agentId: z.string().nullable(),
  agentTitle: z.string().nullable(),
  workspaceId: z.string().nullable(),
  // "shadow" | "live"
  mode: z.string(),
  // "answered" | "shadow" | "unavailable" | "failed"
  outcome: z.string(),
  involvement: z.string(),
  decision: JevSavingsDecisionSchema,
  benefit: z.string(),
  tokensSavedEstimate: z.number().nullable(),
  otherBenefit: JevSavingsOtherBenefitSchema.nullable(),
  basis: JevSavingsBasisSchema.nullable(),
  pending: z.boolean(),
  // The figure is an estimate, not measured tokens. Optional: absent from an older daemon.
  estimated: z.boolean().optional(),
  validation: JevSavingsValidationSchema.nullable(),
  jevCostUsd: z.number().nullable(),
});

// COMPAT(jevSavings): added in v0.8.x, remove gate after 2027-03-30. Gated on
// `server_info.features.jevSavings`.
export const JevSavingsSummaryRequestSchema = z.object({
  type: z.literal("jev.savings.summary.request"),
  requestId: z.string(),
  // "today" | "7d" | "all"
  range: z.string(),
});

export const JevSavingsSummaryResponseSchema = z.object({
  type: z.literal("jev.savings.summary.response"),
  payload: z.object({
    requestId: z.string(),
    summary: JevSavingsSummarySchema,
  }),
});

// COMPAT(jevSavings): added in v0.8.x, remove gate after 2027-03-30. Gated on
// `server_info.features.jevSavings`.
export const JevSavingsEventsRequestSchema = z.object({
  type: z.literal("jev.savings.events.request"),
  requestId: z.string(),
  // "today" | "7d" | "all"
  range: z.string(),
  feature: z.string().optional(),
  agentId: z.string().optional(),
  // The previous page's `nextCursor`.
  cursor: z.string().optional(),
  // Default 50, at most 200.
  limit: z.number().optional(),
});

export const JevSavingsEventsResponseSchema = z.object({
  type: z.literal("jev.savings.events.response"),
  payload: z.object({
    requestId: z.string(),
    events: z.array(JevSavingsEventSchema),
    nextCursor: z.string().nullable(),
  }),
});

export type JevInstructions = z.infer<typeof JevInstructionsSchema>;
export type JevNoulQuestion = z.infer<typeof JevNoulQuestionSchema>;
export type JevChoiceQuestion = z.infer<typeof JevChoiceQuestionSchema>;
export type JevScoreQuestion = z.infer<typeof JevScoreQuestionSchema>;
export type JevQuestion = z.infer<typeof JevQuestionSchema>;
export type JevQuestions = z.infer<typeof JevQuestionsSchema>;
export type JevNoulAnswer = z.infer<typeof JevNoulAnswerSchema>;
export type JevChoiceAnswer = z.infer<typeof JevChoiceAnswerSchema>;
export type JevScoreAnswer = z.infer<typeof JevScoreAnswerSchema>;
export type JevAnswer = z.infer<typeof JevAnswerSchema>;
export type JevAnswers = z.infer<typeof JevAnswersSchema>;
export type JevDecideRequest = z.infer<typeof JevDecideRequestSchema>;
export type JevDecideResponse = z.infer<typeof JevDecideResponseSchema>;
export type JevFeatureStatus = z.infer<typeof JevFeatureStatusSchema>;
export type JevSpendTotals = z.infer<typeof JevSpendTotalsSchema>;
export type JevLaneStatus = z.infer<typeof JevLaneStatusSchema>;
export type JevDaySpend = z.infer<typeof JevDaySpendSchema>;
export type JevStatus = z.infer<typeof JevStatusSchema>;
export type JevStatusRequest = z.infer<typeof JevStatusRequestSchema>;
export type JevStatusResponse = z.infer<typeof JevStatusResponseSchema>;
export type JevScopeCheckRequest = z.infer<typeof JevScopeCheckRequestSchema>;
export type JevScopeCheckResponse = z.infer<typeof JevScopeCheckResponseSchema>;
export type JevDecisionRecord = z.infer<typeof JevDecisionRecordSchema>;
export type JevDecisionsListRequest = z.infer<typeof JevDecisionsListRequestSchema>;
export type JevDecisionsListResponse = z.infer<typeof JevDecisionsListResponseSchema>;
export type JevAskRequest = z.infer<typeof JevAskRequestSchema>;
export type JevAskResponse = z.infer<typeof JevAskResponseSchema>;
export type JevAskCost = z.infer<typeof JevAskCostSchema>;
export type JevSavingsOtherBenefit = z.infer<typeof JevSavingsOtherBenefitSchema>;
export type JevSavingsModeTotals = z.infer<typeof JevSavingsModeTotalsSchema>;
export type JevSavingsFeatureSummary = z.infer<typeof JevSavingsFeatureSummarySchema>;
export type JevSavingsTopEntry = z.infer<typeof JevSavingsTopEntrySchema>;
export type JevSavingsDay = z.infer<typeof JevSavingsDaySchema>;
export type JevSavingsSummary = z.infer<typeof JevSavingsSummarySchema>;
export type JevSavingsDecision = z.infer<typeof JevSavingsDecisionSchema>;
export type JevSavingsBasis = z.infer<typeof JevSavingsBasisSchema>;
export type JevSavingsValidation = z.infer<typeof JevSavingsValidationSchema>;
export type JevSavingsEvent = z.infer<typeof JevSavingsEventSchema>;
export type JevSavingsSummaryRequest = z.infer<typeof JevSavingsSummaryRequestSchema>;
export type JevSavingsSummaryResponse = z.infer<typeof JevSavingsSummaryResponseSchema>;
export type JevSavingsEventsRequest = z.infer<typeof JevSavingsEventsRequestSchema>;
export type JevSavingsEventsResponse = z.infer<typeof JevSavingsEventsResponseSchema>;
