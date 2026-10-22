import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { PullRequestTimelineResponse } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import {
  createInMemoryUnsupportedTimelineRegistry,
  fetchPrPaneTimelinePage,
  selectPrPaneState,
  shouldFetchTimelineFrom,
  unsupportedTimelineKey,
  type UsePrPaneDataResult,
} from "./use-data.js";
import { prPaneTimelineQueryKey } from "./query-keys.js";
import {
  useForgeStatusByIdentity,
  type PullRequestIdentity,
} from "./use-forge-status-by-identity.js";

export type { PullRequestIdentity } from "./use-forge-status-by-identity.js";
export { isUnsupportedForgeStatusError } from "./use-forge-status-by-identity.js";

type PullRequestTimeline = PullRequestTimelineResponse["payload"];

export interface UsePrPaneDataByIdentityOptions {
  serverId: string;
  identity: PullRequestIdentity;
  enabled?: boolean;
  timelineEnabled?: boolean;
}

const registry = createInMemoryUnsupportedTimelineRegistry();

/**
 * The PR detail pane's data, keyed by an explicit identity instead of the checkout's current
 * branch (docs/pull-request-ledger.md). Produces the same `PrPaneData` shape `usePrPaneData`
 * does, so `PullRequestPane`/`PullRequestContent` render it unchanged.
 */
export function usePrPaneDataByIdentity({
  serverId,
  identity,
  enabled = true,
  timelineEnabled = enabled,
}: UsePrPaneDataByIdentityOptions): UsePrPaneDataResult & { unsupportedForge: boolean } {
  const { t } = useTranslation();
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const statusResult = useForgeStatusByIdentity({ serverId, identity, enabled });

  const unsupportedKey = unsupportedTimelineKey({
    serverId,
    cwd: identity.cwd,
    prNumber: identity.number,
  });
  const timelineUnsupported = registry.has(unsupportedKey);
  const shouldFetchTimeline = shouldFetchTimelineFrom({
    hasClient: !!daemonClient,
    isConnected,
    timelineEnabled,
    githubFeaturesEnabled: true,
    cwd: identity.cwd,
    identity: {
      prNumber: identity.number,
      repoOwner: identity.repoOwner,
      repoName: identity.repoName,
    },
    timelineUnsupported,
  });

  const timelineQuery = useFetchQuery<PullRequestTimeline>({
    dataShape: "value",
    // Once fetched, a timeline page is treated as immutable (refetch only on explicit
    // invalidation), matching the cwd-derived hook's `staleTime: Infinity`.
    immutableWhen: () => true,
    queryKey: useMemo(
      () => prPaneTimelineQueryKey({ serverId, cwd: identity.cwd, prNumber: identity.number }),
      [serverId, identity.cwd, identity.number],
    ),
    queryFn: async () => {
      if (!daemonClient) throw new Error(t("common.errors.daemonClientUnavailable"));
      return fetchPrPaneTimelinePage({
        client: daemonClient,
        registry,
        serverId,
        cwd: identity.cwd,
        prNumber: identity.number,
        repoOwner: identity.repoOwner,
        repoName: identity.repoName,
      });
    },
    enabled: shouldFetchTimeline,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    ...selectPrPaneState({
      status: statusResult.status,
      statusPayloadError: null,
      statusError: statusResult.error,
      statusIsLoading: statusResult.isLoading,
      statusIsFetching: statusResult.isFetching,
      githubFeaturesEnabled: true,
      forge: statusResult.forge,
      timelineEnabled,
      shouldFetchTimeline,
      timelinePayload: timelineQuery.data,
      timelineError: timelineQuery.error,
      timelineIsLoading: timelineQuery.isLoading,
      timelineIsFetching: timelineQuery.isFetching,
    }),
    unsupportedForge: statusResult.unsupportedForge,
  };
}
