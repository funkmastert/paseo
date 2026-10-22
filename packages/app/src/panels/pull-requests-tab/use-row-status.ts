import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useFetchQuery } from "@/data/query";
import { normalizeForge, type Forge } from "@/git/forge";
import { prPaneStatusByIdentityQueryKey } from "@/git/pull-request-panel/query-keys";
import { isUnsupportedForgeStatusError } from "@/git/pull-request-panel/use-data-by-identity";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";

/** 60s while the row is visible, same cadence as the detail view. */
const REFETCH_INTERVAL_MS = 60_000;

export interface RowPullRequestStatus {
  state: "open" | "merged" | "closed";
  checksStatus: string | undefined;
  reviewDecision: string | null | undefined;
  forge: Forge;
  unsupportedForge: boolean;
  isLoading: boolean;
}

function resolveRowState(
  status: { isMerged: boolean; state: string } | null,
): RowPullRequestStatus["state"] {
  if (status?.isMerged) return "merged";
  if (status?.state === "open") return "open";
  return "closed";
}

/** A row's live status, fetched independently of its detail view (no timeline fetch) so a long
 * list doesn't pay for content nobody has drilled into. See docs/pull-request-ledger.md. */
export function useRowPullRequestStatus({
  serverId,
  entry,
  enabled,
}: {
  serverId: string;
  entry: PullRequestLedgerEntry;
  enabled: boolean;
}): RowPullRequestStatus {
  const { t } = useTranslation();
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryEnabled = enabled && !!daemonClient && isConnected;

  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: prPaneStatusByIdentityQueryKey({
      serverId,
      host: entry.host,
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      number: entry.number,
    }),
    queryFn: async () => {
      if (!daemonClient) throw new Error(t("common.errors.daemonClientUnavailable"));
      return daemonClient.checkoutForgeGetPullRequestStatus({
        cwd: entry.creatingAgentCwd,
        host: entry.host,
        repoOwner: entry.repoOwner,
        repoName: entry.repoName,
        number: entry.number,
      });
    },
    enabled: queryEnabled,
    refetchInterval: queryEnabled ? REFETCH_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
  });

  const unsupportedForge = isUnsupportedForgeStatusError({
    payloadErrorKind: query.data?.error?.kind,
    queryError: query.error,
  });
  const status = query.data?.status ?? null;
  const state = resolveRowState(status);

  return {
    state,
    checksStatus: status?.checksStatus,
    reviewDecision: status?.reviewDecision,
    forge: normalizeForge(status?.forge ?? entry.forge),
    unsupportedForge,
    isLoading: queryEnabled && query.isLoading,
  };
}
