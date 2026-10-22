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
} from "./use-data";
import { prPaneTimelineByIdentityQueryKey } from "./query-keys";
import {
  STATUS_STALE_TIME_MS,
  useForgeStatusByIdentity,
  type PullRequestIdentity,
} from "./use-forge-status-by-identity";

export type { PullRequestIdentity } from "./use-forge-status-by-identity";
export { isUnsupportedForgeStatusError } from "./use-forge-status-by-identity";

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
}: UsePrPaneDataByIdentityOptions): UsePrPaneDataResult & {
  unsupportedForge: boolean;
  refetch: () => void;
} {
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
    // A finite stale time (matching the status cadence) rather than treating the page as
    // immutable forever — new timeline activity (comments, reviews) should surface on remount.
    staleTimeMs: STATUS_STALE_TIME_MS,
    // A distinct kind from the cwd-scoped hook's prPaneTimelineQueryKey, keyed by forge identity
    // rather than cwd: two different repos never collide just because their creating agents
    // happened to share a cwd value.
    queryKey: useMemo(
      () =>
        prPaneTimelineByIdentityQueryKey({
          serverId,
          host: identity.host,
          repoOwner: identity.repoOwner,
          repoName: identity.repoName,
          number: identity.number,
        }),
      [serverId, identity.host, identity.repoOwner, identity.repoName, identity.number],
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
      statusPayloadError: statusResult.payloadError,
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
    refetch: statusResult.refetch,
  };
}
