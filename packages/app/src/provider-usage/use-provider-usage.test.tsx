// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderUsage } from "./use-provider-usage";

const listProviderUsageMock = vi.hoisted(() => vi.fn(async () => ({ providers: [] })));
const capturedOptions = vi.hoisted(() => [] as UseQueryOptions[]);

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ listProviderUsage: listProviderUsageMock }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "test-server": { serverInfo: { features: { providerUsageList: true } } },
      },
    }),
}));

// Wrap the real useQuery so the test can inspect exactly what options the hook builds,
// while still exercising the real fetch/cache behavior underneath.
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: UseQueryOptions) => {
      capturedOptions.push(options);
      return actual.useQuery(options);
    },
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useProviderUsage refetchInterval", () => {
  beforeEach(() => {
    listProviderUsageMock.mockClear();
    capturedOptions.length = 0;
  });

  it("omits refetchInterval from the query options when not provided (existing call sites)", async () => {
    const { result, unmount } = renderHook(() => useProviderUsage("test-server"), { wrapper });
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).not.toHaveProperty("refetchInterval");
    unmount();
  });

  it("passes refetchInterval through to the query options when provided", async () => {
    const { result, unmount } = renderHook(
      () => useProviderUsage("test-server", { refetchInterval: 75_000 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).toMatchObject({ refetchInterval: 75_000 });
    unmount();
  });

  it("omits refetchIntervalInBackground and networkMode by default", async () => {
    const { result, unmount } = renderHook(() => useProviderUsage("test-server"), { wrapper });
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).toMatchObject({ refetchIntervalInBackground: false });
    expect(capturedOptions.at(-1)).not.toHaveProperty("networkMode");
    unmount();
  });

  it("passes refetchIntervalInBackground and networkMode through when provided", async () => {
    const { result, unmount } = renderHook(
      () =>
        useProviderUsage("test-server", {
          refetchIntervalInBackground: true,
          networkMode: "always",
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).toMatchObject({
      refetchIntervalInBackground: true,
      networkMode: "always",
    });
    unmount();
  });

  it("keeps refetchOnWindowFocus/refetchOnReconnect as a plain boolean for catchUpOnFocus alone", async () => {
    const { result, unmount } = renderHook(
      () => useProviderUsage("test-server", { catchUpOnFocus: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
    unmount();
  });

  it("escalates refetchOnWindowFocus/refetchOnReconnect to 'always' when alwaysCatchUp is set", async () => {
    const { result, unmount } = renderHook(
      () => useProviderUsage("test-server", { catchUpOnFocus: true, alwaysCatchUp: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).toMatchObject({
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
    });
    unmount();
  });
});

describe("useProviderUsage focus catch-up behavior", () => {
  beforeEach(() => {
    listProviderUsageMock.mockClear();
    capturedOptions.length = 0;
  });

  afterEach(() => {
    // Reset to the jsdom default so later tests don't inherit a forced focus state.
    focusManager.setFocused(undefined);
  });

  it("refetches on window focus even when the last fetch is under five minutes old", async () => {
    const { result, unmount } = renderHook(
      () => useProviderUsage("test-server", { catchUpOnFocus: true, alwaysCatchUp: true }),
      { wrapper },
    );
    try {
      await waitFor(() => expect(result.current.view.kind).toBe("ready"));
      listProviderUsageMock.mockClear();

      focusManager.setFocused(false);
      focusManager.setFocused(true);

      await waitFor(() => expect(listProviderUsageMock).toHaveBeenCalledTimes(1));
    } finally {
      unmount();
    }
  });

  it("does not refetch on focus for a plain call with fresh data", async () => {
    const { result, unmount } = renderHook(() => useProviderUsage("test-server"), { wrapper });
    try {
      await waitFor(() => expect(result.current.view.kind).toBe("ready"));
      listProviderUsageMock.mockClear();

      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(listProviderUsageMock).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});

describe("useProviderUsage background polling", () => {
  beforeEach(() => {
    listProviderUsageMock.mockClear();
    capturedOptions.length = 0;
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it("keeps polling the configured interval while the document is hidden", async () => {
    const { result, unmount } = renderHook(
      () =>
        useProviderUsage("test-server", { refetchInterval: 15, refetchIntervalInBackground: true }),
      { wrapper },
    );
    try {
      await waitFor(() => expect(result.current.view.kind).toBe("ready"));
      listProviderUsageMock.mockClear();

      focusManager.setFocused(false);

      await waitFor(() => expect(listProviderUsageMock.mock.calls.length).toBeGreaterThan(0));
    } finally {
      unmount();
    }
  });

  it("skips the interval tick while hidden without refetchIntervalInBackground", async () => {
    const { result, unmount } = renderHook(
      () => useProviderUsage("test-server", { refetchInterval: 15 }),
      { wrapper },
    );
    try {
      await waitFor(() => expect(result.current.view.kind).toBe("ready"));
      listProviderUsageMock.mockClear();

      focusManager.setFocused(false);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(listProviderUsageMock).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
