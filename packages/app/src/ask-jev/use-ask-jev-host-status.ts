import { useCallback } from "react";
import type { JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

// A key added to the host's env file is read within five seconds, so this beat is what flips the
// screen from "not configured" to ready without reopening it.
export const ASK_JEV_STATUS_POLL_MS = 15 * 1000;

export function askJevStatusQueryKey(serverId: string | null) {
  return ["askJevStatus", serverId ?? ""] as const;
}

export interface AskJevHostStatus {
  connected: boolean;
  supportsAsk: boolean;
  status: JevStatus | undefined;
  statusFailed: boolean;
}

/**
 * The selected host's side of Ask JEV: connection, the `jevAsk` capability, and `jev.status`.
 * Gated on `server_info.features.jevAsk`; an older host never gets the request.
 */
export function useAskJevHostStatus(
  serverId: string | null,
  options: { enabled: boolean },
): AskJevHostStatus {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsAsk = useHostFeature(serverId, "jevAsk");
  const enabled = Boolean(options.enabled && serverId && client && connected && supportsAsk);

  const queryFn = useCallback(async () => {
    // Unreachable in practice: the query is only enabled while a client exists.
    if (!client) throw new Error("JEV status requested without a host client");
    return (await client.jevStatus()).status;
  }, [client]);

  const query = useFetchQuery({
    queryKey: askJevStatusQueryKey(serverId),
    dataShape: "value",
    staleTimeMs: ASK_JEV_STATUS_POLL_MS,
    queryFn,
    enabled,
    refetchInterval: ASK_JEV_STATUS_POLL_MS,
  });

  return {
    connected,
    supportsAsk,
    status: enabled ? query.data : undefined,
    statusFailed: enabled && query.isError,
  };
}
