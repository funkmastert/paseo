import { useCallback, useMemo } from "react";
import { createFakeJevSavingsReader } from "@/jev/fake-jev-savings-reader";
import type { JevSavingsRange, JevSavingsSummary } from "@/jev/jev-savings-types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

/** Polled while the dashboard is focused (docs/jev.md, "The JEV dashboard"). */
export const JEV_SAVINGS_SUMMARY_POLL_MS = 30 * 1000;

export function jevSavingsSummaryQueryKey(
  serverId: string | null | undefined,
  range: JevSavingsRange,
) {
  return ["jevSavingsSummary", serverId ?? "", range] as const;
}

/**
 * `jev.savings.summary` for a range. The savings track's seam already landed a real
 * `DaemonClient.jevSavingsSummary`, but its handler is `JevService.savings`'s drop-everything sink
 * until the ledger merges — so this reads a local fake until then (`fake-jev-savings-reader.ts`);
 * swap the `queryFn` for a client call at that point, same shape.
 */
export function useJevSavingsSummary(
  serverId: string | null | undefined,
  range: JevSavingsRange,
  options: { enabled?: boolean } = {},
): { data: JevSavingsSummary | undefined; isLoading: boolean; isSupported: boolean } {
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "jevSavings");
  const reader = useMemo(() => createFakeJevSavingsReader(), []);
  const enabled = Boolean((options.enabled ?? true) && serverId && isConnected && isSupported);

  const queryFn = useCallback(() => reader.summary(range), [reader, range]);

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
