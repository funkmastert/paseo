import { useCallback } from "react";
import type { JevSavingsRange, JevSavingsSummary } from "@/jev/jev-savings-types";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/** Polled while the dashboard is focused (docs/jev.md, "The JEV dashboard"). */
export const JEV_SAVINGS_SUMMARY_POLL_MS = 30 * 1000;

export function jevSavingsSummaryQueryKey(
  serverId: string | null | undefined,
  range: JevSavingsRange,
) {
  return ["jevSavingsSummary", serverId ?? "", range] as const;
}

/** `jev.savings.summary` for a range, gated on `server_info.features.jevSavings`. */
export function useJevSavingsSummary(
  serverId: string | null | undefined,
  range: JevSavingsRange,
  options: { enabled?: boolean } = {},
): { data: JevSavingsSummary | undefined; isLoading: boolean; isSupported: boolean } {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "jevSavings");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && client && isConnected && isSupported,
  );

  const queryFn = useCallback(async () => {
    if (!client) throw new Error("JEV savings summary requested without a host client");
    return (await client.jevSavingsSummary(range)).summary;
  }, [client, range]);

  const query = useFetchQuery({
    queryKey: jevSavingsSummaryQueryKey(serverId, range),
    dataShape: "value",
    staleTimeMs: JEV_SAVINGS_SUMMARY_POLL_MS,
    queryFn,
    enabled,
    refetchInterval: JEV_SAVINGS_SUMMARY_POLL_MS,
  });

  return { data: query.data, isLoading: enabled && query.isPending, isSupported };
}
