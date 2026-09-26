// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider, type UseQueryOptions } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    const { result } = renderHook(() => useProviderUsage("test-server"), { wrapper });
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).not.toHaveProperty("refetchInterval");
  });

  it("passes refetchInterval through to the query options when provided", async () => {
    const { result } = renderHook(
      () => useProviderUsage("test-server", { refetchInterval: 75_000 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.view.kind).toBe("ready"));

    expect(capturedOptions.at(-1)).toMatchObject({ refetchInterval: 75_000 });
  });
});
