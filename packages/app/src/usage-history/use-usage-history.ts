import { useCallback } from "react";
import type { UsageHistoryGetResponse } from "@getpaseo/protocol/usage-history/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export type UsageHistoryPayload = UsageHistoryGetResponse["payload"];

// The daemon records a reading at most every five minutes and spend every minute; polling faster
// than the sweep only re-reads what it already had.
export const USAGE_HISTORY_STALE_TIME_MS = 60 * 1000;

export function usageHistoryQueryKey(serverId: string | null | undefined, agentId?: string | null) {
  return ["usageHistory", serverId ?? "", agentId ?? ""] as const;
}

/**
 * The daemon's usage history: account window projections and, when `agentId` is given, that
 * agent's weighted-token spend. Gated on `server_info.features.usageHistory`; an older daemon
 * yields `data: undefined` and the surface renders nothing rather than an error.
 */
export function useUsageHistory(
  serverId: string | null | undefined,
  options: { agentId?: string | null; enabled?: boolean } = {},
): { data: UsageHistoryPayload | undefined; isSupported: boolean } {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.usageHistory === true,
  );
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && client && isConnected && isSupported,
  );
  const agentId = options.agentId ?? undefined;

  const queryFn = useCallback(async () => {
    // Unreachable in practice: the query is only enabled while a client exists, and nothing
    // renders this message.
    if (!client) throw new Error("usage history requested without a host client");
    return client.getUsageHistory(agentId ? { agentId } : undefined);
  }, [agentId, client]);

  const query = useFetchQuery({
    queryKey: usageHistoryQueryKey(serverId, agentId),
    dataShape: "value",
    staleTimeMs: USAGE_HISTORY_STALE_TIME_MS,
    queryFn,
    enabled,
  });

  return { data: query.data, isSupported };
}
