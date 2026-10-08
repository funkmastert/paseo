import type {
  TokenUsageGetBreakdownResponse,
  TokenUsageRow,
} from "@getpaseo/protocol/token-usage/rpc-schemas";

export type {
  TokenUsageCoverage,
  TokenUsageRange,
  TokenUsageRow,
} from "@getpaseo/protocol/token-usage/rpc-schemas";
export type TokenUsageBreakdown = TokenUsageGetBreakdownResponse["payload"];
export type TokenUsageUnit = "weighted" | "raw";

/**
 * The three buckets this screen renders. The wire's `role` is an open string
 * (docs/protocol-compatibility.md — never narrow a closed enum): a daemon may add a fourth role
 * before this app knows about it. `normalizeTokenUsageRole` is the one place that decides what an
 * unrecognized role displays as.
 */
export type TokenUsageDisplayRole = "leader" | "worker" | "outside";

export const TOKEN_USAGE_ROLE_ORDER: readonly TokenUsageDisplayRole[] = [
  "leader",
  "worker",
  "outside",
];

/** An unrecognized role books under "outside" — same bucket as a session with no owning agent. */
export function normalizeTokenUsageRole(role: string): TokenUsageDisplayRole {
  if (role === "leader" || role === "worker") return role;
  return "outside";
}

/** `model` is `"unknown"` when the response carried none (KTD-6). */
export const TOKEN_USAGE_UNKNOWN_MODEL = "unknown";

function rawTotal(row: TokenUsageRow): number {
  return row.input + row.cacheWrite + row.cacheRead + row.output;
}

export function totalForUnit(row: TokenUsageRow, unit: TokenUsageUnit): number {
  return unit === "weighted" ? row.weighted : rawTotal(row);
}

interface CompactTokenUnit {
  threshold: number;
  divisor: number;
  suffix: string;
}

const COMPACT_TOKEN_UNITS: readonly CompactTokenUnit[] = [
  { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000, divisor: 1_000_000, suffix: "M" },
  { threshold: 1_000, divisor: 1_000, suffix: "K" },
];

/**
 * One decimal below 10 in the chosen unit, none at 10 and above — a value never shows more than
 * three significant digits. 1_192_800_000 -> "1.2B", 547_900_000 -> "548M", 7_400_000 -> "7.4M",
 * 3_000_000 -> "3M", 16_000 -> "16K", 900 -> "900".
 */
export function formatCompactTokens(value: number): string {
  const abs = Math.abs(value);
  const unit = COMPACT_TOKEN_UNITS.find((candidate) => abs >= candidate.threshold);
  if (!unit) return `${Math.round(value)}`;
  const scaled = value / unit.divisor;
  const formatted =
    Math.abs(scaled) < 10 ? trimTrailingZero(scaled.toFixed(1)) : `${Math.round(scaled)}`;
  return `${formatted}${unit.suffix}`;
}

function trimTrailingZero(formatted: string): string {
  return formatted.endsWith(".0") ? formatted.slice(0, -2) : formatted;
}

export interface TokenUsageRoleSegment {
  role: TokenUsageDisplayRole;
  total: number;
  /** Share of the largest bar's total, so segments across bars compare on one scale. */
  fraction: number;
}

export interface TokenUsageModelBar {
  id: string;
  provider: string;
  model: string;
  label: string;
  isUnattributed: boolean;
  total: number;
  formattedTotal: string;
  /** This bar's own length as a share of the largest bar (0-1). */
  share: number;
  segments: TokenUsageRoleSegment[];
}

/**
 * One bar per provider/model, largest first, the `"unknown"` model trailing as "Unattributed"
 * (R7, R10). Each bar's role segments are fractions of the single largest bar's total, not of the
 * bar's own total, so segment widths compare correctly across bars of different lengths.
 */
export function buildTokenUsageModelBars(
  rows: readonly TokenUsageRow[],
  unit: TokenUsageUnit,
): TokenUsageModelBar[] {
  interface Entry {
    provider: string;
    model: string;
    roleTotals: Map<TokenUsageDisplayRole, number>;
  }
  const byModel = new Map<string, Entry>();
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    const entry = byModel.get(key) ?? {
      provider: row.provider,
      model: row.model,
      roleTotals: new Map(),
    };
    const role = normalizeTokenUsageRole(row.role);
    const value = totalForUnit(row, unit);
    entry.roleTotals.set(role, (entry.roleTotals.get(role) ?? 0) + value);
    byModel.set(key, entry);
  }

  const withTotals = [...byModel.values()].map((entry) => {
    const total = [...entry.roleTotals.values()].reduce((sum, value) => sum + value, 0);
    return { provider: entry.provider, model: entry.model, roleTotals: entry.roleTotals, total };
  });
  const attributed = withTotals
    .filter((entry) => entry.model !== TOKEN_USAGE_UNKNOWN_MODEL)
    .sort((a, b) => b.total - a.total);
  const unattributed = withTotals.filter((entry) => entry.model === TOKEN_USAGE_UNKNOWN_MODEL);
  const ordered = [...attributed, ...unattributed];

  const totals = ordered.map((entry) => entry.total);
  const maxTotal = Math.max(1, ...totals);

  return ordered.map((entry) => buildModelBar(entry, maxTotal));
}

function buildModelBar(
  entry: {
    provider: string;
    model: string;
    roleTotals: Map<TokenUsageDisplayRole, number>;
    total: number;
  },
  maxTotal: number,
): TokenUsageModelBar {
  const isUnattributed = entry.model === TOKEN_USAGE_UNKNOWN_MODEL;
  const label = isUnattributed ? "Unattributed" : `${entry.provider} / ${entry.model}`;
  const segments = TOKEN_USAGE_ROLE_ORDER.map((role) => {
    const roleTotal = entry.roleTotals.get(role) ?? 0;
    return { role, total: roleTotal, fraction: roleTotal / maxTotal };
  });
  return {
    id: `${entry.provider}/${entry.model}`,
    provider: entry.provider,
    model: entry.model,
    label,
    isUnattributed,
    total: entry.total,
    formattedTotal: formatCompactTokens(entry.total),
    share: entry.total / maxTotal,
    segments,
  };
}

export interface TokenUsageRoleTotal {
  role: TokenUsageDisplayRole;
  total: number;
  formattedTotal: string;
}

/** Leader, worker, outside totals (R8), always all three roles even when a role has no usage. */
export function buildTokenUsageRoleTotals(
  rows: readonly TokenUsageRow[],
  unit: TokenUsageUnit,
): TokenUsageRoleTotal[] {
  const totals = new Map<TokenUsageDisplayRole, number>();
  for (const row of rows) {
    const role = normalizeTokenUsageRole(row.role);
    totals.set(role, (totals.get(role) ?? 0) + totalForUnit(row, unit));
  }
  return TOKEN_USAGE_ROLE_ORDER.map((role) => {
    const total = totals.get(role) ?? 0;
    return { role, total, formattedTotal: formatCompactTokens(total) };
  });
}

/** R10: the footer flag for when any unattributed usage exists in the current unit. */
export function hasIncompleteAttribution(
  rows: readonly TokenUsageRow[],
  unit: TokenUsageUnit,
): boolean {
  return rows.some((row) => row.model === TOKEN_USAGE_UNKNOWN_MODEL && totalForUnit(row, unit) > 0);
}

export type TokenUsageDisplayState =
  | { kind: "error"; message: string }
  | { kind: "disabled" }
  | { kind: "backfilling"; filesDone: number; filesTotal: number }
  | { kind: "empty" }
  | { kind: "data" };

export type TokenUsageDisplayStateInput = Pick<TokenUsageBreakdown, "rows" | "coverage" | "error">;

/**
 * R11/R14: a failed read (the payload's own `error`) and the feature turned off in config
 * (`coverage.enabled: false`) are distinct from "no data yet" — both would otherwise fall through
 * to the same empty state, hiding why. `backfill.state` is an open string too; a state this app
 * doesn't recognize yet behaves like "done" — no progress banner, since it isn't known to still be
 * running.
 */
export function resolveTokenUsageDisplayState(
  breakdown: TokenUsageDisplayStateInput,
): TokenUsageDisplayState {
  if (breakdown.error) return { kind: "error", message: breakdown.error };
  if (!breakdown.coverage.enabled) return { kind: "disabled" };
  if (breakdown.rows.length > 0) return { kind: "data" };
  const backfillState = breakdown.coverage.backfill.state;
  if (backfillState === "running" || backfillState === "pending") {
    return {
      kind: "backfilling",
      filesDone: breakdown.coverage.backfill.filesDone,
      filesTotal: breakdown.coverage.backfill.filesTotal,
    };
  }
  return { kind: "empty" };
}
