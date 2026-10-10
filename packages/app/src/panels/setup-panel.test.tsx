// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceSetupSnapshot } from "./setup-panel";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";

const fetchWorkspaceSetupStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    fetchWorkspaceSetupStatus: fetchWorkspaceSetupStatusMock,
  }),
}));

describe("useWorkspaceSetupSnapshot", () => {
  beforeEach(() => {
    fetchWorkspaceSetupStatusMock.mockReset();
    useWorkspaceSetupStore.setState({ snapshots: {}, requestedKeys: new Set() });
  });

  it("resolves once the daemon responds with a null snapshot, instead of waiting forever", async () => {
    fetchWorkspaceSetupStatusMock.mockResolvedValue({
      requestId: "req-1",
      workspaceId: "workspace-1",
      snapshot: null,
    });

    const { result } = renderHook(() => useWorkspaceSetupSnapshot("server-1", "workspace-1"));

    expect(result.current.hasResolved).toBe(false);

    await waitFor(() => expect(result.current.hasResolved).toBe(true));
    expect(result.current.snapshot).toBeNull();
    expect(fetchWorkspaceSetupStatusMock).toHaveBeenCalledTimes(1);
  });

  it("resolves and stores the snapshot when the daemon returns one", async () => {
    fetchWorkspaceSetupStatusMock.mockResolvedValue({
      requestId: "req-1",
      workspaceId: "workspace-1",
      snapshot: {
        status: "completed",
        detail: {
          type: "worktree_setup",
          worktreePath: "/Users/test/project",
          branchName: "main",
          log: "",
          commands: [],
        },
        error: null,
      },
    });

    const { result } = renderHook(() => useWorkspaceSetupSnapshot("server-1", "workspace-1"));

    await waitFor(() => expect(result.current.hasResolved).toBe(true));
    expect(result.current.snapshot?.status).toBe("completed");
  });

  it("resolves even when the fetch rejects", async () => {
    fetchWorkspaceSetupStatusMock.mockRejectedValue(new Error("not supported"));

    const { result } = renderHook(() => useWorkspaceSetupSnapshot("server-1", "workspace-1"));

    await waitFor(() => expect(result.current.hasResolved).toBe(true));
    expect(result.current.snapshot).toBeNull();
  });
});
