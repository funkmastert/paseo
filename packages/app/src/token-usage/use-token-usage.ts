import { useCallback } from "react";
import type { TokenUsageRange } from "@getpaseo/protocol/token-usage/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { TokenUsageBreakdown } from "./token-usage-model";

// The daemon sweeps every 15-60s (docs/token-usage.md); polling faster than that only re-reads
// what the last sweep already wrote.
export const TOKEN_USAGE_STALE_TIME_MS = 60 * 1000;

export function tokenUsageQueryKey(serverId: string | null | undefined, range: TokenUsageRange) {
  return ["tokenUsage", serverId ?? "", range] as const;
}

/**
 * The daemon's token usage breakdown for a range. Gated on `server_info.features.tokenUsage`; an
 * older daemon yields `data: undefined` and the screen shows nothing rather than an error.
 */
export function useTokenUsage(
  serverId: string | null | undefined,
  range: TokenUsageRange,
  options: { enabled?: boolean } = {},
): { data: TokenUsageBreakdown | undefined; isLoading: boolean; isSupported: boolean } {
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
  });

  return { data: query.data, isLoading: query.isLoading, isSupported };
}
