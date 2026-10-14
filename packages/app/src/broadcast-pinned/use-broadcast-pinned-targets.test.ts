// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useBroadcastPinnedTargets } from "./use-broadcast-pinned-targets";

const SERVER_ID = "host-1";
const AGENT_ID = "running-agent";

const WORKSPACE_KEY = `${SERVER_ID}:ws-1`;

vi.mock("@/components/sidebar/sidebar-model", () => ({
  useSidebarModel: () => ({
    pinnedGroups: {
      pinnedChats: [{ workspaceKey: WORKSPACE_KEY, serverId: SERVER_ID, workspaceId: "ws-1" }],
      unpinnedProjects: [],
    },
    workspaceEntriesByKey: new Map([
      [
        WORKSPACE_KEY,
        {
          serverId: SERVER_ID,
          workspaceId: "ws-1",
          name: "Pinned chat",
          currentBranch: null,
        },
      ],
    ]),
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({ settings: { workspaceTitleSource: "title" } }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: SERVER_ID }],
}));

function createTestAgent(agentId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: SERVER_ID,
    id: agentId,
    workspaceId: "ws-1",
    archivedAt: null,
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUserMessageAt: null,
    lastActivityAt: new Date(0),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  };
}

describe("useBroadcastPinnedTargets", () => {
  it("keeps the same targets array reference across a store tick unrelated to agents", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    useSessionStore.getState().setAgents(SERVER_ID, () => {
      const agents = new Map<string, Agent>();
      agents.set(AGENT_ID, createTestAgent(AGENT_ID));
      return agents;
    });

    const { result } = renderHook(() => useBroadcastPinnedTargets());
    expect(result.current.targets.map((target) => target.id)).toEqual([AGENT_ID]);
    const firstTargets = result.current.targets;

    // A streaming tick replaces session state but never touches `session.agents` — the targets
    // projection must not recompute (or re-render) off the back of it.
    act(() => {
      useSessionStore.getState().setAgentStreamTail(SERVER_ID, new Map());
    });

    expect(result.current.targets).toBe(firstTargets);

    useSessionStore.getState().clearSession(SERVER_ID);
  });
});
