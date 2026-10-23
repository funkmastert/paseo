import { useCallback } from "react";
import type { JevStatus } from "@getpaseo/protocol/jev/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export const JEV_DASHBOARD_STATUS_POLL_MS = 15 * 1000;

export function jevDashboardStatusQueryKey(serverId: string | null) {
  return ["jevDashboardStatus", serverId ?? ""] as const;
}

export interface JevDashboardHostStatus {
  connected: boolean;
  supportsJev: boolean;
  supportsSavings: boolean;
  status: JevStatus | undefined;
}

/**
 * The selected host's `jev.status`, read beside the savings ledger so a host with no key shows
 * its not-configured state above whatever the ledger already holds (docs/jev.md, "The JEV
 * dashboard" → "Gating"). Gated on `server_info.features.jev`, the same as Ask JEV's status read.
 */
export function useJevDashboardHostStatus(serverId: string | null): JevDashboardHostStatus {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsJev = useHostFeature(serverId, "jev");
  const supportsSavings = useHostFeature(serverId, "jevSavings");
  const enabled = Boolean(serverId && client && connected && supportsJev);

  const queryFn = useCallback(async () => {
    if (!client) throw new Error("JEV status requested without a host client");
    return (await client.jevStatus()).status;
  }, [client]);

  const query = useFetchQuery({
    queryKey: jevDashboardStatusQueryKey(serverId),
    dataShape: "value",
    staleTimeMs: JEV_DASHBOARD_STATUS_POLL_MS,
    queryFn,
    enabled,
    refetchInterval: JEV_DASHBOARD_STATUS_POLL_MS,
  });

  return {
    connected,
    supportsJev,
    supportsSavings,
    status: enabled ? query.data : undefined,
  };
}
