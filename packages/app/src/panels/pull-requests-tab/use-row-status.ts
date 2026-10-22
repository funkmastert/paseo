import { useForgeStatusByIdentity } from "@/git/pull-request-panel/use-forge-status-by-identity";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";

export interface RowPullRequestStatus {
  state: "open" | "merged" | "closed";
  checksStatus: string | undefined;
  reviewDecision: string | null | undefined;
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
  const { status } = useForgeStatusByIdentity({
    serverId,
    identity: {
      host: entry.host,
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      number: entry.number,
      cwd: entry.creatingAgentCwd,
    },
    enabled,
  });

  return {
    state: resolveRowState(status),
    checksStatus: status?.checksStatus,
    reviewDecision: status?.reviewDecision,
  };
}
