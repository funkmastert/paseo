/**
 * The wire shapes, now that the savings track's seam landed (`packages/protocol/src/jev/
 * rpc-schemas.ts`). `feature`, `state`, `benefit`, `mode` and `outcome` travel as plain strings
 * (docs/protocol-compatibility.md), so a feature or reason neither side names yet still renders.
 */
export type {
  JevSavingsBasis,
  JevSavingsDay,
  JevSavingsDecision,
  JevSavingsEvent,
  JevSavingsFeatureSummary,
  JevSavingsOtherBenefit as JevOtherBenefit,
  JevSavingsSummary,
  JevSavingsTopEntry,
  JevSavingsValidation,
} from "@getpaseo/protocol/jev/rpc-schemas";

import type { JevSavingsEvent, JevSavingsSummary } from "@getpaseo/protocol/jev/rpc-schemas";

export type JevSavingsRange = "today" | "7d" | "all";

export interface JevSavingsEventsQuery {
  range: JevSavingsRange;
  feature?: string;
  agentId?: string;
  cursor?: string;
  limit?: number;
}

export interface JevSavingsEventsPage {
  events: JevSavingsEvent[];
  nextCursor: string | null;
}

/**
 * What the dashboard's hooks call: a real `jev.savings.summary`/`jev.savings.events` round trip
 * through `DaemonClient` once the savings ledger's handlers land, a local fake until then
 * (`fake-jev-savings-reader.ts`).
 */
export interface JevSavingsReader {
  summary(range: JevSavingsRange): Promise<JevSavingsSummary>;
  events(query: JevSavingsEventsQuery): Promise<JevSavingsEventsPage>;
}
