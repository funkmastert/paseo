import { describe, expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import type { PullRequestLedgerRow } from "../../pull-request-ledger/pull-request-ledger-store.js";
import type { WorkspaceGitRuntimeSnapshot } from "../../workspace-git-service.js";
import {
  type PullRequestLedgerAccess,
  type PullRequestsWorkspaceLookup,
  type WorkspaceGitForgeLookup,
  createPullRequestsSession,
  PullRequestsSession,
} from "./pull-requests-session.js";

function row(overrides: Partial<PullRequestLedgerRow> = {}): PullRequestLedgerRow {
  return {
    id: "github.com/acme/widgets#42",
    agentId: "agent-1",
    agentTitle: "Ship it",
    agentCwd: "/repo",
    host: "github.com",
    repoOwner: "acme",
    repoName: "widgets",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    forge: "github",
    detectedAtMs: 1000,
    status: "open",
    lastStatusCheckedAtMs: null,
    ...overrides,
  };
}

function fakeLedger(options: {
  rows?: PullRequestLedgerRow[];
  trackedRows?: Record<string, PullRequestLedgerRow>;
}): PullRequestLedgerAccess & { recordedStatus: Array<{ id: string; status: string }> } {
  const tracked = new Map(Object.entries(options.trackedRows ?? {}));
  const recordedStatus: Array<{ id: string; status: string }> = [];
  return {
    recordedStatus,
    async list() {
      return options.rows ?? [];
    },
    getRow(id) {
      return tracked.get(id);
    },
    ensureTracked(identity, creator) {
      const id = `${identity.host}/${identity.repoOwner}/${identity.repoName}#${identity.number}`;
      const existing = tracked.get(id);
      if (existing) return existing;
      const newRow = row({ id, ...identity, ...creator });
      tracked.set(id, newRow);
      return newRow;
    },
    recordStatusCheck(id, status) {
      recordedStatus.push({ id, status });
    },
  };
}

function fakeWorkspaceRegistry(
  cwdByWorkspaceId: Record<string, string>,
): PullRequestsWorkspaceLookup {
  return {
    async get(workspaceId) {
      const cwd = cwdByWorkspaceId[workspaceId];
      return cwd ? { cwd } : null;
    },
  };
}

function snapshotWithPullRequest(
  pullRequest: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: "/repo",
    git: {
      isGit: true,
      repoRoot: "/repo",
      mainRepoRoot: "/repo",
      currentBranch: "feat/widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: null,
      upstreamRef: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: true,
      diffStat: null,
    },
    forge: {
      featuresEnabled: true,
      authState: "authenticated",
      forge: "github",
      pullRequest,
      error: null,
    },
  };
}

function fakeWorkspaceGitService(options: {
  resolution?: { host: string; forge: string; getPullRequestStatusByIdentity?: unknown } | null;
  snapshot?: WorkspaceGitRuntimeSnapshot | null;
}): WorkspaceGitForgeLookup {
  const resolution = options.resolution
    ? {
        host: options.resolution.host,
        forge: options.resolution.forge,
        service: {
          getPullRequestStatusByIdentity: options.resolution.getPullRequestStatusByIdentity,
        },
      }
    : null;
  return {
    async resolveForge() {
      return resolution as never;
    },
    peekSnapshot() {
      return options.snapshot ?? null;
    },
  };
}

function createSession(input: {
  ledger: PullRequestLedgerAccess;
  workspaceGitService: WorkspaceGitForgeLookup;
  workspaceRegistry: PullRequestsWorkspaceLookup;
}) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new PullRequestsSession({
    host: { emit: (message) => void emitted.push(message) },
    ledger: input.ledger,
    workspaceGitService: input.workspaceGitService,
    workspaceRegistry: input.workspaceRegistry,
    now: () => 5000,
  });
  return { session, emitted };
}

describe("PullRequestsSession.handleListRequest", () => {
  test("echoes the requestId/workspaceId and maps every ledger row", async () => {
    const ledger = fakeLedger({ rows: [row()] });
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({ snapshot: null }),
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });

    await session.handleListRequest({
      type: "workspace.pull_requests.list.request",
      requestId: "req-1",
      workspaceId: "ws-a",
    });

    expect(emitted).toHaveLength(1);
    const payload = (
      emitted[0] as { payload: { requestId: string; workspaceId: string; pullRequests: unknown[] } }
    ).payload;
    expect(payload.requestId).toBe("req-1");
    expect(payload.workspaceId).toBe("ws-a");
    expect(payload.pullRequests).toEqual([
      expect.objectContaining({ id: "github.com/acme/widgets#42", creatingAgentId: "agent-1" }),
    ]);
  });

  test("merges in the checkout's own current PR when it is not already a ledger row", async () => {
    const ledger = fakeLedger({ rows: [] });
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({
        snapshot: snapshotWithPullRequest({
          number: 7,
          repoOwner: "acme",
          repoName: "widgets",
          url: "https://github.com/acme/widgets/pull/7",
          title: "Branch PR",
          state: "open",
          baseRefName: "main",
          headRefName: "feat/widgets",
          isMerged: false,
        }),
      }),
      workspaceRegistry: fakeWorkspaceRegistry({ "ws-a": "/repo" }),
    });

    await session.handleListRequest({
      type: "workspace.pull_requests.list.request",
      requestId: "req-1",
      workspaceId: "ws-a",
    });

    const payload = (emitted[0] as { payload: { pullRequests: Array<{ id: string }> } }).payload;
    expect(payload.pullRequests.map((entry) => entry.id)).toEqual(["github.com/acme/widgets#7"]);
  });

  test("does not duplicate the branch PR when it is already a tracked ledger row", async () => {
    const existing = row({ id: "github.com/acme/widgets#7", number: 7 });
    const ledger = fakeLedger({ rows: [existing], trackedRows: { [existing.id]: existing } });
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({
        snapshot: snapshotWithPullRequest({
          number: 7,
          repoOwner: "acme",
          repoName: "widgets",
          url: "https://github.com/acme/widgets/pull/7",
          title: "Branch PR",
          state: "open",
          baseRefName: "main",
          headRefName: "feat/widgets",
          isMerged: false,
        }),
      }),
      workspaceRegistry: fakeWorkspaceRegistry({ "ws-a": "/repo" }),
    });

    await session.handleListRequest({
      type: "workspace.pull_requests.list.request",
      requestId: "req-1",
      workspaceId: "ws-a",
    });

    const payload = (emitted[0] as { payload: { pullRequests: unknown[] } }).payload;
    expect(payload.pullRequests).toHaveLength(1);
  });
});

describe("PullRequestsSession.handleGetStatusRequest", () => {
  function baseRequest(
    overrides: Partial<
      Extract<
        Parameters<PullRequestsSession["handleGetStatusRequest"]>[0],
        { type: "checkout.forge.get_pull_request_status.request" }
      >
    > = {},
  ) {
    return {
      type: "checkout.forge.get_pull_request_status.request" as const,
      requestId: "req-1",
      cwd: "/repo",
      host: "github.com",
      repoOwner: "acme",
      repoName: "widgets",
      number: 42,
      ...overrides,
    };
  }

  test("rejects a malformed owner/repo or a non-positive number without calling the forge", async () => {
    const ledger = fakeLedger({});
    const resolveForge = vi.fn();
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: { resolveForge, peekSnapshot: () => null },
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });

    await session.handleGetStatusRequest(baseRequest({ repoOwner: "acme/evil" }));
    await session.handleGetStatusRequest(baseRequest({ number: -1 }));
    await session.handleGetStatusRequest(baseRequest({ number: 1.5 }));

    expect(resolveForge).not.toHaveBeenCalled();
    for (const message of emitted) {
      const payload = (message as { payload: { error: { kind: string } | null } }).payload;
      expect(payload.error?.kind).toBe("invalid_request");
    }
  });

  test("rejects an identity that is neither a tracked ledger row nor the checkout's own PR", async () => {
    const ledger = fakeLedger({});
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({
        resolution: { host: "github.com", forge: "github" },
        snapshot: null,
      }),
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });

    await session.handleGetStatusRequest(baseRequest());

    const payload = (emitted[0] as { payload: { status: unknown; error: { kind: string } } })
      .payload;
    expect(payload.status).toBeNull();
    expect(payload.error.kind).toBe("not_found");
  });

  test("unsupported_forge when the resolved adapter has no identity lookup", async () => {
    const existing = row();
    const ledger = fakeLedger({ trackedRows: { [existing.id]: existing } });
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({
        resolution: { host: "github.com", forge: "github" },
      }),
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });

    await session.handleGetStatusRequest(baseRequest());

    const payload = (emitted[0] as { payload: { error: { kind: string } } }).payload;
    expect(payload.error.kind).toBe("unsupported_forge");
  });

  test("normalizes a successful status and records it in the ledger", async () => {
    const existing = row();
    const ledger = fakeLedger({ trackedRows: { [existing.id]: existing } });
    const getPullRequestStatusByIdentity = vi.fn(async () => ({
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      title: "Widgets",
      state: "open",
      baseRefName: "main",
      headRefName: "feat/widgets",
      isMerged: false,
      mergeable: "MERGEABLE",
      checks: [],
      checksStatus: "pending",
      reviewDecision: "pending",
    }));
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({
        resolution: { host: "github.com", forge: "github", getPullRequestStatusByIdentity },
      }),
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });

    await session.handleGetStatusRequest(baseRequest());

    expect(getPullRequestStatusByIdentity).toHaveBeenCalledWith({
      cwd: "/repo",
      repoOwner: "acme",
      repoName: "widgets",
      number: 42,
    });
    const payload = (
      emitted[0] as { payload: { status: { state: string } | null; error: unknown } }
    ).payload;
    expect(payload.status?.state).toBe("open");
    expect(payload.error).toBeNull();
    expect(ledger.recordedStatus).toEqual([{ id: existing.id, status: "open" }]);
  });

  test("maps a thrown adapter failure to a typed error instead of rejecting", async () => {
    const existing = row();
    const ledger = fakeLedger({ trackedRows: { [existing.id]: existing } });
    const { session, emitted } = createSession({
      ledger,
      workspaceGitService: fakeWorkspaceGitService({
        resolution: {
          host: "github.com",
          forge: "github",
          getPullRequestStatusByIdentity: vi.fn(async () => {
            throw new Error("gh exploded");
          }),
        },
      }),
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });

    await expect(session.handleGetStatusRequest(baseRequest())).resolves.toBeUndefined();

    const payload = (
      emitted[0] as { payload: { status: unknown; error: { kind: string; message: string } } }
    ).payload;
    expect(payload.status).toBeNull();
    expect(payload.error).toEqual({ kind: "failed", message: "gh exploded" });
  });
});

describe("createPullRequestsSession", () => {
  test("returns null when no ledger is configured", () => {
    const session = createPullRequestsSession({
      host: { emit: () => undefined },
      ledger: undefined,
      workspaceGitService: fakeWorkspaceGitService({}),
      workspaceRegistry: fakeWorkspaceRegistry({}),
    });
    expect(session).toBeNull();
  });
});
