import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { AgentContextUsagePayload } from "./context-meter-model";

// The daemon captures a watched agent shortly after each turn ends, and answers from its cache
// otherwise. Asking again on this beat while the popover is open is what lets that capture appear
// without reopening it. A turn can end between two polls, so the poll does not stop at idle.
export const AGENT_CONTEXT_USAGE_POLL_MS = 15 * 1000;

// Every open of the popover asks again; the daemon answers from its cache when nothing changed.
const AGENT_CONTEXT_USAGE_STALE_TIME_MS = 5 * 1000;

export function agentContextUsageQueryKey(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return ["agentContextUsage", serverId ?? "", agentId ?? ""] as const;
}

/**
 * What an agent's context window is made of, read while the popover is open. Gated on
 * `server_info.features.agentContextUsage`; an older daemon yields `data: undefined` and the
 * meter keeps its total-only tooltip rather than showing an error.
 */
export function useAgentContextUsage(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
  options: { enabled?: boolean } = {},
): { data: AgentContextUsagePayload | undefined; isSupported: boolean; isLoading: boolean } {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.agentContextUsage === true,
  );
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && agentId && client && isConnected && isSupported,
  );

  const queryFn = useCallback(async () => {
    // Unreachable in practice: the query is only enabled while a client and an agent exist, and
    // nothing renders this message.
    if (!client || !agentId) throw new Error("context usage requested without a host client");
    return client.readAgentContextUsage(agentId);
  }, [agentId, client]);

  const query = useFetchQuery({
    queryKey: agentContextUsageQueryKey(serverId, agentId),
    dataShape: "value",
    staleTimeMs: AGENT_CONTEXT_USAGE_STALE_TIME_MS,
    queryFn,
    enabled,
    refetchInterval: AGENT_CONTEXT_USAGE_POLL_MS,
  });

  return { data: query.data, isSupported, isLoading: enabled && query.isPending };
}
