import { useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { QueryKey } from "@tanstack/react-query";
import type { McpGatewayAuthStartPayload } from "@getpaseo/client/internal/daemon-client";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  buildMcpStatusStripModel,
  type McpStatusSessionReport,
  type McpStatusServerEntry,
  type McpStatusStripModel,
} from "./mcp-status-strip-model";

export interface McpStatusPayload {
  servers: McpStatusServerEntry[];
  generatedAt: string;
}

export function mcpStatusQueryKey(serverId: string | null): QueryKey {
  return ["mcpStatus", serverId ?? ""];
}

/**
 * Resolves the "active host" the strip scopes to (KTD10: host-scoped in v1, aggregation
 * deferred). Mirrors settings-screen.tsx's host resolution with no picker selection of its
 * own: the connected local daemon, else the first connected host.
 */
export function useMcpStatusActiveServerId(): string | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId,
        hosts,
        orderedHosts,
      }),
    [localServerId, hosts, orderedHosts],
  );
}

function agentLabelFallback(title: string | null, fallback: string): string {
  const trimmed = title?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Session reports (KTD8) for the host: unhealthy per-agent init statuses, independent of
 * whether the daemon's gateway (mcp_status_update) knows about that server at all (AE3). */
function useMcpStatusSessionReports(
  serverId: string | null,
  fallbackAgentLabel: string,
): McpStatusSessionReport[] {
  const agents = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.agents ?? null) : null,
  );

  return useMemo(() => {
    if (!agents) return [];
    const reports: McpStatusSessionReport[] = [];
    for (const agent of agents.values()) {
      if (!agent.mcpServerStatuses?.length) continue;
      const agentLabel = agentLabelFallback(agent.title, fallbackAgentLabel);
      for (const status of agent.mcpServerStatuses) {
        reports.push({
          agentId: agent.id,
          agentLabel,
          serverName: status.name,
          status: status.status,
        });
      }
    }
    return reports;
  }, [agents, fallbackAgentLabel]);
}

export interface UseMcpStatusResult {
  serverId: string | null;
  /** False on an old daemon (no `server_info.features.mcpStatus`) — the strip renders nothing. */
  supportsMcpStatus: boolean;
  model: McpStatusStripModel;
  /** Starts interactive OAuth for one server (U6), then opens the returned URL. Resolves with
   * the RPC's `error` field (not a throw) on a known failure — the caller surfaces it inline. */
  startAuth: (name: string) => Promise<McpGatewayAuthStartPayload>;
  isStartingAuth: boolean;
}

export function useMcpStatus(): UseMcpStatusResult {
  const { t } = useTranslation();
  const serverId = useMcpStatusActiveServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsMcpStatus = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.mcpStatus === true,
  );

  const statusQuery = useReplicaQuery<McpStatusPayload>({
    queryKey: mcpStatusQueryKey(serverId),
    pushEvent: "mcp_status_update",
    enabled: Boolean(serverId && supportsMcpStatus && isConnected),
  });

  const sessionReports = useMcpStatusSessionReports(serverId, t("agentList.fallbackTitle"));

  const model = useMemo(
    () =>
      buildMcpStatusStripModel({
        servers: statusQuery.data?.servers ?? [],
        sessionReports,
      }),
    [statusQuery.data, sessionReports],
  );

  const startAuthMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.startMcpGatewayAuth(name);
      if (result.authorizationUrl) {
        await openExternalUrl(result.authorizationUrl);
      }
      return result;
    },
  });

  const startAuth = useCallback(
    (name: string) => startAuthMutation.mutateAsync(name),
    [startAuthMutation],
  );

  return {
    serverId,
    supportsMcpStatus,
    model,
    startAuth,
    isStartingAuth: startAuthMutation.isPending,
  };
}
