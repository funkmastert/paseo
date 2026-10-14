import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  confirmWorkspaceArchiveRemoved,
  countWorkspaceArchiveRemovals,
  isWorkspaceArchivePending,
  markWorkspaceArchivePending,
  shouldSuppressWorkspaceForLocalArchive,
  trackWorkspaceArchiveCallSettled,
  trackWorkspaceArchiveCallStarted,
} from "@/contexts/session-workspace-upserts";

const baseWorkspace: WorkspaceDescriptor = {
  id: "/repo/worktree",
  projectId: "/repo",
  projectDisplayName: "Repo",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "feature",
  status: "done",
  archivingAt: "2026-04-30T00:00:00.000Z",
  statusEnteredAt: null,
  diffStat: null,
  scripts: [],
};

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return { ...baseWorkspace, ...input };
}

describe("workspace archive pending suppression", () => {
  it("tracks a locally pending workspace archive by id", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
    });

    expect(
      isWorkspaceArchivePending({
        serverId: "server-1",
        workspaceId: "/repo/worktree",
      }),
    ).toBe(true);
    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });

    expect(
      isWorkspaceArchivePending({
        serverId: "server-1",
        workspaceId: "/repo/worktree",
      }),
    ).toBe(false);
  });

  it("suppresses upserts for a locally pending archive", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });
  });

  it("does not suppress a same-cwd sibling whose id is not the one archived", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ id: "sibling", workspaceDirectory: "/repo/worktree" }),
      }),
    ).toBe(false);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });
  });

  it("allows upserts when this client did not start the archive", () => {
    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace(),
      }),
    ).toBe(false);
  });

  it("suppresses stale normal upserts while a local archive is pending", () => {
    markWorkspaceArchivePending({
      serverId: "server-1",
      workspaceId: "/repo/worktree",
    });

    expect(
      shouldSuppressWorkspaceForLocalArchive({
        serverId: "server-1",
        workspace: workspace({ archivingAt: null }),
      }),
    ).toBe(true);

    clearWorkspaceArchivePending({ serverId: "server-1", workspaceId: "/repo/worktree" });
  });
});

describe("confirmWorkspaceArchiveRemoved / countWorkspaceArchiveRemovals", () => {
  it("is a no-op for a workspace with nothing pending and no outstanding call", () => {
    confirmWorkspaceArchiveRemoved({ serverId: "server-2", workspaceId: "/repo/worktree" });

    expect(
      countWorkspaceArchiveRemovals({ serverId: "server-2", workspaceId: "/repo/worktree" }),
    ).toBe(0);
  });

  it("accumulates across multiple confirms for the same pending workspace", () => {
    markWorkspaceArchivePending({ serverId: "server-2", workspaceId: "/repo/worktree" });
    confirmWorkspaceArchiveRemoved({ serverId: "server-2", workspaceId: "/repo/worktree" });
    expect(
      countWorkspaceArchiveRemovals({ serverId: "server-2", workspaceId: "/repo/worktree" }),
    ).toBe(1);

    markWorkspaceArchivePending({ serverId: "server-2", workspaceId: "/repo/worktree" });
    confirmWorkspaceArchiveRemoved({ serverId: "server-2", workspaceId: "/repo/worktree" });
    expect(
      countWorkspaceArchiveRemovals({ serverId: "server-2", workspaceId: "/repo/worktree" }),
    ).toBe(2);
  });

  it("keeps the count at 0 for a workspace key that was never marked pending", () => {
    confirmWorkspaceArchiveRemoved({ serverId: "server-2", workspaceId: "/repo/never-pending" });

    expect(
      countWorkspaceArchiveRemovals({ serverId: "server-2", workspaceId: "/repo/never-pending" }),
    ).toBe(0);
  });

  it("still confirms when an outstanding call's own pending mark was cleared by a sibling", () => {
    const target = { serverId: "server-2", workspaceId: "/repo/sibling-cleared" };
    trackWorkspaceArchiveCallStarted(target);
    markWorkspaceArchivePending(target);
    // A sibling call's restore clears the shared pending mark while this call is still tracked.
    clearWorkspaceArchivePending(target);

    confirmWorkspaceArchiveRemoved(target);

    expect(countWorkspaceArchiveRemovals(target)).toBe(1);
    trackWorkspaceArchiveCallSettled(target);
  });
});
