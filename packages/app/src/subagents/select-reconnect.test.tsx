/** @vitest-environment jsdom */
import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { invalidateServerDataQueriesAfterReconnect } from "@/data/push-router";
import { useSessionStore } from "@/stores/session-store";
import { useProviderSubagentStore } from "./provider-store";
import { useSubagentsForParent } from "./select";

const SERVER_ID = "reconnect-server";

function makeFakeClient() {
  const listProviderSubagents = vi.fn(async (parentAgentId: string) => ({
    parentAgentId,
    subagents: [],
    requestId: "list-provider-subagents",
    error: null,
  }));
  return { listProviderSubagents };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
  });
});

describe("useSubagentsForParent reconnect repair", () => {
  it("re-issues the provider subagent list refresh on reconnect, not just on param change", async () => {
    const fakeClient = makeFakeClient();
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession(SERVER_ID, fakeClient as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { providerSubagents: true },
    });

    const { unmount } = renderHook(
      () => useSubagentsForParent({ serverId: SERVER_ID, parentAgentId: "parent-a" }),
      { wrapper },
    );

    await waitFor(() => expect(fakeClient.listProviderSubagents).toHaveBeenCalledTimes(1));
    expect(fakeClient.listProviderSubagents).toHaveBeenCalledWith("parent-a");

    // Simulate the daemon client reconnecting: same object identity (as `DaemonClient` reuses
    // itself across reconnects), so nothing in the hook's own dependency array changes. Only the
    // reconnect-repair path in push-router.ts should cause a second fetch.
    invalidateServerDataQueriesAfterReconnect({
      queryClient,
      serverId: SERVER_ID,
      client: fakeClient,
    });

    await waitFor(() => expect(fakeClient.listProviderSubagents).toHaveBeenCalledTimes(2));
    unmount();
  });

  it("stops refreshing a parent once every mount referencing it has unmounted", async () => {
    const fakeClient = makeFakeClient();
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession(SERVER_ID, fakeClient as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { providerSubagents: true },
    });

    const { unmount } = renderHook(
      () => useSubagentsForParent({ serverId: SERVER_ID, parentAgentId: "parent-a" }),
      { wrapper },
    );
    await waitFor(() => expect(fakeClient.listProviderSubagents).toHaveBeenCalledTimes(1));

    unmount();
    fakeClient.listProviderSubagents.mockClear();

    invalidateServerDataQueriesAfterReconnect({
      queryClient,
      serverId: SERVER_ID,
      client: fakeClient,
    });

    // No mounted consumer is tracking "parent-a" anymore, so the reconnect repair must not
    // fetch it again (and must not leak the entry forever).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeClient.listProviderSubagents).not.toHaveBeenCalled();
  });

  it("keeps tracking a parent shared by two mounts until both unmount", async () => {
    const fakeClient = makeFakeClient();
    const queryClient = new QueryClient();
    useSessionStore.getState().initializeSession(SERVER_ID, fakeClient as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: null,
      version: null,
      features: { providerSubagents: true },
    });

    const first = renderHook(
      () => useSubagentsForParent({ serverId: SERVER_ID, parentAgentId: "parent-a" }),
      { wrapper },
    );
    const second = renderHook(
      () => useSubagentsForParent({ serverId: SERVER_ID, parentAgentId: "parent-a" }),
      { wrapper },
    );
    await waitFor(() => expect(fakeClient.listProviderSubagents).toHaveBeenCalled());

    first.unmount();
    fakeClient.listProviderSubagents.mockClear();

    invalidateServerDataQueriesAfterReconnect({
      queryClient,
      serverId: SERVER_ID,
      client: fakeClient,
    });

    // The second mount is still active, so the parent must still be tracked.
    await waitFor(() => expect(fakeClient.listProviderSubagents).toHaveBeenCalledWith("parent-a"));

    second.unmount();
  });
});
