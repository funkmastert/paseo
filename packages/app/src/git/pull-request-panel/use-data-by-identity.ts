import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { PullRequestTimelineResponse } from "@getpaseo/protocol/messages";
import { normalizeForge, type Forge } from "@/git/forge";
import { useFetchQuery } from "@/data/query";
import {
  createInMemoryUnsupportedTimelineRegistry,
  fetchPrPaneTimelinePage,
  selectPrPaneState,
  shouldFetchTimelineFrom,
  unsupportedTimelineKey,
  type UsePrPaneDataResult,
} from "./use-data.js";
import { prPaneStatusByIdentityQueryKey, prPaneTimelineQueryKey } from "./query-keys.js";

type PullRequestTimeline = PullRequestTimelineResponse["payload"];

/**
 * A pull request identified explicitly, not derived from a checkout's current branch
 * (docs/pull-request-ledger.md). Feeds the same `PrPaneData` shape `usePrPaneData` does, so
 * `PullRequestPane`/`PullRequestContent` render it unchanged — see KTD6 in the plan.
 */
export interface PullRequestIdentity {
  host: string;
  repoOwner: string;
  repoName: string;
  number: number;
  /** The creating agent's cwd: selects which authenticated CLI context to run from. */
  cwd: string;
}

export interface UsePrPaneDataByIdentityOptions {
  serverId: string;
  identity: PullRequestIdentity;
  enabled?: boolean;
  timelineEnabled?: boolean;
}

const registry = createInMemoryUnsupportedTimelineRegistry();

/** 60s while the row's detail view is open, per docs/explorer-sidebar.md's refresh cadence. */
const STATUS_REFETCH_INTERVAL_MS = 60_000;

/**
 * True when the row's forge has no identity-based status lookup (KTD6's fallback-to-URL
 * forges): either the daemon's own typed error, or an old daemon that doesn't know the RPC at
 * all (`unknown_schema`, same convention as {@link isUnsupportedTimelineError}).
 */
export function isUnsupportedForgeStatusError(input: {
  payloadErrorKind: string | null | undefined;
  queryError: unknown;
}): boolean {
  if (input.payloadErrorKind === "unsupported_forge") return true;
  if (!(input.queryError instanceof Error)) return false;
  const rpcError = input.queryError as Error & { code?: unknown };
  return rpcError.code === "unknown_schema";
}

export function usePrPaneDataByIdentity({
  serverId,
  identity,
  enabled = true,
  timelineEnabled = enabled,
}: UsePrPaneDataByIdentityOptions): UsePrPaneDataResult & { unsupportedForge: boolean } {
  const { t } = useTranslation();
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const statusQuery = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: prPaneStatusByIdentityQueryKey({ serverId, ...identity }),
    queryFn: async () => {
      if (!daemonClient) throw new Error(t("common.errors.daemonClientUnavailable"));
      return daemonClient.checkoutForgeGetPullRequestStatus(identity);
    },
    enabled: !!daemonClient && isConnected && enabled,
    refetchInterval: enabled ? STATUS_REFETCH_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
  });

  const unsupportedForge = isUnsupportedForgeStatusError({
    payloadErrorKind: statusQuery.data?.error?.kind,
    queryError: statusQuery.error,
  });

  const status = statusQuery.data?.status ?? null;
  const forge: Forge = normalizeForge(status?.forge);
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
      status,
      statusPayloadError: null,
      statusError: statusQuery.error instanceof Error ? statusQuery.error : null,
      statusIsLoading: statusQuery.isLoading,
      statusIsFetching: statusQuery.isFetching,
      githubFeaturesEnabled: true,
      forge,
      timelineEnabled,
      shouldFetchTimeline,
      timelinePayload: timelineQuery.data,
      timelineError: timelineQuery.error,
      timelineIsLoading: timelineQuery.isLoading,
      timelineIsFetching: timelineQuery.isFetching,
    }),
    unsupportedForge,
  };
}
