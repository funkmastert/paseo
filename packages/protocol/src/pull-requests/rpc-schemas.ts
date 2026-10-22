import { z } from "zod";
import { CheckoutPrStatusSchema } from "../checkout-pr-status.js";

// The pull request ledger (docs/pull-request-ledger.md): one row per PR a workspace's agent or
// any of its descendant subagents created, detected from tool-call history. Gated on
// `server_info.features.pullRequestLedger`.

export const PullRequestLedgerEntrySchema = z.object({
  id: z.string(),
  host: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  number: z.number(),
  url: z.string(),
  forge: z.string(),
  creatingAgentId: z.string(),
  creatingAgentTitle: z.string().nullable(),
  // The creating agent's cwd: selects which authenticated CLI context a status fetch for this
  // row should run from. Not the PR's own identity.
  creatingAgentCwd: z.string(),
  detectedAtMs: z.number(),
  // No status here: a row's live status is fetched per-row via
  // checkout.forge.get_pull_request_status, never pre-populated in the list.
});

export const WorkspacePullRequestsListRequestSchema = z.object({
  type: z.literal("workspace.pull_requests.list.request"),
  workspaceId: z.string(),
  requestId: z.string(),
});

export const WorkspacePullRequestsListResponseSchema = z.object({
  type: z.literal("workspace.pull_requests.list.response"),
  payload: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    pullRequests: z.array(PullRequestLedgerEntrySchema),
  }),
});

// Open kind, not a closed enum (docs/protocol-compatibility.md — never narrow): a daemon that
// adds a new failure kind must not fail validation on an older app that doesn't know it.
export const PullRequestStatusByIdentityErrorSchema = z.object({
  kind: z.string(),
  message: z.string().optional().default(""),
});

export const CheckoutForgeGetPullRequestStatusRequestSchema = z.object({
  type: z.literal("checkout.forge.get_pull_request_status.request"),
  // The creating agent's cwd: selects which authenticated `gh`/`tea` context to run from. Not
  // the identity of the PR being fetched.
  cwd: z.string(),
  host: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  number: z.number(),
  requestId: z.string(),
});

export const CheckoutForgeGetPullRequestStatusResponseSchema = z.object({
  type: z.literal("checkout.forge.get_pull_request_status.response"),
  payload: z.object({
    requestId: z.string(),
    status: CheckoutPrStatusSchema.nullable(),
    error: PullRequestStatusByIdentityErrorSchema.nullable(),
  }),
});

export type PullRequestLedgerEntry = z.infer<typeof PullRequestLedgerEntrySchema>;
export type WorkspacePullRequestsListRequest = z.infer<
  typeof WorkspacePullRequestsListRequestSchema
>;
export type WorkspacePullRequestsListResponse = z.infer<
  typeof WorkspacePullRequestsListResponseSchema
>;
export type PullRequestStatusByIdentityError = z.infer<
  typeof PullRequestStatusByIdentityErrorSchema
>;
export type CheckoutForgeGetPullRequestStatusRequest = z.infer<
  typeof CheckoutForgeGetPullRequestStatusRequestSchema
>;
export type CheckoutForgeGetPullRequestStatusResponse = z.infer<
  typeof CheckoutForgeGetPullRequestStatusResponseSchema
>;
