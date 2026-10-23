/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePullRequests } from "./use-pull-requests";

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  clients: new Map<string, { workspacePullRequestsList: ReturnType<typeof vi.fn> }>(),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "pullRequestLedger" && runtime.supported,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => runtime.clients.get(serverId) ?? null,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

describe("usePullRequests", () => {
  beforeEach(() => {
    runtime.connected = true;
    runtime.supported = true;
    runtime.clients.clear();
  });

  it("distinguishes a genuinely empty list from an error: empty is not an error", async () => {
    const client = { workspacePullRequestsList: vi.fn(async () => ({ pullRequests: [] })) };
    runtime.clients.set("host-1", client);

    const { result } = renderHook(
      () => usePullRequests({ serverId: "host-1", workspaceId: "ws-a" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pullRequests).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it("surfaces isError when the fetch rejects", async () => {
    const client = {
      workspacePullRequestsList: vi.fn(async () => {
        throw new Error("rpc failed");
      }),
    };
    runtime.clients.set("host-1", client);

    const { result } = renderHook(
      () => usePullRequests({ serverId: "host-1", workspaceId: "ws-a" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.pullRequests).toEqual([]);
  });

  it("never calls the daemon on a host without the ledger feature", () => {
    runtime.supported = false;
    const client = { workspacePullRequestsList: vi.fn() };
    runtime.clients.set("old-host", client);

    const { result } = renderHook(
      () => usePullRequests({ serverId: "old-host", workspaceId: "ws-a" }),
      { wrapper },
    );

    expect(client.workspacePullRequestsList).not.toHaveBeenCalled();
    expect(result.current.pullRequests).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it("does not fetch while disabled (tab not open)", () => {
    const client = { workspacePullRequestsList: vi.fn(async () => ({ pullRequests: [] })) };
    runtime.clients.set("host-1", client);

    renderHook(() => usePullRequests({ serverId: "host-1", workspaceId: "ws-a", enabled: false }), {
      wrapper,
    });

    expect(client.workspacePullRequestsList).not.toHaveBeenCalled();
  });
});
