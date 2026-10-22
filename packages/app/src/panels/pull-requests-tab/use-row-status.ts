import { useForgeStatusByIdentity } from "@/git/pull-request-panel/use-forge-status-by-identity";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";

export interface RowPullRequestStatus {
  // "unknown" covers loading, an error, an unsupported forge, and a not-found response alike —
  // none of them mean the PR is closed, so none of them get the closed glyph.
  state: "unknown" | "open" | "merged" | "closed";
  checksStatus: string | undefined;
  reviewDecision: string | null | undefined;
}

/** The creating agent's cwd selects which authenticated CLI context a status fetch runs from;
 * fall back to the viewing workspace's own cwd once that agent is gone (archived, restarted). */
export function resolveStatusCwd(creatingAgentCwd: string, fallbackCwd: string | null): string {
  return creatingAgentCwd || fallbackCwd || "";
}

export function resolveRowState(
  status: { isMerged: boolean; state: string } | null,
): RowPullRequestStatus["state"] {
  if (!status) return "unknown";
  if (status.isMerged) return "merged";
  return status.state === "open" ? "open" : "closed";
}

/** A row's live status, fetched independently of its detail view (no timeline fetch) so a long
 * list doesn't pay for content nobody has drilled into. See docs/pull-request-ledger.md. */
export function useRowPullRequestStatus({
  serverId,
  entry,
  fallbackCwd,
  enabled,
}: {
  serverId: string;
  entry: PullRequestLedgerEntry;
  /** The viewing workspace's cwd: used when the creating agent's cwd is gone. */
  fallbackCwd: string | null;
  enabled: boolean;
}): RowPullRequestStatus {
  const { status } = useForgeStatusByIdentity({
    serverId,
    identity: {
      host: entry.host,
      repoOwner: entry.repoOwner,
      repoName: entry.repoName,
      number: entry.number,
      cwd: resolveStatusCwd(entry.creatingAgentCwd, fallbackCwd),
    },
    enabled,
  });

  return {
    state: resolveRowState(status),
    checksStatus: status?.checksStatus,
    reviewDecision: status?.reviewDecision,
  };
}
