// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompactionEpisodesList, useCompactionEpisodesSummary } from "./use-compaction-episodes";

const HOST_ID = "server-1";

const sessionState = vi.hoisted(() => ({
  current: {
    sessions: {
      "server-1": {
        serverInfo: { features: {} as Record<string, boolean> },
        agents: new Map(),
      },
    },
  },
}));

const compactionEpisodesSummaryMock = vi.hoisted(() => vi.fn());
const compactionEpisodesListMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    compactionEpisodesSummary: compactionEpisodesSummaryMock,
    compactionEpisodesList: compactionEpisodesListMock,
  }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(sessionState.current),
}));

function enableCompactionLedger(): void {
  sessionState.current = {
    sessions: {
      [HOST_ID]: {
        serverInfo: { features: { compactionLedger: true } },
        agents: new Map(),
      },
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useCompactionEpisodesSummary", () => {
  beforeEach(() => {
    sessionState.current = {
      sessions: { [HOST_ID]: { serverInfo: { features: {} }, agents: new Map() } },
    };
    compactionEpisodesSummaryMock.mockReset();
    compactionEpisodesListMock.mockReset();
  });

  it("reports unsupported and no data when the daemon lacks the feature flag", () => {
    const { result } = renderHook(() => useCompactionEpisodesSummary(HOST_ID, "7d", undefined), {
      wrapper,
    });

    expect(result.current.isSupported).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(compactionEpisodesSummaryMock).not.toHaveBeenCalled();
  });

  it("fetches the summary once the feature flag is on", async () => {
    enableCompactionLedger();
    compactionEpisodesSummaryMock.mockResolvedValue({
      requestId: "req-1",
      summary: {
        count: 2,
        totalCostWeightedTokens: 175,
        averageCostWeightedTokens: 87.5,
        totalEstimatedSavedWeightedTokens: 38_000,
        measuredCount: 2,
        unmeasuredCount: 0,
      },
    });

    const { result } = renderHook(() => useCompactionEpisodesSummary(HOST_ID, "7d", undefined), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data?.count).toBe(2));
    expect(compactionEpisodesSummaryMock).toHaveBeenCalledWith({
      range: "7d",
      agentId: undefined,
    });
  });

  it("recomputes when range changes", async () => {
    enableCompactionLedger();
    compactionEpisodesSummaryMock.mockResolvedValue({
      requestId: "req-1",
      summary: {
        count: 1,
        totalCostWeightedTokens: 10,
        averageCostWeightedTokens: 10,
        totalEstimatedSavedWeightedTokens: 0,
        measuredCount: 1,
        unmeasuredCount: 0,
      },
    });

    const { rerender } = renderHook(
      ({ range }: { range: "today" | "7d" | "all" }) =>
        useCompactionEpisodesSummary(HOST_ID, range, undefined),
      { wrapper, initialProps: { range: "7d" } },
    );

    await waitFor(() =>
      expect(compactionEpisodesSummaryMock).toHaveBeenCalledWith({
        range: "7d",
        agentId: undefined,
      }),
    );

    rerender({ range: "today" });

    await waitFor(() =>
      expect(compactionEpisodesSummaryMock).toHaveBeenCalledWith({
        range: "today",
        agentId: undefined,
      }),
    );
  });
});

describe("useCompactionEpisodesList", () => {
  beforeEach(() => {
    sessionState.current = {
      sessions: { [HOST_ID]: { serverInfo: { features: {} }, agents: new Map() } },
    };
    compactionEpisodesSummaryMock.mockReset();
    compactionEpisodesListMock.mockReset();
  });

  it("reports unsupported and no episodes when the daemon lacks the feature flag", () => {
    const { result } = renderHook(() => useCompactionEpisodesList(HOST_ID, { range: "all" }), {
      wrapper,
    });

    expect(result.current.isSupported).toBe(false);
    expect(result.current.episodes).toEqual([]);
    expect(compactionEpisodesListMock).not.toHaveBeenCalled();
  });

  it("fetches the first page once the feature flag is on", async () => {
    enableCompactionLedger();
    compactionEpisodesListMock.mockResolvedValue({
      requestId: "req-1",
      episodes: [{ id: "leader-1:1000", agentId: "leader-1" }],
      nextCursor: null,
    });

    const { result } = renderHook(() => useCompactionEpisodesList(HOST_ID, { range: "all" }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.episodes).toHaveLength(1));
    expect(result.current.hasMore).toBe(false);
  });

  it("loadMore appends the previous page's nextCursor", async () => {
    enableCompactionLedger();
    compactionEpisodesListMock
      .mockResolvedValueOnce({
        requestId: "req-1",
        episodes: [{ id: "a", agentId: "leader-1" }],
        nextCursor: "1000",
      })
      .mockResolvedValueOnce({
        requestId: "req-2",
        episodes: [{ id: "b", agentId: "leader-1" }],
        nextCursor: null,
      });

    const { result } = renderHook(() => useCompactionEpisodesList(HOST_ID, { range: "all" }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.hasMore).toBe(true));
    result.current.loadMore();

    await waitFor(() => expect(result.current.episodes).toHaveLength(2));
    expect(compactionEpisodesListMock).toHaveBeenLastCalledWith({
      range: "all",
      agentId: undefined,
      cursor: "1000",
    });
  });

  it("resets to a single first page when the filter (agentId) changes", async () => {
    enableCompactionLedger();
    compactionEpisodesListMock.mockResolvedValue({
      requestId: "req-1",
      episodes: [{ id: "a", agentId: "leader-1" }],
      nextCursor: "1000",
    });

    const { result, rerender } = renderHook(
      ({ agentId }: { agentId: string | undefined }) =>
        useCompactionEpisodesList(HOST_ID, { range: "all", agentId }),
      { wrapper, initialProps: { agentId: undefined as string | undefined } },
    );

    await waitFor(() => expect(result.current.hasMore).toBe(true));
    result.current.loadMore();
    await waitFor(() => expect(compactionEpisodesListMock).toHaveBeenCalledTimes(2));

    rerender({ agentId: "leader-2" });

    await waitFor(() =>
      expect(compactionEpisodesListMock).toHaveBeenLastCalledWith({
        range: "all",
        agentId: "leader-2",
        cursor: undefined,
      }),
    );
  });
});
