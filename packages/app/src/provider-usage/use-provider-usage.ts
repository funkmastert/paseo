import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

type ProviderUsageClient = Pick<DaemonClient, "listProviderUsage">;

export function providerUsageQueryKey(serverId: string | null | undefined) {
  return ["providerUsage", serverId ?? ""] as const;
}

async function fetchProviderUsage(client: ProviderUsageClient): Promise<ProviderUsageListPayload> {
  return client.listProviderUsage();
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  /** Polling interval in ms. Omit to keep the default no-polling behavior. */
  refetchInterval?: number;
  /**
   * Catch up when the window comes back or the host reconnects. React Query skips a polling tick
   * while the document is hidden and never backfills the ones it skipped, so a polled surface
   * that does not opt in shows whatever it last fetched before the window went away — which is
   * exactly what the user is looking at the moment they come back to it. Off by default to keep
   * the unpolled callers unchanged.
   */
  catchUpOnFocus?: boolean;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const queryClient = useQueryClient();
  const catchUpOnFocus = options.catchUpOnFocus ?? false;
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const queryKey = useMemo(() => providerUsageQueryKey(serverId), [serverId]);
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const queryFn = useCallback(async () => {
    if (!client) {
      throw new Error(providerUsageCopy.clientUnavailable);
    }
    return fetchProviderUsage(client);
  }, [client]);

  const query = useQuery({
    queryKey,
    queryFn,
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: catchUpOnFocus,
    refetchOnWindowFocus: catchUpOnFocus,
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.fetchQuery({
      queryKey,
      queryFn,
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, queryClient, queryFn, queryKey]);

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: providerUsageCopy.hostUnavailable };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: providerUsageCopy.hostUpgradeRequired };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
        fetchedAt: query.dataUpdatedAt,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.dataUpdatedAt,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
  ]);

  return { view, refresh, canFetch };
}
