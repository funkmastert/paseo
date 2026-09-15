// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpStatusQueryKey, useMcpStatus, type McpStatusPayload } from "./use-mcp-status";

const HOST: { serverId: string; label: string } = { serverId: "server-1", label: "Local" };

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

const startMcpGatewayAuthMock = vi.hoisted(() => vi.fn());
const adoptMcpGatewayServerMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [HOST],
  useHostRuntimeClient: () => ({
    startMcpGatewayAuth: startMcpGatewayAuthMock,
    adoptMcpGatewayServer: adoptMcpGatewayServerMock,
  }),
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => HOST.serverId,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(sessionState.current),
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: openExternalUrlMock,
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useMcpStatus", () => {
  beforeEach(() => {
    sessionState.current = {
      sessions: {
        "server-1": {
          serverInfo: { features: {} },
          agents: new Map(),
        },
      },
    };
    startMcpGatewayAuthMock.mockReset();
    adoptMcpGatewayServerMock.mockReset();
    openExternalUrlMock.mockClear();
  });

  it("brokers a session-reported server through the daemon and opens the returned sign-in URL", async () => {
    sessionState.current = {
      sessions: {
        "server-1": {
          serverInfo: { features: { mcpStatus: true, mcpGatewayAdopt: true } },
          agents: new Map(),
        },
      },
    };
    adoptMcpGatewayServerMock.mockResolvedValue({
      requestId: "req-3",
      authorizationUrl: "https://linear.example/authorize",
      error: null,
    });

    const { result } = renderHook(() => useMcpStatus(), { wrapper });

    await result.current.adoptServer("linear", "agent-9");

    expect(adoptMcpGatewayServerMock).toHaveBeenCalledWith("linear", "agent-9");
    expect(openExternalUrlMock).toHaveBeenCalledWith("https://linear.example/authorize");
  });

  it("opens claude.ai's connector settings for claude.ai connectors", async () => {
    const { result } = renderHook(() => useMcpStatus(), { wrapper });

    await result.current.openClaudeAiConnectors();

    expect(openExternalUrlMock).toHaveBeenCalledWith("https://claude.ai/settings/connectors");
  });

  it("gates off when the daemon has no mcpStatus feature flag", () => {
    const { result } = renderHook(() => useMcpStatus(), { wrapper });

    expect(result.current.supportsMcpStatus).toBe(false);
    expect(result.current.model.hasData).toBe(false);
  });

  it("builds rows from the cached mcp_status_update payload once the feature flag is on", async () => {
    sessionState.current = {
      sessions: {
        "server-1": {
          serverInfo: { features: { mcpStatus: true } },
          agents: new Map(),
        },
      },
    };

    function Wrapper({ children }: { children: ReactNode }) {
      const [queryClient] = React.useState(() => {
        const client = new QueryClient();
        const payload: McpStatusPayload = {
          servers: [{ name: "zeeq", status: "needs-auth", critical: true, lastChangedAt: 1 }],
          generatedAt: "2026-09-12T00:00:00.000Z",
        };
        client.setQueryData(mcpStatusQueryKey(HOST.serverId), payload);
        return client;
      });
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(() => useMcpStatus(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.supportsMcpStatus).toBe(true));
    expect(result.current.model.hasData).toBe(true);
    expect(result.current.model.rows.map((row) => row.name)).toEqual(["zeeq"]);
  });

  it("starts auth through the daemon client and opens the returned URL", async () => {
    sessionState.current = {
      sessions: {
        "server-1": {
          serverInfo: { features: { mcpStatus: true } },
          agents: new Map(),
        },
      },
    };
    startMcpGatewayAuthMock.mockResolvedValue({
      requestId: "req-1",
      authorizationUrl: "https://example.com/authorize",
      error: null,
    });

    const { result } = renderHook(() => useMcpStatus(), { wrapper });

    await result.current.startAuth("zeeq");

    expect(startMcpGatewayAuthMock).toHaveBeenCalledWith("zeeq");
    expect(openExternalUrlMock).toHaveBeenCalledWith("https://example.com/authorize");
  });

  it("resolves with the daemon's error instead of throwing on a known auth failure", async () => {
    sessionState.current = {
      sessions: {
        "server-1": {
          serverInfo: { features: { mcpStatus: true } },
          agents: new Map(),
        },
      },
    };
    startMcpGatewayAuthMock.mockResolvedValue({
      requestId: "req-2",
      authorizationUrl: null,
      error: "zeeq uses static auth and cannot be re-authenticated interactively",
    });

    const { result } = renderHook(() => useMcpStatus(), { wrapper });

    const authResult = await result.current.startAuth("zeeq");

    expect(authResult).toEqual({
      requestId: "req-2",
      authorizationUrl: null,
      error: "zeeq uses static auth and cannot be re-authenticated interactively",
    });
    // A resolved known failure never opens a URL — the caller surfaces `error` inline instead.
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });
});
