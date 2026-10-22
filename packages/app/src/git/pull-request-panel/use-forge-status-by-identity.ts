import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { CheckoutForgeGetPullRequestStatusResponse } from "@getpaseo/protocol/pull-requests/rpc-schemas";
import { normalizeForge, type Forge } from "@/git/forge";
import { useFetchQuery } from "@/data/query";
import { prPaneStatusByIdentityQueryKey } from "./query-keys.js";

export interface PullRequestIdentity {
  host: string;
  repoOwner: string;
  repoName: string;
  number: number;
  /** The creating agent's cwd: selects which authenticated CLI context to run from. */
  cwd: string;
}

type CheckoutForgeStatus = NonNullable<
  CheckoutForgeGetPullRequestStatusResponse["payload"]["status"]
>;

/** 60s while a row or its detail view is visible, per docs/explorer-sidebar.md's refresh cadence. */
const STATUS_REFETCH_INTERVAL_MS = 60_000;
/** Reused briefly so opening a row's detail view right after its own status fetch doesn't repeat
 * the round trip; short enough that live status still reads as live. Exported so the by-identity
 * timeline query reuses the same cadence. */
export const STATUS_STALE_TIME_MS = 10_000;

/** False once a PR reaches a terminal state, or its forge has no identity lookup — merged/closed
 * PRs don't reopen under normal use, and an unsupported forge will never answer. */
export function nextStatusRefetchInterval(input: {
  queryEnabled: boolean;
  status: { isMerged: boolean; state: string } | null | undefined;
  unsupportedForge: boolean;
}): number | false {
  if (!input.queryEnabled || input.unsupportedForge) return false;
  if (input.status && (input.status.isMerged || input.status.state !== "open")) return false;
  return STATUS_REFETCH_INTERVAL_MS;
}

/**
 * True when a PR's forge has no identity-based status lookup: either the daemon's own typed
 * error, or an old daemon that doesn't know the RPC at all (`unknown_schema`), mirroring
 * {@link isUnsupportedTimelineError}'s request-type check so an unrelated in-flight RPC's
 * `unknown_schema` error can't be mistaken for this one's.
 */
export function isUnsupportedForgeStatusError(input: {
  payloadErrorKind: string | null | undefined;
  queryError: unknown;
}): boolean {
  if (input.payloadErrorKind === "unsupported_forge") return true;
  if (!(input.queryError instanceof Error)) return false;
  const rpcError = input.queryError as Error & { code?: unknown; requestType?: unknown };
  return (
    rpcError.code === "unknown_schema" &&
    rpcError.requestType === "checkout.forge.get_pull_request_status.request"
  );
}

export interface ForgeStatusByIdentity {
  status: CheckoutForgeStatus | null;
  forge: Forge;
  unsupportedForge: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  /** The daemon's typed payload error (not_found, failed, rate_limited, ...), excluding
   * unsupported_forge — that case is already surfaced via {@link ForgeStatusByIdentity.unsupportedForge}. */
  payloadError: { message: string } | null;
  /** Manually re-runs the status fetch — the error state's Retry action. */
  refetch: () => void;
}

/** A PR's live status by explicit identity, shared by the PRs-tab row badge (status only) and
 * the detail pane (status plus timeline). See docs/pull-request-ledger.md. */
export function useForgeStatusByIdentity({
  serverId,
  identity,
  enabled,
}: {
  serverId: string;
  identity: PullRequestIdentity;
  enabled: boolean;
}): ForgeStatusByIdentity {
  const { t } = useTranslation();
  const daemonClient = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryEnabled = enabled && !!daemonClient && isConnected;

  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: STATUS_STALE_TIME_MS,
    queryKey: prPaneStatusByIdentityQueryKey({ serverId, ...identity }),
    queryFn: async () => {
      if (!daemonClient) throw new Error(t("common.errors.daemonClientUnavailable"));
      return daemonClient.checkoutForgeGetPullRequestStatus(identity);
    },
    enabled: queryEnabled,
    refetchInterval: (currentQuery) => {
      const data = currentQuery.state.data;
      return nextStatusRefetchInterval({
        queryEnabled,
        status: data?.status ?? null,
        unsupportedForge: isUnsupportedForgeStatusError({
          payloadErrorKind: data?.error?.kind,
          queryError: currentQuery.state.error,
        }),
      });
    },
    refetchOnWindowFocus: false,
    // The fixed interval above is already the retry; a failed fetch waits for its next tick
    // instead of hammering a struggling forge three times in a row.
    retry: false,
  });

  const unsupportedForge = isUnsupportedForgeStatusError({
    payloadErrorKind: query.data?.error?.kind,
    queryError: query.error,
  });
  const status = query.data?.status ?? null;
  const payloadError =
    query.data?.error && query.data.error.kind !== "unsupported_forge" ? query.data.error : null;

  return {
    status,
    forge: normalizeForge(status?.forge),
    unsupportedForge,
    isLoading: queryEnabled && query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error : null,
    payloadError,
    refetch: () => void query.refetch(),
  };
}
