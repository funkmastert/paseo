import {
  severityRank,
  type TokenAuditReport,
  type TokenAuditRow,
} from "../session/doctor/tokens/types.js";

/**
 * What changed since the last report, in the terms the escalation rule uses: a RED that was not
 * RED before, a row that crossed a severity threshold, or a measured number that rose past its
 * tolerance. A persistent RED is not news: it escalated the week it appeared.
 */

export interface MetricRule {
  metric: string;
  /** The rise that counts as material, in the metric's own unit (`points` or a ratio). */
  kind: "points" | "ratio";
  amount: number;
  /** Ignore a ratio rise on a base below this: 1k tokens becoming 2k is not news. */
  minBase?: number;
  label: string;
}

/**
 * The numbers Tyler named, plus the write share: cache reads and cache writes going up as a share
 * of all tokens, and the fleet's median last-turn context growing. `cache.*Share` values are
 * percents, so `points` means percentage points.
 */
export const METRIC_RULES: readonly MetricRule[] = [
  { metric: "cache.readShare", kind: "points", amount: 5, label: "cache-read share" },
  { metric: "cache.creationShare", kind: "points", amount: 5, label: "cache-write share" },
  {
    metric: "cache.lastTurnContextMedian",
    kind: "ratio",
    amount: 0.2,
    minBase: 10_000,
    label: "median last-turn context",
  },
  {
    metric: "memory.totalTokens",
    kind: "ratio",
    amount: 0.2,
    minBase: 2_000,
    label: "total memory tokens",
  },
];

export interface ReportDiff {
  /** RED now, and not RED in the previous report (or no previous report). */
  newRed: TokenAuditRow[];
  /** Rows whose severity got worse, RED excluded (those are in `newRed`). */
  crossed: Array<{ row: TokenAuditRow; from: TokenAuditRow["severity"] }>;
  /** Metric rises past their tolerance. */
  risen: Array<{ key: string; metric: string; label: string; from: number; to: number }>;
  /** True when anything above is non-empty: the report is worth an agent and a person. */
  escalate: boolean;
  /** One line per reason, for the push and the agent's evidence. */
  reasons: string[];
}

function worsened(from: TokenAuditRow["severity"], to: TokenAuditRow["severity"]): boolean {
  // UNKNOWN is a missing measurement, not a level: moving into or out of it is not a change.
  if (from === "UNKNOWN" || to === "UNKNOWN") return false;
  return severityRank(to) < severityRank(from);
}

function risenPast(rule: MetricRule, from: number, to: number): boolean {
  if (rule.kind === "points") return to - from >= rule.amount;
  return from >= (rule.minBase ?? 0) && from > 0 && (to - from) / from >= rule.amount;
}

function describeRise(rule: MetricRule, from: number, to: number): string {
  const unit = rule.kind === "points" ? "%" : "";
  return `${rule.label} rose from ${from}${unit} to ${to}${unit}`;
}

export function diffReports(previous: TokenAuditReport | null, next: TokenAuditReport): ReportDiff {
  const before = new Map(previous?.rows.map((r) => [r.key, r]));
  const diff: ReportDiff = { newRed: [], crossed: [], risen: [], escalate: false, reasons: [] };
  for (const current of next.rows) {
    const prior = before.get(current.key);
    if (current.severity === "RED" && prior?.severity !== "RED") {
      diff.newRed.push(current);
      diff.reasons.push(`new RED: ${current.finding}`);
    } else if (prior && worsened(prior.severity, current.severity)) {
      diff.crossed.push({ row: current, from: prior.severity });
      diff.reasons.push(`${current.finding}: ${prior.severity} to ${current.severity}`);
    }
    if (!prior) continue;
    for (const rule of METRIC_RULES) {
      const from = prior.metrics?.[rule.metric];
      const to = current.metrics?.[rule.metric];
      if (from === undefined || to === undefined || !risenPast(rule, from, to)) continue;
      diff.risen.push({ key: current.key, metric: rule.metric, label: rule.label, from, to });
      diff.reasons.push(describeRise(rule, from, to));
    }
  }
  diff.escalate = diff.newRed.length + diff.crossed.length + diff.risen.length > 0;
  return diff;
}
