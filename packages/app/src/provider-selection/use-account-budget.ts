import { useMemo } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolveAccountPool } from "@/orchestration/account-budget-strip-model";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { AccountBudget } from "./account-budget";

/**
 * The pooled accounts and their usage, read through the same query the orchestration budget
 * strip polls, so a composer opened within the usage cache's stale time costs no extra fetch.
 * Null until usage has loaded, and on a host that declares no account pool.
 */
export function useAccountBudget(
  serverId: string | null,
  options: { enabled: boolean },
): AccountBudget | null {
  const { config } = useDaemonConfig(options.enabled ? serverId : null);
  const pool = useMemo(() => resolveAccountPool(config?.providers), [config]);
  const { view } = useProviderUsage(serverId, { enabled: options.enabled && pool.length > 0 });
  const payload = view.kind === "ready" ? view.payload : null;
  return useMemo(
    () => (pool.length > 0 && payload ? { pool, usage: payload.providers } : null),
    [payload, pool],
  );
}
