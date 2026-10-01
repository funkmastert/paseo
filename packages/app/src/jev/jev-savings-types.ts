/**
 * App-side mirror of the savings shapes in `packages/server/src/server/jev/contract.ts`.
 * The savings track's seam commit is what actually puts these on the wire
 * (`packages/protocol/src/jev/rpc-schemas.ts`, `jev.savings.summary`/`jev.savings.events`) and adds
 * `DaemonClient.jevSavingsSummary`/`jevSavingsEvents`. Until that lands, the dashboard builds
 * against this local copy and a fake `JevSavingsReader` (`fake-jev-savings-reader.ts`). At merge,
 * delete this file and import the generated/protocol types instead.
 */

export type JevSavingsFeature =
  | "spawnHint"
  | "remediationTriage"
  | "notificationTriage"
  | "agentTools"
  | "compactionTiming"
  | "stallJudgment"
  | "awayReply"
  | "askJev"
  | "readCheck";

export type JevSavingsMode = "shadow" | "live";

export type JevBenefitKind = "tokens" | "attention" | "time" | "none";

export interface JevOtherBenefit {
  unit: "pushes-held" | "minutes";
  value: number;
}

export type JevNotAskedReason =
  | "below-floor"
  | "excluded"
  | "inactive"
  | "not-text"
  | "secret-path"
  | "outside-cwd"
  | "dedup"
  | "repeat";

export interface JevSavingsDecision {
  did: string;
  wouldBe: string | null;
  changed: boolean;
  detail?: Record<string, string | number | boolean | null>;
}

export interface JevSavingsBasis {
  formula: string;
  inputs: Record<string, number | string | null>;
}

export interface JevSavingsValidation {
  outcome: "held" | "false-skip" | "regret" | "contradicted";
  signal: string | null;
  afterMinutes: number | null;
}

export type JevSavingsRange = "today" | "7d" | "all";

export type JevFeatureState = "off" | "shadow" | "live" | "dormant";

export interface JevSavingsModeTotals {
  involvements: number;
  changed: number;
  tokens: number;
  otherBenefit: JevOtherBenefit | null;
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
  evidence: { rule: string; observed: string; met: boolean | null };
}

export interface JevSavingsTopEntry {
  id: string;
  label: string | null;
  involvements: number;
  liveTokens: number;
  shadowTokens: number;
}

export interface JevSavingsDay {
  day: string;
  involvements: number;
  liveTokens: number;
  shadowTokens: number;
  jevUsd: number;
}

export interface JevSavingsSummary {
  range: JevSavingsRange;
  from: string;
  to: string;
  unit: "opus-equivalent-weighted-tokens";
  live: { involvements: number; tokensSaved: number };
  shadow: { involvements: number; tokensWouldSave: number };
  jevSpend: { calls: number; usd: number; tokensEquivalent: number };
  net: { live: number; ifLive: number };
  features: JevSavingsFeatureSummary[];
  topAgents: JevSavingsTopEntry[];
  topWorkspaces: JevSavingsTopEntry[];
  days: JevSavingsDay[];
}

export interface JevSavingsEvent {
  id: string;
  at: string;
  feature: JevSavingsFeature;
  agentId: string | null;
  agentTitle: string | null;
  workspaceId: string | null;
  mode: JevSavingsMode;
  outcome: "answered" | "shadow" | "unavailable" | "failed";
  involvement: string;
  decision: JevSavingsDecision;
  benefit: JevBenefitKind;
  tokensSavedEstimate: number | null;
  otherBenefit: JevOtherBenefit | null;
  basis: JevSavingsBasis | null;
  pending: boolean;
  validation: JevSavingsValidation | null;
  jevCostUsd: number | null;
}

export interface JevSavingsEventsQuery {
  range: JevSavingsRange;
  feature?: JevSavingsFeature;
  agentId?: string;
  cursor?: string;
  limit?: number;
}

export interface JevSavingsEventsPage {
  events: JevSavingsEvent[];
  nextCursor: string | null;
}

/** `jev.savings.summary` / `jev.savings.events`, whichever backs the reader (real or fake). */
export interface JevSavingsReader {
  summary(range: JevSavingsRange): Promise<JevSavingsSummary>;
  events(query: JevSavingsEventsQuery): Promise<JevSavingsEventsPage>;
}
