import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InboxActVerb } from "@getpaseo/protocol/coordination/rpc-schemas";
import {
  fetchAggregatedInbox,
  inboxQueryBaseKey,
  type InboxHostError,
  type InboxHostInput,
} from "@/inbox/aggregated-inbox";
import type { AggregatedStreamEntry, AggregatedWorkItem } from "@/inbox/model";
import { selectHumanRequests } from "@/inbox/model";
import { useFetchQuery } from "@/data/query";
import { useHostFeatureMap } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";

export type { InboxHostError } from "@/inbox/aggregated-inbox";

export type InboxLoadState =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; requests: AggregatedWorkItem[]; updates: AggregatedStreamEntry[] };

export function inboxQueryKey(serverIds: readonly string[]) {
  return [...inboxQueryBaseKey, [...serverIds].sort().join("|")] as const;
}

export interface UseInboxResult {
  loadState: InboxLoadState;
  hostErrors: InboxHostError[];
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

/** Hosts that advertise `server_info.features.coordinationQueue`: the Inbox is hidden for the
 * rest, per docs/work-queue.md ("Off means ... every `coordination.*` request answered as
 * disabled"). */
export function useInboxCapableHosts(): InboxHostInput[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const featureMap = useHostFeatureMap(serverIds, "coordinationQueue");
  return useMemo(
    () =>
      hosts
        .filter((host) => featureMap.get(host.serverId) === true)
        .map((host) => ({ serverId: host.serverId, serverName: host.label })),
    [hosts, featureMap],
  );
}

export function useInbox(): UseInboxResult {
  const runtime = getHostRuntimeStore();
  const hostInputs = useInboxCapableHosts();
  const serverIds = useMemo(() => hostInputs.map((host) => host.serverId), [hostInputs]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );

  const query = useFetchQuery({
    queryKey: [...inboxQueryKey(serverIds), connectionStatusKey],
    queryFn: () => fetchAggregatedInbox({ hosts: hostInputs, runtime }),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: InboxLoadState;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", requests: query.data.requests, updates: query.data.updates };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    hostErrors: query.data?.status === "loaded" ? query.data.hostErrors : [],
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}

/** For the sidebar badge: open human requests across every coordination-capable host. Shares
 * the Inbox query's cache key, so it never issues a second fetch while the screen is open. */
export function useInboxOpenRequestsCount(): number {
  const { loadState } = useInbox();
  if (loadState.status !== "loaded") {
    return 0;
  }
  return selectHumanRequests(loadState.requests).length;
}

export interface InboxActVariables {
  serverId: string;
  id: string;
  verb: InboxActVerb;
  note?: string;
  to?: string;
}

/** Applies one Inbox verb (docs/work-queue.md#inbox) and refreshes every Inbox query on success. */
export function useInboxAct() {
  const runtime = getHostRuntimeStore();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: InboxActVariables) => {
      const client = runtime.getClient(variables.serverId);
      if (!client) {
        throw new Error("This host is not connected.");
      }
      const result = await client.coordinationInboxAct({
        id: variables.id,
        verb: variables.verb,
        ...(variables.note !== undefined ? { note: variables.note } : {}),
        ...(variables.to !== undefined ? { to: variables.to } : {}),
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxQueryBaseKey });
    },
  });
}
