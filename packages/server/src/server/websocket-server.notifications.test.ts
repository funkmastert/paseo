import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import { createTestDaemonConfigStore } from "./test-utils/daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload, PushSendMeta } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { JevService } from "./jev/contract.js";
import { createTestJevService, type TestJevServiceOptions } from "./jev/fake.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    providerId?: string;
    timestamp?: string;
  }): Promise<void>;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];
  readonly levels: Array<PushSendMeta["level"]> = [];

  async send(payload: PushPayload, meta?: PushSendMeta): Promise<void> {
    this.sent.push(payload);
    this.levels.push(meta?.level);
  }
}

function createServer(
  agentManagerOverrides?: Record<string, unknown>,
  options: { jev?: JevService; paseoHome?: string } = {},
) {
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => ({ workspaceId: WORKSPACE_ID, pendingPermissions: new Map() })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    options.paseoHome ?? "/tmp/paseo-test",
    createTestDaemonConfigStore(),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.jev,
  );

  return { server, agentManager, pushNotifications };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  subscribed = true,
) {
  return {
    getClientActivity: vi.fn(() => activity),
    supports: () => false,
    supportsForSource: () => false,
    subscribesToAgent: vi.fn(async () => subscribed),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: { subscribed?: boolean } = {},
) {
  const ws = createOpenSocket();
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: createSessionWithActivity(activity, options.subscribed ?? true),
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("ranks a root agent's finish as an alert and a delegated child's as a notice", async () => {
    const labelsById: Record<string, Record<string, string>> = {
      "agent-root": {},
      "agent-child": { "paseo.parent-agent-id": "agent-root" },
    };
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn((agentId: string) => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: labelsById[agentId],
        pendingPermissions: new Map(),
      })),
    });

    for (const agentId of ["agent-root", "agent-child"]) {
      await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId,
        provider: "claude",
        reason: "finished",
      });
    }

    expect(pushNotifications.levels).toEqual(["alert", "notice"]);
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });
});

describe("VoiceAssistantWebSocketServer finish triage (JEV feature 3b)", () => {
  const homes: string[] = [];

  afterEach(() => {
    // The finish record is appended off the push path; retry while its last write lands.
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });

  function createTriagingServer(jevOptions: TestJevServiceOptions) {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "ws-finish-triage-"));
    homes.push(paseoHome);
    const jev = createTestJevService({
      config: { notificationTriage: { shadow: false } },
      answers: { needs_person: { type: "choice", choice: "routine", confidence: 0.92 } },
      ...jevOptions,
      service: { resolveAgentCwds: async () => [paseoHome], ...jevOptions.service },
    });
    const fetchTimeline = vi.fn((): { rows: unknown[] } => ({ rows: [] }));
    const created = createServer(
      {
        getAgent: vi.fn(() => ({
          config: { title: "Tidy up" },
          cwd: paseoHome,
          workspaceId: WORKSPACE_ID,
          labels: {},
          pendingPermissions: new Map(),
        })),
        getLastAssistantMessage: vi.fn(async () => "Removed the stale branch. All tidy."),
        fetchTimeline,
        listAgents: vi.fn(() => []),
        subscribeOperatorSignals: vi.fn(() => () => {}),
      },
      { jev, paseoHome },
    );
    return { ...created, jev, fetchTimeline };
  }

  async function broadcastFinish(server: VoiceAssistantWebSocketServer) {
    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-root",
      reason: "finished",
    });
  }

  it("sends a scripted routine finish as a notice", async () => {
    const { server, pushNotifications } = createTriagingServer({});
    await broadcastFinish(server);
    await vi.waitFor(() => expect(pushNotifications.levels).toEqual(["notice"]));
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("sends the alert when JEV times out", async () => {
    const { server, pushNotifications } = createTriagingServer({ behavior: { kind: "timeout" } });
    await broadcastFinish(server);
    expect(pushNotifications.sent).toHaveLength(0);
    // The feature's 3-second deadline, then the alert.
    await vi.waitFor(() => expect(pushNotifications.levels).toEqual(["alert"]), {
      timeout: 6_000,
    });
  });

  it("sends the alert when JEV throws", async () => {
    const { server, pushNotifications, jev } = createTriagingServer({});
    vi.spyOn(jev, "decide").mockRejectedValue(new Error("boom"));
    await broadcastFinish(server);
    await vi.waitFor(() => expect(pushNotifications.levels).toEqual(["alert"]));
  });

  it("sends the alert when the state builder throws", async () => {
    const { server, pushNotifications, jev, fetchTimeline } = createTriagingServer({});
    fetchTimeline.mockImplementation(() => {
      throw new Error("timeline gone");
    });
    const decide = vi.spyOn(jev, "decide");
    await broadcastFinish(server);
    await vi.waitFor(() => expect(pushNotifications.levels).toEqual(["alert"]));
    expect(decide).not.toHaveBeenCalled();
  });

  it("sends the alert for an excluded agent and sends JEV nothing", async () => {
    const { server, pushNotifications, jev } = createTriagingServer({
      service: { resolveAgentCwds: async () => null },
    });
    await broadcastFinish(server);
    await vi.waitFor(() => expect(pushNotifications.levels).toEqual(["alert"]));
    expect(jev.transport.calls).toHaveLength(0);
  });

  it("sends the client messages before the push", async () => {
    const { server, pushNotifications, jev } = createTriagingServer({
      behavior: { kind: "hold" },
    });
    const ws = connectClient(server, null);
    await broadcastFinish(server);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(pushNotifications.sent).toHaveLength(0);
    await vi.waitFor(() => expect(jev.transport.held).toBe(1));
    jev.transport.release();
    await vi.waitFor(() => expect(pushNotifications.levels).toEqual(["notice"]));
  });

  it("in shadow sends the alert without waiting for JEV", async () => {
    const { server, pushNotifications, jev } = createTriagingServer({
      config: {},
      behavior: { kind: "hold" },
    });
    await broadcastFinish(server);
    expect(pushNotifications.levels).toEqual(["alert"]);
    await vi.waitFor(() => expect(jev.transport.held).toBe(1));
    jev.transport.release();
    await vi.waitFor(() =>
      expect(jev.listDecisions("agent-root")).toMatchObject([
        { action: "sent as an alert; would have sent a notice (shadow)", applied: false },
      ]),
    );
    expect(pushNotifications.levels).toEqual(["alert"]);
  });
});
