import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";

/** Newest first; older ones are counted, not listed, so the popover stays a glance. */
export const JEV_DECISIONS_SHOWN = 8;

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  spawnHint: "Spawn hint",
  remediationTriage: "Remediation triage",
  notificationTriage: "Finish triage",
  stallJudgment: "Stall judgment",
  compactionTiming: "Compaction timing",
  awayReply: "Away reply",
  agentTools: "Agent tools",
  askJev: "Ask JEV",
};

/**
 * Why a decision was not acted on. `shadow` (and feature 14's `dryRun`) is the feature's mode, so
 * the action reads as what code would have done; `notApplied` is a live feature whose code chose
 * today's behaviour anyway.
 */
export type JevDecisionTag = "shadow" | "dryRun" | "notApplied";

export interface JevDecisionLine {
  key: string;
  feature: string;
  question: string;
  /** The typed answers as the daemon summarized them, confidence included. */
  verdict: string;
  /** What code did, or in shadow what it would have done. */
  action: string;
  tag: JevDecisionTag | null;
  cost: string | null;
  at: Date | null;
}

export interface JevDecisionsView {
  lines: JevDecisionLine[];
  /** Decisions older than the ones listed. */
  hidden: number;
}

export function jevFeatureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

function tagFor(record: JevDecisionRecord, status: JevStatus | null): JevDecisionTag | null {
  if (record.applied) return null;
  if (status?.features[record.feature]?.shadow) {
    return record.feature === "awayReply" ? "dryRun" : "shadow";
  }
  return "notApplied";
}

/** JEV calls cost fractions of a cent, so the figure keeps the digits that carry it. */
export function formatJevCost(usd: number | null, provider: string | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (provider === "fake") return "$0 (fake)";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function parseAt(at: string): Date | null {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function buildJevDecisionsView(
  decisions: readonly JevDecisionRecord[],
  status: JevStatus | null,
  limit: number = JEV_DECISIONS_SHOWN,
): JevDecisionsView {
  const provider = status?.provider ?? null;
  const lines = decisions.slice(0, limit).map((record, index) => ({
    key: `${record.callId}:${index}`,
    feature: jevFeatureLabel(record.feature),
    question: record.question,
    verdict: record.verdict,
    action: record.action,
    tag: tagFor(record, status),
    cost: formatJevCost(record.costUsd, provider),
    at: parseAt(record.at),
  }));
  return { lines, hidden: Math.max(0, decisions.length - lines.length) };
}
