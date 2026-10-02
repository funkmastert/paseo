import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { Session } from "./session.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  asSessionLogger,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asPushNotifications,
  asScheduleService,
  createProviderSnapshotManagerStub,
  createAgentRequestsStub,
} from "./test-utils/session-stubs.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "./workspace-registry.js";

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function buildHarness(
  options: {
    autoPinSessions?: boolean;
    autoPinExpiry?: { noteWorkspaceUsed(workspaceId: string, atMs?: number): void };
  } = {},
) {
  const workdir = mkdtempSync(path.join(tmpdir(), "paseo-auto-pin-"));
  workdirs.push(workdir);
  const cwd = workdir;

  const logger = createTestLoggerLike();
  const agentStorage = new AgentStorage(path.join(workdir, "agents"), asSessionLogger(logger));
  const agentManager = new AgentManager({
    clients: createTestAgentClients(),
    registry: agentStorage,
    logger: asSessionLogger(logger),
  });
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(workdir, "projects.json"),
    asSessionLogger(logger),
  );
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(workdir, "workspaces.json"),
    asSessionLogger(logger),
  );

  const session = new Session({
    agentRequests: createAgentRequestsStub(),
    clientId: "test-client",
    permissions: OWNER_PERMISSIONS,
    appVersion: null,
    onMessage: () => {},
    logger: asSessionLogger(logger),
    downloadTokenStore: asDownloadTokenStore(),
    pushNotifications: asPushNotifications(),
    paseoHome: path.join(workdir, "paseo-home"),
    agentManager,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager({
      subscribe: async () => ({
        initial: { cwd, files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      onWorkspaceStateMayHaveChanged: () => {},
      invalidateForge: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    workspaceGitService: createNoopWorkspaceGitService(),
    autoPinExpiry: options.autoPinExpiry,
    daemonConfigStore: asDaemonConfigStore({
      get: () => ({
        mcp: { injectIntoAgents: false },
        providers: {},
        ...(options.autoPinSessions === undefined
          ? {}
          : { autoPinSessions: options.autoPinSessions }),
      }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  }) as unknown as {
    handleMessage(message: Record<string, unknown>): Promise<void>;
  };

  return { cwd, session, agentManager, agentStorage, projectRegistry, workspaceRegistry };
}

function createTestLoggerLike() {
  const logger = {
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

test("workspace.create.request auto-pins a brand new workspace over a client connection", async () => {
  const { cwd, session, workspaceRegistry } = buildHarness();

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-1",
    source: { kind: "directory", path: cwd },
  });

  const [record] = await workspaceRegistry.list();
  expect(record?.pinnedAt).toBeTruthy();
  expect(record?.pinSource).toBe("auto");
});

test("workspace.create.request with a callerAgentId never auto-pins", async () => {
  const { cwd, session, workspaceRegistry } = buildHarness();

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-agent-create",
    source: { kind: "directory", path: cwd },
    callerAgentId: "agent-1",
  });

  const [record] = await workspaceRegistry.list();
  expect(record?.pinnedAt).toBeNull();
  expect(record?.pinSource).toBeUndefined();
});

test("create_agent_request whose labels carry paseo.parent-agent-id does not pin, even with no callerAgentId", async () => {
  const { cwd, session, projectRegistry, workspaceRegistry } = buildHarness();

  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-existing",
      rootPath: cwd,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-labeled",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-labeled",
    workspaceId: "ws-labeled",
    config: { provider: "codex", cwd },
    labels: { "paseo.parent-agent-id": "some-other-agent" },
    attachments: [],
  });

  const stored = await workspaceRegistry.get("ws-labeled");
  expect(stored?.pinnedAt).toBeNull();
});

test("create_agent_request with no caller agent auto-pins the workspace it targets", async () => {
  const { cwd, session, projectRegistry, workspaceRegistry } = buildHarness();

  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-existing",
      rootPath: cwd,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-existing",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-2",
    workspaceId: "ws-existing",
    config: { provider: "codex", cwd },
    attachments: [],
  });

  const stored = await workspaceRegistry.get("ws-existing");
  expect(stored?.pinnedAt).toBeTruthy();
  expect(stored?.pinSource).toBe("auto");
});

test("create_agent_request with a caller agent does not pin its workspace", async () => {
  const { cwd, session, agentManager, projectRegistry, workspaceRegistry } = buildHarness();

  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-existing",
      rootPath: cwd,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-caller",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-target",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );

  // Seed a caller agent directly through AgentManager (bypassing the session RPC), so its own
  // creation never triggers auto-pin and the test isolates the callerAgentId branch cleanly.
  const caller = await agentManager.createAgent({ provider: "codex", cwd }, undefined, {
    workspaceId: "ws-caller",
  });

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-3",
    workspaceId: "ws-target",
    callerAgentId: caller.id,
    config: { provider: "codex", cwd },
    attachments: [],
  });

  const stored = await workspaceRegistry.get("ws-target");
  expect(stored?.pinnedAt).toBeNull();
});

test("an existing manual pin is not touched by a later session start", async () => {
  const { cwd, session, projectRegistry, workspaceRegistry } = buildHarness();

  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-existing",
      rootPath: cwd,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-manual",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
      pinnedAt: "2026-05-08T00:00:00.000Z",
      pinSource: "manual",
    }),
  );

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-4",
    workspaceId: "ws-manual",
    config: { provider: "codex", cwd },
    attachments: [],
  });

  const stored = await workspaceRegistry.get("ws-manual");
  expect(stored?.pinnedAt).toBe("2026-05-08T00:00:00.000Z");
  expect(stored?.pinSource).toBe("manual");
});

test("agents.autoPinSessions: false turns auto-pin off", async () => {
  const { cwd, session, workspaceRegistry } = buildHarness({ autoPinSessions: false });

  await session.handleMessage({
    type: "workspace.create.request",
    requestId: "req-5",
    source: { kind: "directory", path: cwd },
  });

  const [record] = await workspaceRegistry.list();
  expect(record?.pinnedAt).toBeNull();
});

test("create_agent_request with autoArchive still archives an agent whose first turn ends during the auto-pin", async () => {
  const { cwd, session, agentManager, agentStorage, projectRegistry, workspaceRegistry } =
    buildHarness();
  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-existing",
      rootPath: cwd,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-auto-archive",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  // The first turn ends while the auto-pin write is still in flight: the auto-archive listens for
  // that end with no replay, so it has to be listening before the auto-pin is awaited.
  let firstTurnAgentId: string | null = null;
  const firstTurnEnded = new Promise<void>((resolve) => {
    agentManager.subscribe((event) => {
      if (event.type !== "agent_stream" || event.event.type !== "turn_completed") return;
      firstTurnAgentId = event.agentId;
      resolve();
    });
  });
  const update = workspaceRegistry.update.bind(workspaceRegistry);
  workspaceRegistry.update = async (workspaceId, updater) => {
    const current = await workspaceRegistry.get(workspaceId);
    if (current && updater(current).pinSource === "auto") await firstTurnEnded;
    return update(workspaceId, updater);
  };

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-6",
    workspaceId: "ws-auto-archive",
    config: { provider: "codex", cwd },
    initialPrompt: "Say done.",
    autoArchive: true,
    attachments: [],
  });

  expect((await workspaceRegistry.get("ws-auto-archive"))?.pinSource).toBe("auto");
  expect(firstTurnAgentId).not.toBeNull();
  await expect
    .poll(async () => (await agentStorage.get(firstTurnAgentId!))?.archivedAt ?? null, {
      timeout: 5000,
      interval: 50,
    })
    .not.toBeNull();
});

test("a session start and a focused visible heartbeat are uses of the workspace", async () => {
  const uses: Array<{ workspaceId: string; atMs: number | undefined }> = [];
  const { cwd, session, agentManager, projectRegistry, workspaceRegistry } = buildHarness({
    autoPinExpiry: { noteWorkspaceUsed: (workspaceId, atMs) => uses.push({ workspaceId, atMs }) },
  });
  await projectRegistry.upsert(
    createPersistedProjectRecord({
      projectId: "proj-existing",
      rootPath: cwd,
      kind: "git",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "ws-existing",
      projectId: "proj-existing",
      cwd,
      kind: "local_checkout",
      displayName: "repo",
      createdAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    }),
  );

  await session.handleMessage({
    type: "create_agent_request",
    requestId: "req-use",
    workspaceId: "ws-existing",
    config: { provider: "codex", cwd },
    attachments: [],
  });
  expect(uses).toEqual([{ workspaceId: "ws-existing", atMs: undefined }]);

  const [agent] = agentManager.listAgents();
  if (!agent) throw new Error("expected the created agent");
  const heartbeat = {
    type: "client_heartbeat",
    deviceType: "web",
    focusedAgentId: agent.id,
    focusedTerminalId: null,
    lastActivityAt: "2026-05-07T01:02:03.000Z",
  };
  await session.handleMessage({ ...heartbeat, appVisible: false });
  await session.handleMessage({ ...heartbeat, appVisible: true, focusedAgentId: null });
  expect(uses).toHaveLength(1);

  await session.handleMessage({ ...heartbeat, appVisible: true });
  expect(uses[1]).toEqual({
    workspaceId: "ws-existing",
    atMs: Date.parse("2026-05-07T01:02:03.000Z"),
  });
});
