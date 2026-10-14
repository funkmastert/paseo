// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamViewportHandle } from "./strategy";
import { useJumpToStart } from "./use-jump-to-start";

interface AgentStreamTailStoreState {
  sessions: Record<string, { agentStreamTail: Map<string, Array<{ id: string }>> } | undefined>;
}

const runtime = vi.hoisted(() => ({
  fetchAgentTimeline: vi.fn(),
}));
const store = vi.hoisted(() => ({
  state: { sessions: {} } as AgentStreamTailStoreState,
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ fetchAgentTimeline: runtime.fetchAgentTimeline }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => store.state },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setEarliestItem(serverId: string, agentId: string, id: string | null): void {
  store.state.sessions[serverId] = {
    agentStreamTail: new Map(id ? [[agentId, [{ id }]]] : []),
  };
}

// scrollToStart is deferred one animation frame past the fetch resolving
// (see use-jump-to-start.ts), so tests need a real frame to pass before
// asserting on it either way.
function waitAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("useJumpToStart", () => {
  beforeEach(() => {
    runtime.fetchAgentTimeline.mockReset();
    store.state = { sessions: {} };
  });

  it("scrolls to the earliest item once the fetch resolves", async () => {
    setEarliestItem("server-1", "agent-1", "item-earliest");
    const fetch = deferred<unknown>();
    runtime.fetchAgentTimeline.mockReturnValue(fetch.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    viewportRef.current = {
      scrollToBottom: vi.fn(),
      scrollToStart: vi.fn(),
      prepareForViewportChange: vi.fn(),
    };
    const revealLoadedHistory = vi.fn(() => true);
    const { result } = renderHook(() =>
      useJumpToStart({
        agentId: "agent-1",
        serverId: "server-1",
        hasRemoteOlderHistory: true,
        revealLoadedHistory,
        viewportRef,
        onError: vi.fn(),
      }),
    );

    act(() => {
      result.current.jumpToStart();
    });
    expect(result.current.isJumpingToStart).toBe(true);

    await act(async () => {
      fetch.resolve(undefined);
      await fetch.promise;
    });
    await waitFor(() => expect(result.current.isJumpingToStart).toBe(false));
    await act(() => waitAnimationFrame());

    expect(viewportRef.current.scrollToStart).toHaveBeenCalledWith("item-earliest");
  });

  it("does not scroll if scroll-to-bottom supersedes the jump before the fetch resolves", async () => {
    setEarliestItem("server-1", "agent-1", "item-earliest");
    const fetch = deferred<unknown>();
    runtime.fetchAgentTimeline.mockReturnValue(fetch.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    viewportRef.current = {
      scrollToBottom: vi.fn(),
      scrollToStart: vi.fn(),
      prepareForViewportChange: vi.fn(),
    };
    const revealLoadedHistory = vi.fn(() => true);
    const { result } = renderHook(() =>
      useJumpToStart({
        agentId: "agent-1",
        serverId: "server-1",
        hasRemoteOlderHistory: true,
        revealLoadedHistory,
        viewportRef,
        onError: vi.fn(),
      }),
    );

    act(() => {
      result.current.jumpToStart();
    });

    // The user pressed scroll-to-bottom while the daemon round trip for the
    // jump was still in flight.
    act(() => {
      result.current.invalidateJumpToStart();
    });

    await act(async () => {
      fetch.resolve(undefined);
      await fetch.promise;
    });
    await waitFor(() => expect(result.current.isJumpingToStart).toBe(false));
    await act(() => waitAnimationFrame());

    expect(revealLoadedHistory).not.toHaveBeenCalled();
    expect(viewportRef.current.scrollToStart).not.toHaveBeenCalled();
  });

  it("does not scroll if the agent changes before the fetch resolves", async () => {
    setEarliestItem("server-1", "agent-1", "item-earliest");
    const fetch = deferred<unknown>();
    runtime.fetchAgentTimeline.mockReturnValue(fetch.promise);
    const viewportRef = createRef<StreamViewportHandle>();
    viewportRef.current = {
      scrollToBottom: vi.fn(),
      scrollToStart: vi.fn(),
      prepareForViewportChange: vi.fn(),
    };
    const revealLoadedHistory = vi.fn(() => true);
    const { result, rerender } = renderHook(
      ({ agentId }) =>
        useJumpToStart({
          agentId,
          serverId: "server-1",
          hasRemoteOlderHistory: true,
          revealLoadedHistory,
          viewportRef,
          onError: vi.fn(),
        }),
      { initialProps: { agentId: "agent-1" } },
    );

    act(() => {
      result.current.jumpToStart();
    });

    rerender({ agentId: "agent-2" });

    await act(async () => {
      fetch.resolve(undefined);
      await fetch.promise;
    });
    await waitFor(() => expect(result.current.isJumpingToStart).toBe(false));
    await act(() => waitAnimationFrame());

    expect(viewportRef.current.scrollToStart).not.toHaveBeenCalled();
  });
});
