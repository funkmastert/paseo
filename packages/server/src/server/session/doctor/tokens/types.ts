import type { DoctorFinding, DoctorFindingStatus } from "@getpaseo/protocol/doctor/rpc-schemas";
import type { DoctorContext } from "../context.js";

/** The seven audit items, in the order the table prints them. See docs/token-audit.md. */
export const TOKEN_AUDIT_ITEMS = [
  "memory",
  "tools",
  "model",
  "hooks",
  "subagents",
  "scheduled",
  "cache",
] as const;
export type TokenAuditItem = (typeof TOKEN_AUDIT_ITEMS)[number];

/**
 * UNKNOWN is a measurement that could not be taken (no `claude` binary, a probe that timed out,
 * a platform without the tool). It is never a guess and never escalates.
 */
export type TokenSeverity = "RED" | "AMBER" | "GREEN" | "UNKNOWN";

/** One line of the audit table: FINDING | SEVERITY | EVIDENCE | COST. */
export interface TokenAuditRow {
  item: TokenAuditItem;
  /**
   * Stable across runs: the diff matches this row to last week's by `key`. Built from what the
   * row is about (`memory:file:/abs/path`, `cache:fleet`), never from its numbers.
   */
  key: string;
  finding: string;
  severity: TokenSeverity;
  /** A number or a path, never an adjective. */
  evidence: string;
  /** What leaving it costs, in tokens or turns where it can be measured. */
  cost: string;
  /**
   * Named numbers the run-to-run diff compares (`cache.readShare`, `cache.lastTurnContext`). Only
   * measured values: a row with nothing measured has none.
   */
  metrics?: Record<string, number>;
}

export interface TokenAuditCheck {
  /** `tokens.<item>`. */
  id: string;
  item: TokenAuditItem;
  timeoutMs: number | ((ctx: DoctorContext) => number);
  measure(ctx: DoctorContext, deadline: number): Promise<TokenAuditRow[]>;
}

export interface TokenAuditReport {
  version: 1;
  generatedAt: string;
  /** Where the checks ran: the daemon's scheduled job, or `paseo doctor --tokens`. */
  source: "job" | "cli";
  rows: TokenAuditRow[];
}

const STATUS_BY_SEVERITY: Record<TokenSeverity, DoctorFindingStatus> = {
  RED: "fail",
  AMBER: "warn",
  GREEN: "ok",
  UNKNOWN: "skip",
};

export function row(
  item: TokenAuditItem,
  key: string,
  severity: TokenSeverity,
  finding: string,
  evidence: string,
  cost: string,
  metrics?: Record<string, number>,
): TokenAuditRow {
  return { item, key, severity, finding, evidence, cost, ...(metrics ? { metrics } : {}) };
}

/** The doctor's finding shape: title = FINDING, detail = EVIDENCE, why = COST. */
export function rowToFinding(r: TokenAuditRow): DoctorFinding {
  return {
    id: `tokens.${r.item}`,
    category: "tokens",
    status: STATUS_BY_SEVERITY[r.severity],
    title: r.finding,
    detail: r.evidence,
    why: r.cost,
  };
}

const SEVERITY_ORDER: Record<TokenSeverity, number> = { RED: 0, AMBER: 1, UNKNOWN: 2, GREEN: 3 };

export function severityRank(severity: TokenSeverity): number {
  return SEVERITY_ORDER[severity];
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/**
 * The one table, as markdown: it prints in a terminal, reads in a push and pastes into an agent
 * prompt unchanged. Rows keep item order, worst first within an item.
 */
export function renderTokenAuditTable(rows: readonly TokenAuditRow[]): string {
  const ordered = [...rows].sort(
    (a, b) =>
      TOKEN_AUDIT_ITEMS.indexOf(a.item) - TOKEN_AUDIT_ITEMS.indexOf(b.item) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const lines = [
    "| FINDING | SEVERITY | EVIDENCE | COST |",
    "| --- | --- | --- | --- |",
    ...ordered.map(
      (r) =>
        `| ${cell(`${r.item.toUpperCase()}: ${r.finding}`)} | ${r.severity} | ${cell(r.evidence)} | ${cell(r.cost)} |`,
    ),
  ];
  return lines.join("\n");
}

export function countSeverities(rows: readonly TokenAuditRow[]): Record<TokenSeverity, number> {
  const counts: Record<TokenSeverity, number> = { RED: 0, AMBER: 0, GREEN: 0, UNKNOWN: 0 };
  for (const r of rows) counts[r.severity] += 1;
  return counts;
}

/** An UNKNOWN row for a whole item whose probe could not run. */
export function unknownRow(
  item: TokenAuditItem,
  key: string,
  finding: string,
  reason: string,
): TokenAuditRow {
  return row(item, key, "UNKNOWN", finding, `UNKNOWN: ${reason}`, "UNKNOWN");
}
