import { useCallback, useMemo } from "react";
import { router } from "expo-router";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { earliestProjectedCap } from "@/usage-history/account-cap-projection";
import { useUsageHistory } from "@/usage-history/use-usage-history";
import { buildJevDashboardRoute } from "@/utils/host-routes";
import {
  buildAccountBudgetRows,
  resolveAccountPool,
  resolveBudgetProviderIds,
  resolveHostClaudeAccountIds,
  resolveOtherAccountIds,
  type AccountUsageCount,
} from "./account-budget-strip-model";
import { AccountBudgetStripView } from "./account-budget-strip-view";

// Server caches usage for 5min; polling faster than that just re-serves the cache, so
// this stays well under that ceiling without hammering the daemon.
export const DEFAULT_REFETCH_INTERVAL_MS = 75_000;

const NO_USAGE: ReadonlyMap<string, AccountUsageCount> = new Map();

export function AccountBudgetStrip({
  serverId,
  usage = NO_USAGE,
  refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS,
}: {
  serverId: string;
  /** Running leaders and workers per account, measured over this tab's own tree. */
  usage?: ReadonlyMap<string, AccountUsageCount>;
  refetchIntervalMs?: number;
}) {
  const { view } = useProviderUsage(serverId, {
    refetchInterval: refetchIntervalMs,
    catchUpOnFocus: true,
  });
  const { entries } = useProvidersSnapshot(serverId);
  const { config } = useDaemonConfig(serverId);
  const pool = useMemo(() => resolveAccountPool(config?.providers), [config]);
  const { data: history } = useUsageHistory(serverId);

  const rows = useMemo(() => {
    // The account list comes from the pool, or from what the host reports, then every other
    // provider with usage; the tab's tree never
    // decides it. Before the first usage read there is nothing to show; after a failed one the
    // accounts still show, as unavailable.
    if (view.kind === "loading") return [];
    const providers = view.kind === "ready" ? view.payload.providers : [];
    const claudeIds = resolveBudgetProviderIds(
      pool,
      resolveHostClaudeAccountIds(providers, entries),
    );
    const seen = new Set(claudeIds.map((id) => id.toLowerCase()));
    // Every other provider the host reports usage for follows the Claude accounts, so an account
    // outside the pool (the OpenAI one) is on the strip too.
    const otherIds = resolveOtherAccountIds(providers, entries).filter(
      (id) => !seen.has(id.toLowerCase()),
    );
    return buildAccountBudgetRows(providers, [...claudeIds, ...otherIds], entries, {
      pool,
      usage,
    });
  }, [entries, pool, usage, view]);
  const fetchedAt = useMemo(
    () => (view.kind === "ready" ? new Date(view.fetchedAt) : null),
    [view],
  );
  // Time to cap per account, from the usage history: only a window projected to cap before its
  // reset counts. An account with no projection gets no line rather than a guess.
  const capMinutes = useMemo(() => {
    const minutes = new Map<string, number>();
    for (const row of rows) {
      const cap = earliestProjectedCap(history?.accounts ?? [], row.providerId);
      if (cap) minutes.set(row.providerId, cap.minutesToCap);
    }
    return minutes;
  }, [history, rows]);
  const openJevDashboard = useCallback(
    (targetServerId: string) => router.push(buildJevDashboardRoute(targetServerId)),
    [],
  );

  return (
    <AccountBudgetStripView
      rows={rows}
      serverId={serverId}
      fetchedAt={fetchedAt}
      capMinutes={capMinutes}
      onOpenJevDashboard={openJevDashboard}
    />
  );
}
