import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useFetchQuery } from "@/data/query";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";

export type { PullRequestLedgerEntry };

/** 60s while the tab is open, per docs/explorer-sidebar.md's refresh cadence. */
const REFETCH_INTERVAL_MS = 60_000;

export const pullRequestsListQueryKind = "pullRequestsList";

export function pullRequestsListQueryKey(serverId: string, workspaceId: string) {
  return [pullRequestsListQueryKind, serverId, workspaceId] as const;
}

export interface UsePullRequestsOptions {
  serverId: string;
  workspaceId: string | null | undefined;
  enabled?: boolean;
}

export interface UsePullRequestsResult {
  pullRequests: PullRequestLedgerEntry[];
  isSupported: boolean;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

/** Every PR a workspace's agent or its descendants created. See docs/pull-request-ledger.md. */
export function usePullRequests({
  serverId,
  workspaceId,
  enabled = true,
}: UsePullRequestsOptions): UsePullRequestsResult {
  const { t } = useTranslation();
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "pullRequestLedger");
  const trimmedWorkspaceId = workspaceId?.trim() ?? "";
  const queryEnabled =
    enabled && isSupported && !!daemonClient && isConnected && trimmedWorkspaceId.length > 0;

  const query = useFetchQuery({
    dataShape: "list",
    staleTimeMs: 30_000,
    queryKey: pullRequestsListQueryKey(serverId, trimmedWorkspaceId),
    queryFn: async () => {
      if (!daemonClient) throw new Error(t("common.errors.daemonClientUnavailable"));
      return daemonClient.workspacePullRequestsList(trimmedWorkspaceId);
    },
    enabled: queryEnabled,
    refetchInterval: queryEnabled ? REFETCH_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
  });

  return {
    pullRequests: query.data?.pullRequests ?? [],
    isSupported,
    isLoading: queryEnabled && query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error : null,
  };
}
