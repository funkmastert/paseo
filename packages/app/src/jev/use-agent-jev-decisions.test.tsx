// @vitest-environment jsdom

import React, { type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JevDecisionRecord } from "@getpaseo/protocol/jev/rpc-schemas";
import { useAgentJevDecisions } from "./use-agent-jev-decisions";

const sessionState = vi.hoisted(() => ({
  current: {
    sessions: { "server-1": { serverInfo: { features: {} as Record<string, boolean> } } },
  },
}));

const client = vi.hoisted(() => ({
  listJevDecisions: vi.fn(),
  jevStatus: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(sessionState.current),
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const DECISION: JevDecisionRecord = {
  agentId: "agent-1",
  callId: "call-1",
  feature: "awayReply",
  question: "Does this wait need Tyler, and what should be said?",
  verdict: "blocked_on_person 0.12, reply_kind confirm 0.84",
  confidence: 0.84,
  action: "would reply (routine confirmation); dry run, nothing sent",
  applied: false,
  at: "2026-09-29T17:00:00.000Z",
  costUsd: 0,
};

function withFeatures(features: Record<string, boolean>) {
  sessionState.current = { sessions: { "server-1": { serverInfo: { features } } } };
}

describe("useAgentJevDecisions", () => {
  beforeEach(() => {
    client.listJevDecisions.mockReset();
    client.jevStatus.mockReset();
  });

  it("never asks an older daemon, so the section stays absent", async () => {
    withFeatures({});
    const { result } = renderHook(() => useAgentJevDecisions("server-1", "agent-1"), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({ data: undefined, isSupported: false });
    expect(client.listJevDecisions).not.toHaveBeenCalled();
    expect(client.jevStatus).not.toHaveBeenCalled();
  });

  it("does not ask while the popover is closed", async () => {
    withFeatures({ jev: true });
    renderHook(() => useAgentJevDecisions("server-1", "agent-1", { enabled: false }), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.listJevDecisions).not.toHaveBeenCalled();
  });

  it("reads the agent's decisions and the feature modes on a JEV host", async () => {
    withFeatures({ jev: true });
    client.listJevDecisions.mockResolvedValue({
      requestId: "r1",
      agentId: "agent-1",
      decisions: [DECISION],
    });
    client.jevStatus.mockResolvedValue({ requestId: "r2", status: { provider: "fake" } });

    const { result } = renderHook(() => useAgentJevDecisions("server-1", "agent-1"), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(client.listJevDecisions).toHaveBeenCalledWith("agent-1");
    expect(result.current.data).toEqual({ decisions: [DECISION], status: { provider: "fake" } });
  });

  it("keeps the list when the status read fails", async () => {
    withFeatures({ jev: true });
    client.listJevDecisions.mockResolvedValue({
      requestId: "r1",
      agentId: "agent-1",
      decisions: [DECISION],
    });
    client.jevStatus.mockRejectedValue(new Error("timeout"));

    const { result } = renderHook(() => useAgentJevDecisions("server-1", "agent-1"), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ decisions: [DECISION], status: null });
  });
});
