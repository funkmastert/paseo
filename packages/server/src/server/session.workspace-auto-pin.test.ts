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

function buildHarness(options: { autoPinSessions?: boolean } = {}) {
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

  return { cwd, session, agentManager, projectRegistry, workspaceRegistry };
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
