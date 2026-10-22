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

/**
 * API-equivalent cost in USD, fixed `en-US` formatting (KTD-7, docs/token-usage.md "Cost") —
 * the figure is explicitly a US-dollar list-price estimate, not the user's local currency, so it
 * reads the same regardless of UI language. A nonzero amount that would round to "$0.00" shows
 * as "<$0.01" instead, so a real cost never looks indistinguishable from none.
 */
const USD_FORMATTER = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return USD_FORMATTER.format(value);
}

interface CostAggregate {
  /** Sum across priced rows only; `null` when none of the rows are priced. */
  costUsd: number | null;
  /** `true` when at least one contributing row has no listed price — `costUsd` undercounts it. */
  isCostLowerBound: boolean;
}

/**
 * Sums `costUsd` across priced rows and reports whether any contributing row was unpriced,
 * mirroring the daemon's own partial-sum behavior for the range total (`token-usage-service.ts`,
 * `totalTokenUsageCost`) instead of discarding the whole bar's or role's cost over one unpriced
 * row.
 */
function sumCostUsd(rows: readonly TokenUsageRow[]): CostAggregate {
  // No rows (an unused role) costs $0, not "unknown" — only an unpriced row makes it unknown.
  if (rows.length === 0) return { costUsd: 0, isCostLowerBound: false };
  let sum = 0;
  let pricedRows = 0;
  let hasUnpriced = false;
  for (const row of rows) {
    if (row.costUsd === null || row.costUsd === undefined) {
      hasUnpriced = true;
      continue;
    }
    sum += row.costUsd;
    pricedRows += 1;
  }
  return { costUsd: pricedRows > 0 ? sum : null, isCostLowerBound: pricedRows > 0 && hasUnpriced };
}

/**
 * `formatUsd`, passing `null` through, prefixed with "≥" when `isLowerBound` — the shared shape
 * for every priced-or-unpriced field that can also be a partial sum.
 */
function formatCostOrNull(costUsd: number | null, isLowerBound: boolean): string | null {
  if (costUsd === null) return null;
  const formatted = formatUsd(costUsd);
  return isLowerBound ? `≥${formatted}` : formatted;
}

export function totalForUnit(row: TokenUsageRow, unit: TokenUsageUnit): number {
  return unit === "weighted" ? row.weighted : rawTotal(row);
}

interface CompactTokenUnit {
  divisor: number;
  suffix: string;
}

/** Smallest first: the first unit whose rounded value stays below 1,000 wins. */
const COMPACT_TOKEN_UNITS: readonly CompactTokenUnit[] = [
  { divisor: 1_000, suffix: "K" },
  { divisor: 1_000_000, suffix: "M" },
  { divisor: 1_000_000_000, suffix: "B" },
];

/**
 * One decimal below 10 in the chosen unit, none at 10 and above — a value never shows more than
 * three significant digits. 1_192_800_000 -> "1.2B", 547_900_000 -> "548M", 7_400_000 -> "7.4M",
 * 3_000_000 -> "3M", 16_000 -> "16K", 900 -> "900". The unit is picked after rounding, so
 * 999_600 reads "1M", not "1000K".
 */
export function formatCompactTokens(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1_000) return `${rounded}`;
  const lastUnit = COMPACT_TOKEN_UNITS[COMPACT_TOKEN_UNITS.length - 1];
  for (const unit of COMPACT_TOKEN_UNITS) {
    const formatted = formatScaled(value / unit.divisor);
    if (Math.abs(Number(formatted)) < 1_000 || unit === lastUnit) {
      return `${formatted}${unit.suffix}`;
    }
  }
  return `${rounded}`;
}

function formatScaled(scaled: number): string {
  return Math.abs(scaled) < 10 ? trimTrailingZero(scaled.toFixed(1)) : `${Math.round(scaled)}`;
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
  /** API-equivalent cost summed across this bar's priced rows; `null` when none are priced. */
  costUsd: number | null;
  /** `true` when `costUsd` excludes at least one unpriced row — a lower bound, not the total. */
  isCostLowerBound: boolean;
  formattedCost: string | null;
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
    rows: TokenUsageRow[];
  }
  const byModel = new Map<string, Entry>();
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    const entry: Entry = byModel.get(key) ?? {
      provider: row.provider,
      model: row.model,
      roleTotals: new Map(),
      rows: [],
    };
    const role = normalizeTokenUsageRole(row.role);
    const value = totalForUnit(row, unit);
    entry.roleTotals.set(role, (entry.roleTotals.get(role) ?? 0) + value);
    entry.rows.push(row);
    byModel.set(key, entry);
  }

  const withTotals = [...byModel.values()].map((entry) => {
    const total = [...entry.roleTotals.values()].reduce((sum, value) => sum + value, 0);
    return {
      provider: entry.provider,
      model: entry.model,
      roleTotals: entry.roleTotals,
      rows: entry.rows,
      total,
    };
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
    rows: TokenUsageRow[];
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
  const { costUsd, isCostLowerBound } = sumCostUsd(entry.rows);
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
    costUsd,
    isCostLowerBound,
    formattedCost: formatCostOrNull(costUsd, isCostLowerBound),
  };
}

export interface TokenUsageRoleTotal {
  role: TokenUsageDisplayRole;
  total: number;
  formattedTotal: string;
  /** API-equivalent cost summed across this role's priced rows; `null` when none are priced. */
  costUsd: number | null;
  /** `true` when `costUsd` excludes at least one unpriced row — a lower bound, not the total. */
  isCostLowerBound: boolean;
  formattedCost: string | null;
}

/** Leader, worker, outside totals (R8), always all three roles even when a role has no usage. */
export function buildTokenUsageRoleTotals(
  rows: readonly TokenUsageRow[],
  unit: TokenUsageUnit,
): TokenUsageRoleTotal[] {
  const totals = new Map<TokenUsageDisplayRole, number>();
  const rowsByRole = new Map<TokenUsageDisplayRole, TokenUsageRow[]>();
  for (const row of rows) {
    const role = normalizeTokenUsageRole(row.role);
    totals.set(role, (totals.get(role) ?? 0) + totalForUnit(row, unit));
    const roleRows = rowsByRole.get(role) ?? [];
    roleRows.push(row);
    rowsByRole.set(role, roleRows);
  }
  return TOKEN_USAGE_ROLE_ORDER.map((role) => {
    const total = totals.get(role) ?? 0;
    const { costUsd, isCostLowerBound } = sumCostUsd(rowsByRole.get(role) ?? []);
    return {
      role,
      total,
      formattedTotal: formatCompactTokens(total),
      costUsd,
      isCostLowerBound,
      formattedCost: formatCostOrNull(costUsd, isCostLowerBound),
    };
  });
}

/** R10: the footer flag for when any unattributed usage exists in the current unit. */
export function hasIncompleteAttribution(
  rows: readonly TokenUsageRow[],
  unit: TokenUsageUnit,
): boolean {
  return rows.some((row) => row.model === TOKEN_USAGE_UNKNOWN_MODEL && totalForUnit(row, unit) > 0);
}

export interface TokenUsageCostSummary {
  totalCostUsd: number | null;
  /** "≥$X" when `hasUnpriced` — the daemon's total is a partial sum, same as a bar's or role's. */
  formattedTotal: string | null;
  unpricedTokens: number;
  hasUnpriced: boolean;
}

/**
 * Thin wrapper around the server-computed range totals (`totalCostUsd`/`unpricedTokens`) — no
 * recomputation from rows, the daemon already aggregated them (docs/token-usage.md, "Cost").
 */
export function buildTokenUsageCostSummary(
  breakdown: Pick<TokenUsageBreakdown, "totalCostUsd" | "unpricedTokens">,
): TokenUsageCostSummary {
  const totalCostUsd = breakdown.totalCostUsd ?? null;
  const unpricedTokens = breakdown.unpricedTokens ?? 0;
  const hasUnpriced = unpricedTokens > 0;
  return {
    totalCostUsd,
    formattedTotal: formatCostOrNull(totalCostUsd, hasUnpriced),
    unpricedTokens,
    hasUnpriced,
  };
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
