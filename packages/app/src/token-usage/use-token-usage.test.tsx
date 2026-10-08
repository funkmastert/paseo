// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillRefetchInterval, useTokenUsage } from "./use-token-usage";
import type { TokenUsageBreakdown } from "./token-usage-model";

function breakdown(backfillState: string): TokenUsageBreakdown {
  return {
    requestId: "req-1",
    generatedAt: "2026-10-07T00:00:00.000Z",
    range: "7d",
    rangeStartMs: 0,
    rows: [],
    coverage: {
      enabled: true,
      recordingSinceMs: null,
      backfill: { state: backfillState, filesDone: 1, filesTotal: 10 },
    },
  };
}

// `vi.hoisted` moves this call above the module's imports, but type-only references are erased
// before that matters — the explicit return type is what lets every `mockResolvedValueOnce` below
// accept a full `TokenUsageBreakdown`, not just the shape of this default implementation.
const getTokenUsageBreakdownMock = vi.hoisted(() =>
  vi.fn(
    async ({
      range,
    }: {
      range: string;
    }): Promise<import("./token-usage-model").TokenUsageBreakdown> => ({
      requestId: "req-1",
      generatedAt: "2026-10-07T00:00:00.000Z",
      range: range as "24h" | "7d" | "30d",
      rangeStartMs: 0,
      rows: [],
      coverage: {
        enabled: true,
        recordingSinceMs: null,
        backfill: { state: "done", filesDone: 1, filesTotal: 1 },
      },
    }),
  ),
);
const supportsTokenUsage = vi.hoisted(() => ({ value: true }));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ getTokenUsageBreakdown: getTokenUsageBreakdownMock }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => supportsTokenUsage.value,
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useTokenUsage", () => {
  beforeEach(() => {
    getTokenUsageBreakdownMock.mockClear();
    supportsTokenUsage.value = true;
  });

  it("does not fetch when the feature flag is absent", async () => {
    supportsTokenUsage.value = false;
    const { result } = renderHook(() => useTokenUsage("test-server", "7d"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(getTokenUsageBreakdownMock).not.toHaveBeenCalled();
    expect(result.current.isSupported).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("fetches with the given range when the feature is supported", async () => {
    const { result } = renderHook(() => useTokenUsage("test-server", "7d"), { wrapper });

    await waitFor(() => expect(result.current.data?.range).toBe("7d"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledWith({ range: "7d" });
  });

  it("refetches when the range changes", async () => {
    const { result, rerender } = renderHook(
      ({ range }: { range: "24h" | "7d" | "30d" }) => useTokenUsage("test-server", range),
      { wrapper, initialProps: { range: "7d" } },
    );
    await waitFor(() => expect(result.current.data?.range).toBe("7d"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(1);

    rerender({ range: "30d" });
    await waitFor(() => expect(result.current.data?.range).toBe("30d"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(2);
    expect(getTokenUsageBreakdownMock).toHaveBeenLastCalledWith({ range: "30d" });
  });

  it("does not refetch on a rerender with the same range", async () => {
    const { result, rerender } = renderHook(
      ({ range }: { range: "24h" | "7d" | "30d" }) => useTokenUsage("test-server", range),
      { wrapper, initialProps: { range: "7d" } },
    );
    await waitFor(() => expect(result.current.data?.range).toBe("7d"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(1);

    rerender({ range: "7d" });
    await waitFor(() => expect(result.current.data?.range).toBe("7d"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(1);
  });

  it("polls on the backfill cadence while running, and stops once done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getTokenUsageBreakdownMock.mockResolvedValueOnce(breakdown("running"));
    getTokenUsageBreakdownMock.mockResolvedValueOnce(breakdown("done"));

    const { result } = renderHook(() => useTokenUsage("test-server", "7d"), { wrapper });
    await waitFor(() => expect(result.current.data?.coverage.backfill.state).toBe("running"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(15_000));
    await waitFor(() => expect(result.current.data?.coverage.backfill.state).toBe("done"));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(getTokenUsageBreakdownMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

describe("backfillRefetchInterval", () => {
  it("polls while pending or running", () => {
    expect(backfillRefetchInterval(breakdown("pending"))).toBe(15_000);
    expect(backfillRefetchInterval(breakdown("running"))).toBe(15_000);
  });

  it("does not poll once done, off, an unrecognized state, or with no data yet", () => {
    expect(backfillRefetchInterval(breakdown("done"))).toBe(false);
    expect(backfillRefetchInterval(breakdown("off"))).toBe(false);
    expect(backfillRefetchInterval(breakdown("paused"))).toBe(false);
    expect(backfillRefetchInterval(undefined)).toBe(false);
  });
});
