import { JEV_FEATURE_LABELS } from "@getpaseo/protocol/jev/labels";
import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";

/** Newest first; older ones are counted, not listed, so the popover stays a glance. */
export const JEV_DECISIONS_SHOWN = 8;

/**
 * `shadow` (and feature 14's `dryRun`) marks a note the host's current status says is in shadow,
 * so the action reads as what code would have done. A live feature whose code kept today's
 * behaviour anyway, or a status read that failed, gets no tag: the host does not know which it
 * was when the decision was made, and a tag read from the mode now would be a guess.
 */
export type JevDecisionTag = "shadow" | "dryRun";

export interface JevDecisionLine {
  key: string;
  /** The raw feature id (`spawnHint`, `stallJudgment`, ...), for looking up its purpose line. */
  featureId: string;
  feature: string;
  question: string;
  /** The typed answers as the daemon summarized them, confidence included. */
  verdict: string;
  /** What code did, or in shadow what it would have done. */
  action: string;
  tag: JevDecisionTag | null;
  cost: string | null;
  at: Date | null;
  /**
   * A plain-words one-liner (docs/jev.md, "Feature 11"). Absent from an older daemon: the chip
   * falls back to the feature/verdict/action rendering it used before this field existed.
   */
  summary: string | null;
  /**
   * A second plain-words line (feature 11), naming vocabulary only the daemon has. Absent for
   * most decisions: `summary` already said everything.
   */
  detail: string | null;
  /**
   * Set when this decision is about a child agent rather than the one the view was built for —
   * the child's title, or a generic fallback when it has none. Null when it is about the viewing
   * agent itself.
   */
  subjectLabel: string | null;
}

export interface JevDecisionsView {
  lines: JevDecisionLine[];
  /** Decisions older than the ones listed. */
  hidden: number;
}

export function jevFeatureLabel(feature: string): string {
  return JEV_FEATURE_LABELS[feature] ?? feature;
}

/**
 * `mode` is the note's own record of shadow vs. live, from the savings track's hook-in
 * (contract.ts, `JevDecisionNote.mode`): it never disagrees with the mode the decision was
 * actually made under, unlike `applied` or the host's current status. A note from before that
 * hook-in has no `mode`; for those, fall back to the old heuristic (today's status, which can be
 * wrong if the feature's shadow setting changed since).
 */
export function tagFor(record: JevDecisionRecord, status: JevStatus | null): JevDecisionTag | null {
  if (record.mode !== undefined) {
    if (record.mode !== "shadow") return null;
    return record.feature === "awayReply" ? "dryRun" : "shadow";
  }
  if (record.applied) return null;
  if (status === null) return null;
  if (!status.features[record.feature]?.shadow) return null;
  return record.feature === "awayReply" ? "dryRun" : "shadow";
}

/** JEV calls cost fractions of a cent, so the figure keeps the digits that carry it. */
export function formatJevCost(usd: number | null, provider: string | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (provider === "fake") return "$0 (fake)";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function parseJevDecisionAt(at: string): Date | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The text naming the child a decision is about, or null when the decision is about the agent
 * the list was asked for. A child with no title still gets a generic fallback, never a blank.
 */
export function subjectLabelFor(record: JevDecisionRecord): string | null {
  if (!record.subjectAgentId) return null;
  return record.subjectAgentTitle?.trim() || "a subagent";
}

export function buildJevDecisionsView(
  decisions: readonly JevDecisionRecord[],
  status: JevStatus | null,
  limit: number = JEV_DECISIONS_SHOWN,
): JevDecisionsView {
  const provider = status?.provider ?? null;
  const lines = decisions.slice(0, limit).map((record, index) => ({
    key: `${record.callId}:${index}`,
    featureId: record.feature,
    feature: jevFeatureLabel(record.feature),
    question: record.question,
    verdict: record.verdict,
    action: record.action,
    tag: tagFor(record, status),
    cost: formatJevCost(record.costUsd, provider),
    at: parseJevDecisionAt(record.at),
    summary: record.summary ?? null,
    detail: record.detail ?? null,
    subjectLabel: subjectLabelFor(record),
  }));
  return { lines, hidden: Math.max(0, decisions.length - lines.length) };
}
