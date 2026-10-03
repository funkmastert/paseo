import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { QueryKey } from "@tanstack/react-query";
import type {
  McpGatewayAuthStartPayload,
  McpGatewayServerAdoptPayload,
} from "@getpaseo/client/internal/daemon-client";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  buildMcpStatusStripModel,
  type McpStatusActionFailure,
  type McpStatusRowStatusKey,
  type McpStatusSessionReport,
  type McpStatusServerEntry,
  type McpStatusStripModel,
} from "./mcp-status-strip-model";

export interface McpStatusPayload {
  servers: McpStatusServerEntry[];
  generatedAt: string;
}

/** Where a claude.ai connector gets authorized — the daemon cannot broker those. */
export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/settings/connectors";

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
  // Select only the agents that carry init-reported statuses. The store copies the agents
  // Map on every agent update but reuses untouched agent objects, so useShallow keeps
  // unrelated agent churn (turns, titles, activity) from re-deriving reports for this
  // always-mounted strip — the selection only changes when a reporting agent itself does.
  const reportingAgents = useSessionStore(
    useShallow((state) => {
      const agents = serverId ? state.sessions[serverId]?.agents : undefined;
      if (!agents) return [];
      return Array.from(agents.values()).filter(
        (agent) => (agent.mcpServerStatuses?.length ?? 0) > 0,
      );
    }),
  );

  return useMemo(() => {
    const reports: McpStatusSessionReport[] = [];
    for (const agent of reportingAgents) {
      const agentLabel = agentLabelFallback(agent.title, fallbackAgentLabel);
      for (const status of agent.mcpServerStatuses ?? []) {
        reports.push({
          agentId: agent.id,
          agentLabel,
          provider: agent.provider,
          serverName: status.name,
          status: status.status,
        });
      }
    }
    return reports;
  }, [reportingAgents, fallbackAgentLabel]);
}

export interface UseMcpStatusResult {
  serverId: string | null;
  /** False on an old daemon (no `server_info.features.mcpStatus`) — the strip renders nothing. */
  supportsMcpStatus: boolean;
  model: McpStatusStripModel;
  /** Starts interactive OAuth for one server (U6), then opens the returned URL. The RPC resolves
   * with an `error` field rather than throwing, so the failure is recorded onto the row here. */
  startAuth: (name: string) => Promise<McpGatewayAuthStartPayload>;
  /** Brokers a session-reported server through the daemon (reading the reporting agent's MCP
   * config), then opens the sign-in URL if one comes back. Same non-throwing contract. */
  adoptServer: (name: string, agentId: string) => Promise<McpGatewayServerAdoptPayload>;
  /** Opens claude.ai's connector settings — the only place claude.ai connectors get authorized. */
  openClaudeAiConnectors: () => Promise<void>;
  /** True while either the auth or the adopt mutation is in flight. */
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
  // COMPAT(mcpGatewayAdopt): added in v0.8.1, remove gate after 2027-03-14.
  const supportsAdopt = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.mcpGatewayAdopt === true,
  );

  const statusQuery = useReplicaQuery<McpStatusPayload>({
    queryKey: mcpStatusQueryKey(serverId),
    pushEvent: "mcp_status_update",
    enabled: Boolean(serverId && supportsMcpStatus && isConnected),
  });

  const sessionReports = useMcpStatusSessionReports(serverId, t("agentList.fallbackTitle"));

  // Per-row record of the last failed action. The auth and adopt RPCs resolve with an `error`
  // field for known failures rather than rejecting, so the mutations' own error state never
  // fires for them and the row has to keep the answer itself.
  const [failures, setFailures] = useState<Record<string, McpStatusActionFailure>>({});
  const clearFailure = useCallback((name: string) => {
    setFailures((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const model = useMemo(
    () =>
      buildMcpStatusStripModel({
        servers: statusQuery.data?.servers ?? [],
        sessionReports,
        canAdopt: supportsAdopt,
        failures,
      }),
    [statusQuery.data, sessionReports, supportsAdopt, failures],
  );

  // Drop a row's recorded failure once the daemon's own view of that server moves on: a fresh
  // mcp_status_update means the state changed independently of whether anyone retried, and a
  // stale explanation under a new status would also keep the row's action withdrawn.
  const rowStatusByNameRef = useRef<Record<string, McpStatusRowStatusKey>>({});
  useEffect(() => {
    const previousStatusByName = rowStatusByNameRef.current;
    const nextStatusByName: Record<string, McpStatusRowStatusKey> = {};
    const namesWithChangedStatus: string[] = [];
    for (const row of model.rows) {
      nextStatusByName[row.name] = row.statusKey;
      const previous = previousStatusByName[row.name];
      if (previous !== undefined && previous !== row.statusKey) {
        namesWithChangedStatus.push(row.name);
      }
    }
    rowStatusByNameRef.current = nextStatusByName;
    if (namesWithChangedStatus.length === 0) return;
    setFailures((prev) => {
      let next: Record<string, McpStatusActionFailure> | undefined;
      for (const name of namesWithChangedStatus) {
        if (name in prev) {
          next ??= { ...prev };
          delete next[name];
        }
      }
      return next ?? prev;
    });
  }, [model.rows]);

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
    async (name: string) => {
      clearFailure(name);
      const result = await startAuthMutation.mutateAsync(name);
      if (result.error && !result.authorizationUrl) {
        setFailures((prev) => ({
          ...prev,
          [name]: {
            reason: result.reason ?? null,
            remedyCommand: result.remedyCommand ?? null,
            remedyPath: result.remedyPath ?? null,
            remedyRedirectUrl: result.remedyRedirectUrl ?? null,
            error: result.error ?? "",
          },
        }));
      }
      return result;
    },
    [clearFailure, startAuthMutation],
  );

  const adoptMutation = useMutation({
    mutationFn: async (input: { name: string; agentId: string }) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.adoptMcpGatewayServer(input.name, input.agentId);
      if (result.authorizationUrl) {
        await openExternalUrl(result.authorizationUrl);
      }
      return result;
    },
  });

  const adoptServer = useCallback(
    async (name: string, agentId: string) => {
      clearFailure(name);
      const result = await adoptMutation.mutateAsync({ name, agentId });
      if (result.error && !result.authorizationUrl) {
        setFailures((prev) => ({
          ...prev,
          [name]: {
            reason: result.reason ?? null,
            remedyCommand: result.remedyCommand ?? null,
            remedyPath: result.remedyPath ?? null,
            remedyRedirectUrl: result.remedyRedirectUrl ?? null,
            error: result.error ?? "",
          },
        }));
      }
      return result;
    },
    [adoptMutation, clearFailure],
  );

  const openClaudeAiConnectors = useCallback(async () => {
    await openExternalUrl(CLAUDE_AI_CONNECTORS_URL);
  }, []);

  return {
    serverId,
    supportsMcpStatus,
    model,
    startAuth,
    adoptServer,
    openClaudeAiConnectors,
    isStartingAuth: startAuthMutation.isPending || adoptMutation.isPending,
  };
}
