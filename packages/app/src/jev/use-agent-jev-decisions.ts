import { useCallback } from "react";
import type { JevDecisionRecord, JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// A decision is recorded when the daemon asks, at no fixed beat; asking again on this beat while
// the popover is open is what lets a new one appear without reopening it.
export const AGENT_JEV_DECISIONS_POLL_MS = 15 * 1000;

const AGENT_JEV_DECISIONS_STALE_TIME_MS = 5 * 1000;

export function agentJevDecisionsQueryKey(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
) {
  return ["agentJevDecisions", serverId ?? "", agentId ?? ""] as const;
}

export interface AgentJevDecisions {
  decisions: JevDecisionRecord[];
  /** Says which features are in shadow, so a decision that was not applied reads as shadow. */
  status: JevStatus | null;
}

/**
 * The agent's JEV decisions, newest first, read while the popover is open. Gated on
 * `server_info.features.jev`: an older daemon is never asked and the section stays absent. They
 * come from the daemon's decision store, never the timeline (docs/jev.md, "Decision store").
 */
export function useAgentJevDecisions(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
  options: { enabled?: boolean } = {},
): { data: AgentJevDecisions | undefined; isSupported: boolean } {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "jev");
  const enabled = Boolean(
    (options.enabled ?? true) && serverId && agentId && client && isConnected && isSupported,
  );

  const queryFn = useCallback(async (): Promise<AgentJevDecisions> => {
    // Unreachable in practice: the query is only enabled while a client and an agent exist.
    if (!client || !agentId) throw new Error("JEV decisions requested without a host client");
    const [list, status] = await Promise.all([
      client.listJevDecisions(agentId),
      // The list stands without the status: a failed read only loses the shadow wording.
      client.jevStatus().then(
        (payload) => payload.status,
        () => null,
      ),
    ]);
    return { decisions: list.decisions, status };
  }, [agentId, client]);

  const query = useFetchQuery({
    queryKey: agentJevDecisionsQueryKey(serverId, agentId),
    dataShape: "value",
    staleTimeMs: AGENT_JEV_DECISIONS_STALE_TIME_MS,
    queryFn,
    enabled,
    refetchInterval: AGENT_JEV_DECISIONS_POLL_MS,
  });

  return { data: enabled ? query.data : undefined, isSupported };
}
