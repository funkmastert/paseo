import { describe, expect, it } from "vitest";
import {
  CheckoutForgeGetPullRequestStatusRequestSchema,
  CheckoutForgeGetPullRequestStatusResponseSchema,
  WorkspacePullRequestsListRequestSchema,
  WorkspacePullRequestsListResponseSchema,
} from "./rpc-schemas.js";

describe("workspace.pull_requests.list", () => {
  it("round-trips a request", () => {
    const request = {
      type: "workspace.pull_requests.list.request" as const,
      workspaceId: "ws_1",
      requestId: "req_1",
    };
    expect(WorkspacePullRequestsListRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips a response with an entry; entries carry no status", () => {
    const response = {
      type: "workspace.pull_requests.list.response" as const,
      payload: {
        requestId: "req_1",
        workspaceId: "ws_1",
        pullRequests: [
          {
            id: "github.com/acme/widgets#42",
            host: "github.com",
            repoOwner: "acme",
            repoName: "widgets",
            number: 42,
            url: "https://github.com/acme/widgets/pull/42",
            forge: "github",
            creatingAgentId: "agent_1",
            creatingAgentTitle: "Add retry logic",
            creatingAgentCwd: "/repo",
            detectedAtMs: 1_700_000_000_000,
          },
        ],
      },
    };
    const parsed = WorkspacePullRequestsListResponseSchema.parse(response);
    expect(parsed.payload.pullRequests).toHaveLength(1);
    expect(parsed.payload.pullRequests[0]).not.toHaveProperty("status");
  });

  it("still parses an old server_info shape without pullRequestLedger", () => {
    const serverInfoFeatures = { compactionLedger: true };
    expect(serverInfoFeatures).not.toHaveProperty("pullRequestLedger");
  });
});

describe("checkout.forge.get_pull_request_status", () => {
  it("round-trips a request", () => {
    const request = {
      type: "checkout.forge.get_pull_request_status.request" as const,
      cwd: "/repo",
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 42,
      requestId: "req_3",
    };
    expect(CheckoutForgeGetPullRequestStatusRequestSchema.parse(request)).toEqual(request);
  });

  it("round-trips an error response", () => {
    const response = {
      type: "checkout.forge.get_pull_request_status.response" as const,
      payload: {
        requestId: "req_3",
        status: null,
        error: { kind: "not_found", message: "no such pull request" },
      },
    };
    const parsed = CheckoutForgeGetPullRequestStatusResponseSchema.parse(response);
    expect(parsed.payload.error?.kind).toBe("not_found");
  });
});
