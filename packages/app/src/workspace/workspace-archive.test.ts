import { seedSessionHosts } from "@/test/seed-session";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { WorkspaceDirectoryReplica } from "@/runtime/directory-sync/workspace-replica";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  archiveWorkspaceOptimistically,
  archiveWorkspacesOptimistically,
  type WorkspaceArchiveTarget,
} from "@/workspace/workspace-archive";

const SERVER_ID = "workspace-archive-test";
const SECOND_SERVER_ID = "workspace-archive-test-2";

type ArchiveWorkspacePayload = Awaited<ReturnType<DaemonClient["archiveWorkspace"]>>;

function archivePayload(input: {
  workspaceId: string;
  error?: string | null;
}): ArchiveWorkspacePayload {
  return {
    requestId: "request",
    workspaceId: input.workspaceId,
    archivedAt: null,
    error: input.error ?? null,
  };
}

function workspace(input?: Partial<WorkspaceDescriptor>): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project/workspace-1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "workspace-1",
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  };
}

function target(input?: Partial<WorkspaceArchiveTarget>): WorkspaceArchiveTarget {
  const base = workspace();
  return {
    serverId: SERVER_ID,
    workspaceId: base.id,
    ...input,
  };
}

function createClient(
  archiveWorkspace: DaemonClient["archiveWorkspace"],
): Pick<DaemonClient, "archiveWorkspace"> {
  return { archiveWorkspace };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function storedWorkspaceOn(serverId: string, id: string): WorkspaceDescriptor | undefined {
  return useSessionStore.getState().sessions[serverId]?.workspaces.get(id);
}

function storedWorkspace(id: string): WorkspaceDescriptor | undefined {
  return storedWorkspaceOn(SERVER_ID, id);
}

beforeEach(() => {
  seedSessionHosts([SERVER_ID, SECOND_SERVER_ID]);
  useSessionStore.getState().initializeSession(SERVER_ID, {} as DaemonClient);
});

afterEach(() => {
  seedSessionHosts([]);
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SERVER_ID, workspaceId: "workspace-2" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-1" });
  clearWorkspaceArchivePending({ serverId: SECOND_SERVER_ID, workspaceId: "workspace-2" });
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

describe("archiveWorkspaceOptimistically", () => {
  it("hides the workspace and marks the archive pending while the daemon call runs", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(vi.fn(async () => releaseArchive.promise));

    const archive = archiveWorkspaceOptimistically({
      client,
      workspace: target(),
    });

    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(true);

    releaseArchive.resolve(archivePayload({ workspaceId: archived.id }));
    await archive;

    expect(storedWorkspace(archived.id)).toBeUndefined();
  });

  it("restores the workspace and clears pending state when the daemon rejects the archive", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const client = createClient(
      vi.fn(async () => archivePayload({ workspaceId: archived.id, error: "nope" })),
    );

    await expect(
      archiveWorkspaceOptimistically({
        client,
        workspace: target(),
      }),
    ).rejects.toThrow("nope");

    expect(storedWorkspace(archived.id)).toEqual(archived);
    expect(
      isWorkspaceArchivePending({
        serverId: SERVER_ID,
        workspaceId: archived.id,
      }),
    ).toBe(false);
  });

  it("keeps a pinned workspace gone when the daemon removed it before the request timed out", async () => {
    // The daemon marks the record archived and sends its remove within seconds, then keeps the
    // request open while it deletes the worktree; past the client's RPC timeout the request fails
    // although the archive already happened.
    const archived = workspace({ pinnedAt: "2026-10-12T18:23:00.055Z" });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const releaseArchive = deferred<ArchiveWorkspacePayload>();
    const client = createClient(vi.fn(async () => releaseArchive.promise));

    const archive = archiveWorkspaceOptimistically({
      client,
      workspace: target(),
    });
    new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({ kind: "remove", id: archived.id });
    releaseArchive.reject(new Error("Timed out waiting for archive_workspace_response"));
    const outcome = await archive.then(
      () => "archived",
      () => "failed",
    );

    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(outcome).toBe("archived");
  });

  it("still reports a refused archive when an overlapping archive of the same workspace failed first", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const first = deferred<ArchiveWorkspacePayload>();
    const second = deferred<ArchiveWorkspacePayload>();
    const client = createClient(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );

    const firstArchive = archiveWorkspaceOptimistically({ client, workspace: target() });
    const secondArchive = archiveWorkspaceOptimistically({ client, workspace: target() });
    first.resolve(archivePayload({ workspaceId: archived.id, error: "refused" }));
    await expect(firstArchive).rejects.toThrow("refused");
    second.resolve(archivePayload({ workspaceId: archived.id, error: "refused again" }));

    await expect(secondArchive).rejects.toThrow("refused again");
    expect(storedWorkspace(archived.id)).toEqual(archived);
  });

  it("keeps a pinned workspace gone when a sibling call's fast failure cleared the pending mark before this call's daemon remove landed", async () => {
    const archived = workspace();
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [archived]);
    const slowCall = deferred<ArchiveWorkspacePayload>();
    const fastCall = deferred<ArchiveWorkspacePayload>();
    const client = createClient(
      vi.fn().mockReturnValueOnce(slowCall.promise).mockReturnValueOnce(fastCall.promise),
    );

    const slow = archiveWorkspaceOptimistically({ client, workspace: target() });
    const fast = archiveWorkspaceOptimistically({ client, workspace: target() });

    // The overlapping second call fails fast with a real (non-timeout) error while the first call
    // is still outstanding. Its restore clears the shared pending mark.
    fastCall.resolve(archivePayload({ workspaceId: archived.id, error: "refused" }));
    await expect(fast).rejects.toThrow("refused");

    // The daemon's remove for the first call's archive lands after the pending mark was cleared.
    new WorkspaceDirectoryReplica(SERVER_ID).applyDelta({ kind: "remove", id: archived.id });

    // The first call's own request then times out, well after the daemon already removed the
    // workspace. Gating confirmWorkspaceArchiveRemoved only on the (now-cleared) pending mark would
    // drop this removal, so the timeout below would resurrect an already-archived workspace.
    slowCall.reject(new Error("Timed out waiting for archive_workspace_response"));
    const outcome = await slow.then(
      () => "archived",
      () => "failed",
    );

    expect(storedWorkspace(archived.id)).toBeUndefined();
    expect(outcome).toBe("archived");
  });
});

describe("archiveWorkspacesOptimistically", () => {
  it("returns failures and restores only the workspaces whose archive failed", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [first, second]);
    const client = createClient(
      vi.fn(async (workspaceId) =>
        archivePayload({
          workspaceId,
          error: workspaceId === second.id ? "failed" : null,
        }),
      ),
    );

    const failures = await archiveWorkspacesOptimistically({
      getClient: () => client,
      workspaces: [target({ workspaceId: first.id }), target({ workspaceId: second.id })],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.workspaceId).toBe(second.id);
    expect(storedWorkspace(first.id)).toBeUndefined();
    expect(storedWorkspace(second.id)).toEqual(second);
  });

  it("archives each workspace through its own server client", async () => {
    const first = workspace({ id: "workspace-1" });
    const second = workspace({
      id: "workspace-2",
      workspaceDirectory: "/repo/project/workspace-2",
      name: "workspace-2",
    });
    useSessionStore.getState().initializeSession(SECOND_SERVER_ID, {} as DaemonClient);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SERVER_ID, [first]);
    getHostRuntimeStore().acceptWorkspaceSnapshots(SECOND_SERVER_ID, [second]);

    const archivedByServer = new Map<string, string[]>();
    const clientFor = (serverId: string) =>
      createClient(async (workspaceId) => {
        archivedByServer.set(serverId, [...(archivedByServer.get(serverId) ?? []), workspaceId]);
        return archivePayload({ workspaceId });
      });

    const failures = await archiveWorkspacesOptimistically({
      getClient: (serverId) => clientFor(serverId),
      workspaces: [
        target({
          serverId: SERVER_ID,
          workspaceId: first.id,
        }),
        target({
          serverId: SECOND_SERVER_ID,
          workspaceId: second.id,
        }),
      ],
    });

    expect(failures).toEqual([]);
    expect(archivedByServer).toEqual(
      new Map([
        [SERVER_ID, [first.id]],
        [SECOND_SERVER_ID, [second.id]],
      ]),
    );
    expect(storedWorkspaceOn(SERVER_ID, first.id)).toBeUndefined();
    expect(storedWorkspaceOn(SECOND_SERVER_ID, second.id)).toBeUndefined();
  });
});
