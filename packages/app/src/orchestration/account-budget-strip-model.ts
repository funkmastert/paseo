import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";
import { resolveUsedPct } from "@/provider-usage/format";
import type { ProviderUsage, ProviderUsageWindow } from "@/provider-usage/types";

// The budget strip only ever composes these two windows (session + weekly). Any other
// windows a provider reports (balances, per-model detail rows, etc.) stay out of the
// compact strip and remain visible in the full ProviderUsageCard elsewhere.
const BUDGET_WINDOW_IDS = ["five_hour", "weekly"] as const;

export type AccountBudgetRowViewModel =
  | {
      kind: "available";
      providerId: string;
      label: string;
      windows: ProviderUsageWindow[];
    }
  | {
      kind: "unavailable";
      providerId: string;
      label: string;
    };

// Case-insensitive match against the requested provider ids, mirroring
// provider-usage/tooltip-section.tsx's matchProvider. Order follows `providerIds` so
// callers control row order; ids with no usage entry are silently dropped.
export function filterProviderUsageByIds(
  providers: ProviderUsage[],
  providerIds: string[],
): ProviderUsage[] {
  const rows: ProviderUsage[] = [];
  for (const id of providerIds) {
    const target = id.toLowerCase();
    const match = providers.find((usage) => usage.providerId.toLowerCase() === target);
    if (match) rows.push(match);
  }
  return rows;
}

// Snapshot label wins (it reflects custom-provider configuration); usage.displayName is
// the fallback for accounts the providers snapshot hasn't reported yet.
export function resolveAccountLabel(
  entries: ProviderSnapshotEntry[] | undefined,
  usage: ProviderUsage,
): string {
  const entry = entries?.find((candidate) => candidate.provider === usage.providerId);
  return entry?.label ?? usage.displayName;
}

export function selectBudgetWindows(usage: ProviderUsage): ProviderUsageWindow[] {
  return BUDGET_WINDOW_IDS.flatMap((id) => {
    const window = usage.windows.find((candidate) => candidate.id === id);
    return window ? [window] : [];
  });
}

// serverId-aware icon lookup so custom provider entries (e.g. claude-personal) resolve
// their snapshot icon instead of falling back to the generic Bot glyph. card.tsx's
// ProviderUsageIcon omits serverId; this call path intentionally does not repeat that.
export function resolveAccountIcon(providerId: string, serverId: string): ProviderIconComponent {
  return getProviderIcon(providerId, serverId);
}

export function buildAccountBudgetRows(
  providers: ProviderUsage[],
  providerIds: string[],
  entries: ProviderSnapshotEntry[] | undefined,
): AccountBudgetRowViewModel[] {
  return filterProviderUsageByIds(providers, providerIds).map((usage) => {
    const label = resolveAccountLabel(entries, usage);
    if (usage.status !== "available") {
      return { kind: "unavailable", providerId: usage.providerId, label };
    }
    return {
      kind: "available",
      providerId: usage.providerId,
      label,
      windows: selectBudgetWindows(usage),
    };
  });
}

export interface WorstBudgetWindow {
  row: Extract<AccountBudgetRowViewModel, { kind: "available" }>;
  window: ProviderUsageWindow;
  usedPct: number;
}

/**
 * The one window a collapsed strip has room for: the fullest across every account. It is the
 * number that decides whether to hand more work to that account, so it is the one to show when
 * there is space for a single line. Ties keep account order; a window with no reading cannot be
 * the worst.
 */
export function selectWorstBudgetWindow(rows: AccountBudgetRowViewModel[]): WorstBudgetWindow | null {
  let worst: WorstBudgetWindow | null = null;
  for (const row of rows) {
    if (row.kind !== "available") continue;
    for (const window of row.windows) {
      const usedPct = resolveUsedPct(window);
      if (usedPct == null) continue;
      if (worst === null || usedPct > worst.usedPct) worst = { row, window, usedPct };
    }
  }
  return worst;
}
