import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RestartRecoveryPlan } from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useMcpStatusActiveServerId } from "@/mcp-status/use-mcp-status";
import { buildRestartRecoveryStripModel, type RestartRecoveryStripModel } from "./model";

export interface UseRestartRecoveryResult {
  model: RestartRecoveryStripModel | null;
  resumeAll: () => void;
  dismissAll: () => void;
  busy: boolean;
  error: string | null;
}

/**
 * Restart recovery's plan for the active host (docs/restart-recovery.md). The plan only changes
 * when this host restarts or someone acts on it, so it is fetched, not pushed.
 */
export function useRestartRecovery(): UseRestartRecoveryResult {
  const serverId = useMcpStatusActiveServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(restartRecovery): added in v0.8.x, remove gate after 2027-09-23.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.restartRecovery === true,
  );
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["restartRecovery", serverId], [serverId]);

  const planQuery = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 30_000,
    enabled: Boolean(serverId && client && isConnected && supported),
    queryFn: async (): Promise<RestartRecoveryPlan> => {
      if (!client) throw new Error("The host client is unavailable.");
      return client.getRestartRecoveryPlan();
    },
    retry: false,
  });

  const action = useMutation({
    mutationFn: async (kind: "apply" | "dismiss"): Promise<RestartRecoveryPlan> => {
      if (!client) throw new Error("The host client is unavailable.");
      return kind === "apply" ? client.applyRestartRecovery() : client.dismissRestartRecovery();
    },
    onSuccess: (plan) => queryClient.setQueryData(queryKey, plan),
  });

  const model = useMemo(() => buildRestartRecoveryStripModel(planQuery.data), [planQuery.data]);

  return {
    model: supported ? model : null,
    resumeAll: () => action.mutate("apply"),
    dismissAll: () => action.mutate("dismiss"),
    busy: action.isPending,
    error: action.error ? action.error.message : null,
  };
}
