// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTokenUsage } from "./use-token-usage";

const getTokenUsageBreakdownMock = vi.hoisted(() =>
  vi.fn(async ({ range }: { range: string }) => ({
    requestId: "req-1",
    generatedAt: "2026-10-07T00:00:00.000Z",
    range,
    rangeStartMs: 0,
    rows: [],
    coverage: {
      enabled: true,
      recordingSinceMs: null,
      backfill: { state: "done", filesDone: 1, filesTotal: 1 },
    },
  })),
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
});
