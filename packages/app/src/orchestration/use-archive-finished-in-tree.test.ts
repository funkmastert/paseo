// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useArchiveFinishedInTree } from "./use-archive-finished-in-tree";

// `useArchiveFinishedInTree` drives the real `useArchiveAgent` mutation, which in turn touches
// the host-runtime directory sync and react-query caches — plumbing this test doesn't need.
// Mocking `archiveAgent` keeps the test focused on the hook's own batching/status/reset logic,
// while `getManagedSubagent`'s eligibility check still reads the real session store below.
const archiveAgentMock = vi.hoisted(() =>
  vi.fn(async (_input: { serverId: string; agentId: string }): Promise<void> => undefined),
);

vi.mock("@/hooks/use-archive-agent", () => ({
  useArchiveAgent: () => ({ archiveAgent: archiveAgentMock, isArchivingAgent: () => false }),
}));

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function setAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

function archivedAgentIds(): string[] {
  return archiveAgentMock.mock.calls.map(([input]) => input.agentId);
}

beforeEach(() => {
  archiveAgentMock.mockReset();
  archiveAgentMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("useArchiveFinishedInTree", () => {
  it("batches archive calls across multiple parent groups, including a null-parent root group", async () => {
    const rootA = makeAgent({ id: "root-a", parentAgentId: null });
    const rootB = makeAgent({ id: "root-b", parentAgentId: null });
    const childA = makeAgent({ id: "child-a", parentAgentId: "parent-x" });
    setAgents([rootA, rootB, childA]);

    const { result } = renderHook(() =>
      useArchiveFinishedInTree({ serverId: SERVER_ID, agents: [rootA, rootB, childA] }),
    );

    await act(async () => {
      await result.current.archiveFinished();
    });

    expect(archiveAgentMock).toHaveBeenCalledTimes(3);
    expect(archivedAgentIds().sort()).toEqual(["child-a", "root-a", "root-b"]);
    expect(result.current.status).toEqual({ kind: "idle" });
  });

  it("surfaces a failed status with failedCount/totalCount when some archives reject", async () => {
    const agentOne = makeAgent({ id: "agent-1", parentAgentId: null });
    const agentTwo = makeAgent({ id: "agent-2", parentAgentId: null });
    setAgents([agentOne, agentTwo]);
    archiveAgentMock.mockImplementation(async ({ agentId }) => {
      if (agentId === "agent-2") throw new Error("archive failed");
    });

    const { result } = renderHook(() =>
      useArchiveFinishedInTree({ serverId: SERVER_ID, agents: [agentOne, agentTwo] }),
    );

    await act(async () => {
      await result.current.archiveFinished();
    });

    expect(result.current.status).toEqual({ kind: "failed", failedCount: 1, totalCount: 2 });
  });

  it("is a no-op when invoked again while an archive pass is already in flight", async () => {
    const agent = makeAgent({ id: "agent-1", parentAgentId: null });
    setAgents([agent]);
    let resolveArchive!: () => void;
    archiveAgentMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveArchive = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useArchiveFinishedInTree({ serverId: SERVER_ID, agents: [agent] }),
    );

    let firstCall!: Promise<void>;
    act(() => {
      firstCall = result.current.archiveFinished();
    });

    expect(result.current.status.kind).toBe("archiving");
    expect(archiveAgentMock).toHaveBeenCalledTimes(1);

    // Re-invoking while the first pass is mid-flight must not fire another archive call.
    act(() => {
      void result.current.archiveFinished();
    });
    expect(archiveAgentMock).toHaveBeenCalledTimes(1);

    resolveArchive();
    await act(async () => {
      await firstCall;
    });

    expect(result.current.status).toEqual({ kind: "idle" });
    expect(archiveAgentMock).toHaveBeenCalledTimes(1);
  });

  it("resets a failed status to idle once the eligible agent set changes", async () => {
    const agentOne = makeAgent({ id: "agent-1", parentAgentId: null });
    const agentTwo = makeAgent({ id: "agent-2", parentAgentId: null });
    setAgents([agentOne, agentTwo]);
    archiveAgentMock.mockImplementation(async ({ agentId }) => {
      if (agentId === "agent-2") throw new Error("archive failed");
    });

    const { result, rerender } = renderHook(
      ({ agents }: { agents: Agent[] }) =>
        useArchiveFinishedInTree({ serverId: SERVER_ID, agents }),
      { initialProps: { agents: [agentOne, agentTwo] } },
    );

    await act(async () => {
      await result.current.archiveFinished();
    });
    expect(result.current.status).toEqual({ kind: "failed", failedCount: 1, totalCount: 2 });

    const agentThree = makeAgent({ id: "agent-3", parentAgentId: null });
    setAgents([agentOne, agentTwo, agentThree]);
    rerender({ agents: [agentOne, agentTwo, agentThree] });

    await waitFor(() => expect(result.current.status).toEqual({ kind: "idle" }));
  });
});
