// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import {
  resolveBroadcastTargetSendPlan,
  useBroadcastPinnedComposer,
} from "./use-broadcast-pinned-composer";
import type { BroadcastPinnedTarget } from "./broadcast-pinned-targets";

const SERVER_ID = "host-1";
const RUNNING_AGENT_ID = "running-agent";
const IDLE_AGENT_ID = "idle-agent";

const TARGETS: BroadcastPinnedTarget[] = [
  {
    id: RUNNING_AGENT_ID,
    serverId: SERVER_ID,
    workspaceId: "ws-running",
    label: "Running leader",
    agentTitle: null,
    status: "running",
  },
  {
    id: IDLE_AGENT_ID,
    serverId: SERVER_ID,
    workspaceId: "ws-idle",
    label: "Idle leader",
    agentTitle: null,
    status: "idle",
  },
];

const sendAgentMessage = vi.fn().mockResolvedValue(undefined);
const fakeClient = { sendAgentMessage, uploadFile: vi.fn() };

vi.mock("./use-broadcast-pinned-targets", () => ({
  useBroadcastPinnedTargets: () => ({ targets: TARGETS, hasTargets: true }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({
    settings: { ...DEFAULT_CLIENT_SETTINGS, sendBehavior: "queue" },
    isLoading: false,
    error: null,
    updateSettings: vi.fn(),
    resetSettings: vi.fn(),
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => fakeClient }),
}));

function createTestAgent(agentId: string, overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: SERVER_ID,
    id: agentId,
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

describe("useBroadcastPinnedComposer", () => {
  it("queues the running target locally and dispatches the idle target, against the real session store", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    useSessionStore.getState().setAgents(SERVER_ID, () => {
      const agents = new Map<string, Agent>();
      agents.set(
        RUNNING_AGENT_ID,
        createTestAgent(RUNNING_AGENT_ID, {
          status: "running",
          turn: {
            phase: "open",
            turnId: "turn-1",
            startedAt: new Date(),
            cancellationRequestId: null,
          },
        }),
      );
      agents.set(IDLE_AGENT_ID, createTestAgent(IDLE_AGENT_ID));
      return agents;
    });

    const { result } = renderHook(() => useBroadcastPinnedComposer());

    let sendResult: Awaited<ReturnType<typeof result.current.onSend>> | undefined;
    await act(async () => {
      sendResult = await result.current.onSend("status please", [RUNNING_AGENT_ID, IDLE_AGENT_ID]);
    });

    expect(sendResult?.succeeded.sort()).toEqual([IDLE_AGENT_ID, RUNNING_AGENT_ID]);
    expect(sendResult?.failed).toEqual([]);

    const queued = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.queuedMessages.get(RUNNING_AGENT_ID);
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.text).toBe("status please");

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      IDLE_AGENT_ID,
      "status please",
      expect.anything(),
    );

    useSessionStore.getState().clearSession(SERVER_ID);
  });
});

describe("resolveBroadcastTargetSendPlan", () => {
  it("queues locally when send behavior is queue and the target is running", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "queue",
      isRunning: true,
      turnId: "turn-1",
    });
    expect(plan).toEqual({ queueLocally: true });
  });

  it("dispatches with steer when send behavior is queue and the target is idle", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "queue",
      isRunning: false,
      turnId: null,
    });
    expect(plan).toEqual({ queueLocally: false, behavior: "steer", turnId: undefined });
  });

  it("dispatches with steer and the active turnId when send behavior is steer", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "steer",
      isRunning: true,
      turnId: "turn-1",
    });
    expect(plan).toEqual({ queueLocally: false, behavior: "steer", turnId: "turn-1" });
  });

  it("dispatches with interrupt regardless of whether the target is running", () => {
    const plan = resolveBroadcastTargetSendPlan({
      sendBehavior: "interrupt",
      isRunning: true,
      turnId: "turn-1",
    });
    expect(plan).toEqual({ queueLocally: false, behavior: "interrupt" });
  });
});
