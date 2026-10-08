import { useCallback } from "react";
import type { TokenUsageRange } from "@getpaseo/protocol/token-usage/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { TokenUsageBreakdown } from "./token-usage-model";

// The daemon sweeps every 15-60s (docs/token-usage.md); polling faster than that only re-reads
// what the last sweep already wrote.
export const TOKEN_USAGE_STALE_TIME_MS = 60 * 1000;

// Matches the daemon's backfill sweep cadence (docs/token-usage.md: "Sweeps run every 15 s while
// the backfill has files left"), so the progress banner advances instead of freezing at its first
// snapshot.
const BACKFILL_POLL_INTERVAL_MS = 15 * 1000;

export function tokenUsageQueryKey(serverId: string | null | undefined, range: TokenUsageRange) {
  return ["tokenUsage", serverId ?? "", range] as const;
}

export function backfillRefetchInterval(data: TokenUsageBreakdown | undefined): number | false {
  const state = data?.coverage.backfill.state;
  return state === "pending" || state === "running" ? BACKFILL_POLL_INTERVAL_MS : false;
}

/**
 * The daemon's token usage breakdown for a range. Gated on `server_info.features.tokenUsage`; an
 * older daemon yields `data: undefined` and the screen shows nothing rather than an error.
 */
export function useTokenUsage(
  serverId: string | null | undefined,
  range: TokenUsageRange,
  options: { enabled?: boolean } = {},
): {
  data: TokenUsageBreakdown | undefined;
  isLoading: boolean;
  isSupported: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "tokenUsage");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && client && isConnected && isSupported,
  );

  const queryFn = useCallback(async () => {
    // Unreachable in practice: the query is only enabled while a client exists, and nothing
    // renders this message.
    if (!client) throw new Error("token usage requested without a host client");
    return client.getTokenUsageBreakdown({ range });
  }, [client, range]);

  const query = useFetchQuery({
    queryKey: tokenUsageQueryKey(serverId, range),
    dataShape: "value",
    staleTimeMs: TOKEN_USAGE_STALE_TIME_MS,
    queryFn,
    enabled,
    refetchInterval: (q) => backfillRefetchInterval(q.state.data),
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    isSupported,
    error: query.error,
    refetch,
  };
}
