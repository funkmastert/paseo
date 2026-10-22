import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { PullRequestLedgerRow } from "../../pull-request-ledger/pull-request-ledger-store.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { normalizeCheckoutPrStatusPayload } from "../../checkout/status-projection.js";

/** What the session needs from the pull request ledger service: one read. */
export interface PullRequestLedgerReader {
  list: (workspaceId: string) => Promise<PullRequestLedgerRow[]>;
}

export interface PullRequestsSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  reader: PullRequestLedgerReader;
  workspaceGitService: WorkspaceGitService;
}

function rowOnWire(row: PullRequestLedgerRow): PullRequestLedgerEntry {
  return {
    id: row.id,
    host: row.host,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    number: row.number,
    url: row.url,
    forge: row.forge,
    creatingAgentId: row.agentId,
    creatingAgentTitle: row.agentTitle,
    creatingAgentCwd: row.agentCwd,
    detectedAtMs: row.detectedAtMs,
    // The list is identity + detection metadata; a row's live status is fetched per-row via
    // checkout.forge.get_pull_request_status, the same way the single-PR tab always has
    // (docs/pull-request-ledger.md, "Status is fetched per row, not pre-populated in the list").
    status: null,
  };
}

/** Serves `workspace.pullRequests.list` and `checkout.forge.get_pull_request_status`
 * (docs/pull-request-ledger.md). Read-only; the ledger service's live observer and boot
 * backfill are the only writers of the ledger itself. */
export class PullRequestsSession {
  private readonly host: PullRequestsSessionOptions["host"];
  private readonly reader: PullRequestLedgerReader;
  private readonly workspaceGitService: WorkspaceGitService;

  constructor(options: PullRequestsSessionOptions) {
    this.host = options.host;
    this.reader = options.reader;
    this.workspaceGitService = options.workspaceGitService;
  }

  async handleListRequest(
    msg: Extract<SessionInboundMessage, { type: "workspace.pullRequests.list.request" }>,
  ): Promise<void> {
    const rows = await this.reader.list(msg.workspaceId);
    this.host.emit({
      type: "workspace.pullRequests.list.response",
      payload: {
        requestId: msg.requestId,
        workspaceId: msg.workspaceId,
        pullRequests: rows.map(rowOnWire),
      },
    });
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout.forge.get_pull_request_status.request" }>,
  ): Promise<void> {
    const resolution = await this.workspaceGitService.resolveForge(msg.cwd);
    if (
      !resolution ||
      resolution.host !== msg.host ||
      !resolution.service.getPullRequestStatusByIdentity
    ) {
      this.host.emit({
        type: "checkout.forge.get_pull_request_status.response",
        payload: {
          requestId: msg.requestId,
          status: null,
          error: {
            kind: "unsupported_forge",
            message: `no identity-based status lookup for ${msg.host}`,
          },
        },
      });
      return;
    }
    const status = await resolution.service.getPullRequestStatusByIdentity({
      cwd: msg.cwd,
      repoOwner: msg.repoOwner,
      repoName: msg.repoName,
      number: msg.number,
    });
    this.host.emit({
      type: "checkout.forge.get_pull_request_status.response",
      payload: {
        requestId: msg.requestId,
        status: normalizeCheckoutPrStatusPayload(status, resolution.forge),
        error: status ? null : { kind: "not_found", message: "" },
      },
    });
  }
}

/** Null when the host has no pull request ledger service (only a test does), so callers stay
 * flat. */
export function createPullRequestsSession(
  options: Omit<PullRequestsSessionOptions, "reader"> & {
    reader: PullRequestLedgerReader | undefined;
  },
): PullRequestsSession | null {
  const { reader, ...rest } = options;
  return reader ? new PullRequestsSession({ ...rest, reader }) : null;
}
