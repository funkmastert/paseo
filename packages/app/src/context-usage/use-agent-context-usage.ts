import { useCallback } from "react";
import type { AgentContextUsageReadResponse } from "@getpaseo/protocol/context-usage/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export type AgentContextUsagePayload = AgentContextUsageReadResponse["payload"];

// While a turn runs the breakdown cannot move, and the daemon captures when it ends. Asking again
// on this beat is what lets the turn-end capture appear under an open popover.
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
  const isRunning = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.agents.get(agentId ?? "")?.status === "running",
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
    refetchInterval: isRunning ? AGENT_CONTEXT_USAGE_POLL_MS : false,
  });

  return { data: query.data, isSupported, isLoading: enabled && query.isPending };
}
