import type { CurrentPullRequestStatus } from "../../../services/forge-service.js";
import { ForgePollPausedError } from "../../../services/forge-poll-paused-error.js";
import type { PullRequestLedgerEntry } from "@getpaseo/protocol/pull-requests/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { parsePullRequestUrl } from "../../pull-request-ledger/pull-request-ledger-detect.js";
import {
  buildPullRequestLedgerRowId,
  type PullRequestLedgerRow,
  type PullRequestLedgerStatus,
} from "../../pull-request-ledger/pull-request-ledger-store.js";
import type { ForgeResolution } from "../../../services/forge-resolver.js";
import type { WorkspaceGitRuntimeSnapshot } from "../../workspace-git-service.js";
import { normalizeCheckoutPrStatusPayload } from "../../checkout/status-projection.js";

/** Just enough of `WorkspaceGitService` for status-by-identity authorization and the branch's
 * own PR lookup: both read the already-cached snapshot, never issue a network call. */
export interface WorkspaceGitForgeLookup {
  resolveForge(cwd: string): Promise<ForgeResolution | null>;
  peekSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot | null;
}

/** What the session needs from the pull request ledger: the descendant-tree read, plus the
 * narrow writes that keep a discovered-but-undetected PR (the checkout's own branch) and a
 * refreshed status in the same store the live detector and boot backfill write to. */
export interface PullRequestLedgerAccess {
  list: (workspaceId: string) => Promise<PullRequestLedgerRow[]>;
  getRow: (id: string) => PullRequestLedgerRow | undefined;
  ensureTracked: (
    identity: {
      host: string;
      repoOwner: string;
      repoName: string;
      number: number;
      url: string;
      forge: string;
    },
    creator: { agentId: string; agentTitle: string | null; agentCwd: string },
  ) => PullRequestLedgerRow;
  recordStatusCheck: (id: string, status: PullRequestLedgerStatus, atMs: number) => void;
}

/** Just enough of the workspace registry to find a workspace's checkout cwd. */
export interface PullRequestsWorkspaceLookup {
  get: (workspaceId: string) => Promise<{ cwd: string } | null>;
}

export interface PullRequestsSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  ledger: PullRequestLedgerAccess;
  workspaceGitService: WorkspaceGitForgeLookup;
  workspaceRegistry: PullRequestsWorkspaceLookup;
  now?: () => number;
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
  };
}

// Owner/repo path segments: letters, digits, and the handful of punctuation marks every forge
// allows in a slug. Never matches a path separator or shell metacharacter.
const REPO_SEGMENT = /^[\w.-]+$/;

function isValidRepoSegment(value: string): boolean {
  // "." and ".." are otherwise valid under REPO_SEGMENT but are path-traversal segments, not
  // real owner/repo slugs -- reject them explicitly before building any forge API path from them.
  if (value === "." || value === "..") return false;
  return value.length > 0 && value.length <= 255 && REPO_SEGMENT.test(value);
}

function toLedgerStatus(status: CurrentPullRequestStatus): PullRequestLedgerStatus {
  if (status.isMerged) return "merged";
  return status.state === "open" ? "open" : "closed";
}

type PullRequestIdentity = NonNullable<ReturnType<typeof parsePullRequestUrl>>;

/** The checkout's current PR identity, read from the already-cached git/forge snapshot (never a
 * network call). Null when the checkout has no current PR or its URL doesn't parse. */
function resolveCheckoutPullRequestIdentity(
  workspaceGitService: WorkspaceGitForgeLookup,
  cwd: string,
): PullRequestIdentity | null {
  const pullRequest = workspaceGitService.peekSnapshot(cwd)?.forge.pullRequest;
  return pullRequest ? parsePullRequestUrl(pullRequest.url) : null;
}

/** Serves `workspace.pull_requests.list` and `checkout.forge.get_pull_request_status`
 * (docs/pull-request-ledger.md). The ledger service's live observer and boot backfill are the
 * only writers of *detected* rows; this session additionally tracks the checkout's own current
 * PR, which detection never observes as a tool call. */
export class PullRequestsSession {
  private readonly host: PullRequestsSessionOptions["host"];
  private readonly ledger: PullRequestLedgerAccess;
  private readonly workspaceGitService: WorkspaceGitForgeLookup;
  private readonly workspaceRegistry: PullRequestsWorkspaceLookup;
  private readonly now: () => number;

  constructor(options: PullRequestsSessionOptions) {
    this.host = options.host;
    this.ledger = options.ledger;
    this.workspaceGitService = options.workspaceGitService;
    this.workspaceRegistry = options.workspaceRegistry;
    this.now = options.now ?? Date.now;
  }

  async handleListRequest(
    msg: Extract<SessionInboundMessage, { type: "workspace.pull_requests.list.request" }>,
  ): Promise<void> {
    const rows = await this.ledger.list(msg.workspaceId);
    const branchRow = await this.resolveBranchPullRequestRow(msg.workspaceId);
    const merged =
      branchRow && !rows.some((row) => row.id === branchRow.id) ? [branchRow, ...rows] : rows;
    merged.sort((a, b) => b.detectedAtMs - a.detectedAtMs);
    this.host.emit({
      type: "workspace.pull_requests.list.response",
      payload: {
        requestId: msg.requestId,
        workspaceId: msg.workspaceId,
        pullRequests: merged.map(rowOnWire),
      },
    });
  }

  /** The workspace checkout's current PR, read from the already-cached git/forge snapshot
   * (never a network call), tracked in the ledger so the identity-status RPC can serve it. */
  private async resolveBranchPullRequestRow(
    workspaceId: string,
  ): Promise<PullRequestLedgerRow | null> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) return null;
    const identity = resolveCheckoutPullRequestIdentity(this.workspaceGitService, workspace.cwd);
    if (!identity) return null;
    return this.ledger.ensureTracked(identity, {
      agentId: "",
      agentTitle: null,
      agentCwd: workspace.cwd,
    });
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "checkout.forge.get_pull_request_status.request" }>,
  ): Promise<void> {
    if (
      !isValidRepoSegment(msg.repoOwner) ||
      !isValidRepoSegment(msg.repoName) ||
      !Number.isInteger(msg.number) ||
      msg.number <= 0
    ) {
      this.emitStatus(msg.requestId, null, {
        kind: "invalid_request",
        message: "repoOwner, repoName, and a positive integer number are required",
      });
      return;
    }

    const authorized = await this.isAuthorizedIdentity(msg);
    if (!authorized) {
      this.emitStatus(msg.requestId, null, {
        kind: "not_found",
        message: `${msg.host}/${msg.repoOwner}/${msg.repoName}#${msg.number} is not tracked for this session`,
      });
      return;
    }

    const resolution = await this.workspaceGitService.resolveForge(msg.cwd);
    if (
      !resolution ||
      resolution.host !== msg.host ||
      !resolution.service.getPullRequestStatusByIdentity
    ) {
      this.emitStatus(msg.requestId, null, {
        kind: "unsupported_forge",
        message: `no identity-based status lookup for ${msg.host}`,
      });
      return;
    }

    let status: CurrentPullRequestStatus | null;
    try {
      status = await resolution.service.getPullRequestStatusByIdentity({
        cwd: msg.cwd,
        repoOwner: msg.repoOwner,
        repoName: msg.repoName,
        number: msg.number,
      });
    } catch (error) {
      this.emitStatus(msg.requestId, null, {
        kind: error instanceof ForgePollPausedError ? "rate_limited" : "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (status) {
      const id = buildPullRequestLedgerRowId({
        host: msg.host,
        repoOwner: msg.repoOwner,
        repoName: msg.repoName,
        number: msg.number,
      });
      this.ledger.recordStatusCheck(id, toLedgerStatus(status), this.now());
    }

    this.emitStatus(
      msg.requestId,
      normalizeCheckoutPrStatusPayload(status, resolution.forge),
      status ? null : { kind: "not_found", message: "" },
    );
  }

  /** True when the requested identity is either already tracked in the ledger, or matches the
   * requesting cwd's own checkout PR (which `handleGetStatusRequest` can be asked about before
   * `workspace.pull_requests.list` ever runs for that workspace). Bounds the identity RPC to PRs
   * this session already has reason to know about, rather than any repo the `cwd`'s `gh`/`tea`
   * context happens to be authenticated for. */
  private async isAuthorizedIdentity(
    msg: Extract<SessionInboundMessage, { type: "checkout.forge.get_pull_request_status.request" }>,
  ): Promise<boolean> {
    const id = buildPullRequestLedgerRowId({
      host: msg.host,
      repoOwner: msg.repoOwner,
      repoName: msg.repoName,
      number: msg.number,
    });
    if (this.ledger.getRow(id)) return true;

    const resolution = await this.workspaceGitService.resolveForge(msg.cwd);
    if (!resolution || resolution.host !== msg.host) return false;
    const identity = resolveCheckoutPullRequestIdentity(this.workspaceGitService, msg.cwd);
    if (
      !identity ||
      identity.repoOwner !== msg.repoOwner ||
      identity.repoName !== msg.repoName ||
      identity.number !== msg.number
    ) {
      return false;
    }
    this.ledger.ensureTracked(identity, { agentId: "", agentTitle: null, agentCwd: msg.cwd });
    return true;
  }

  private emitStatus(
    requestId: string,
    status: ReturnType<typeof normalizeCheckoutPrStatusPayload>,
    error: { kind: string; message: string } | null,
  ): void {
    this.host.emit({
      type: "checkout.forge.get_pull_request_status.response",
      payload: { requestId, status, error },
    });
  }
}

/** Null when the host has no pull request ledger service (only a test does), so callers stay
 * flat. */
export function createPullRequestsSession(
  options: Omit<PullRequestsSessionOptions, "ledger"> & {
    ledger: PullRequestLedgerAccess | undefined;
  },
): PullRequestsSession | null {
  const { ledger, ...rest } = options;
  return ledger ? new PullRequestsSession({ ...rest, ledger }) : null;
}
