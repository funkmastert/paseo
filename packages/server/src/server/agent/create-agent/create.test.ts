import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import type { TestAgentClientOptions } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { PluginHookHandlers } from "../../plugins/lifecycle/index.js";
import type { PluginLifecycle } from "../../plugins/lifecycle/index.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";

const logger = createTestLogger();
const hookPaseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "create-test-lifecycle" }),
);

function createRealAgentManager(
  storage: AgentStorage,
  options?: { pluginLifecycle?: PluginLifecycle; clients?: TestAgentClientOptions },
): AgentManager {
  return new AgentManager({
    clients: createTestAgentClients(options?.clients),
    registry: storage,
    logger,
    pluginLifecycle: options?.pluginLifecycle,
  });
}

// Captures every `agent.create` before-hook request so tests can assert on
// the payload the plugin system would have seen, without exercising the
// plugin process/compiler machinery.
function createCapturingPluginLifecycle(): {
  pluginLifecycle: PluginLifecycle;
  requests: Array<{
    config: { provider: string; cwd: string };
    callerAgentId?: string;
    labels?: Record<string, string>;
    initialPrompt?: string;
  }>;
} {
  const requests: Array<{
    config: { provider: string; cwd: string };
    callerAgentId?: string;
    labels?: Record<string, string>;
    initialPrompt?: string;
  }> = [];
  const pluginLifecycle: PluginLifecycle = {
    emit: () => {},
    before: async (name, request) => {
      if (name === "agent.create") {
        requests.push(
          request as {
            config: { provider: string; cwd: string };
            callerAgentId?: string;
            labels?: Record<string, string>;
            initialPrompt?: string;
          },
        );
      }
      return request;
    },
  };
  return { pluginLifecycle, requests };
}

// Wires the real hook composition/validation machinery (PluginHookHandlers)
// behind the PluginLifecycle interface AgentManager expects, so hook
// registrations here exercise the actual backfill/immutability logic instead
// of a hand-rolled stand-in.
function createRealHookPluginLifecycle(): {
  pluginLifecycle: PluginLifecycle;
  hooks: PluginHookHandlers;
} {
  const hooks = new PluginHookHandlers(() => {});
  const pluginLifecycle: PluginLifecycle = {
    emit: () => {},
    before: async (name, request) => {
      return (await hooks.invoke(
        "test-hook",
        "before",
        name,
        request,
        hookPaseo,
      )) as typeof request;
    },
  };
  return { pluginLifecycle, hooks };
}

async function removeRealAgentManagerWorkdir({
  agentManager,
  storage,
  workdir,
}: {
  agentManager: AgentManager;
  storage: AgentStorage;
  workdir: string;
}): Promise<void> {
  agentManager.prepareForShutdown();
  await Promise.all(agentManager.listAgents().map((agent) => agentManager.closeAgent(agent.id)));
  await agentManager.flushForShutdown();
  await storage.flush();
  rmSync(workdir, { recursive: true, force: true });
}

// Creates a worktree directory under repoRoot and reports it back as a fresh
// workspace so the command can stamp the agent with it (mirrors the production
// worktree service).
function fakeWorktreeCreator(args: { repoRoot: string; createdWorkspaceId: string }) {
  const worktreePath = join(args.repoRoot, "worktree");
  const workspaceCwd = join(worktreePath, "packages", "app");
  mkdirSync(workspaceCwd, { recursive: true });
  return async (): Promise<CreatePaseoWorktreeWorkflowResult> =>
    ({
      worktree: { worktreePath },
      intent: {},
      workspace: { workspaceId: args.createdWorkspaceId, cwd: workspaceCwd },
      repoRoot: args.repoRoot,
      created: true,
      setupContinuation: { kind: "agent" as const, startAfterAgentCreate: () => {} },
    }) as unknown as CreatePaseoWorktreeWorkflowResult;
}

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-create-test",
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    clientMessageId: "msg-create-1",
  });
});

test("session create validates the requested mode against the provider's modes", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockRejectedValue(
    new Error("Invalid mode 'plan' for provider 'opencode'. Available modes: build, myplan"),
  );
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await expect(
    createAgentCommand(dependencies, {
      kind: "session",
      config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "plan" },
      workspaceId: "ws-create-test",
      labels: {},
      provisionalTitle: null,
      firstAgentContext: { attachments: [] },
      buildSessionConfig: async (config) => ({ sessionConfig: config }),
    }),
  ).rejects.toThrow("Invalid mode 'plan'");

  expect(stub.resolveCreateConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "opencode",
      cwd: "/tmp/paseo-create-test",
      requestedMode: "plan",
    }),
  );
  expect(createAgent).not.toHaveBeenCalled();
});

test("session create applies the resolved mode from the provider create config", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "opencode",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const stub = createProviderSnapshotManagerStub();
  stub.resolveCreateConfig.mockResolvedValue({
    modeId: "build",
    featureValues: { auto_accept: true },
  });
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: stub.manager,
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "opencode", cwd: "/tmp/paseo-create-test", modeId: "build" },
    workspaceId: "ws-create-test",
    labels: {},
    provisionalTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      modeId: "build",
      featureValues: { auto_accept: true },
    }),
    undefined,
    expect.anything(),
  );
});

test("mcp create accepts provider-only internal input and leaves model undefined", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async (input) => {
        expect(input.provider).toBe("claude");
        return {};
      }),
    } as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-create-test",
    title: "provider default",
    initialPrompt: "hello",
    background: true,
    notifyOnFinish: false,
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "claude",
      model: undefined,
    }),
    undefined,
    expect.objectContaining({
      workspaceId: "ws-create-test",
    }),
  );
});

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-source");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({
          sessionConfig: config,
          setupContinuation: { kind: "agent", startAfterAgentCreate: () => {} },
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.workspaceId).toBe("ws-new-worktree");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const { snapshot: child } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager,
        createPaseoWorktree: fakeWorktreeCreator({
          repoRoot: workdir,
          createdWorkspaceId: "ws-new-worktree",
        }),
      },
      {
        kind: "mcp",
        provider: "codex/gpt-5.4",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
        worktree: { worktreeName: "feature", baseBranch: "main" },
      },
    );

    const storedChild = await storage.get(child.id);
    expect(storedChild?.workspaceId).toBe("ws-new-worktree");
    expect(child.cwd).toBe(join(workdir, "worktree", "packages", "app"));
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create forwards callerAgentId to the agent.create hook", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, requests } = createCapturingPluginLifecycle();
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );
    requests.length = 0;

    await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
        callerAgentId: parent.id,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.callerAgentId).toBe(parent.id);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create forwards callerAgentId to the agent.create hook for CLI/session-initiated creates", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, requests } = createCapturingPluginLifecycle();
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });
  const providerSnapshotManager = createProviderSnapshotManagerStub().manager;

  try {
    const { snapshot: parent } = await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );
    requests.length = 0;

    await createAgentCommand(
      { agentManager, agentStorage: storage, logger, providerSnapshotManager },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-parent",
        callerAgentId: parent.id,
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.callerAgentId).toBe(parent.id);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create omits callerAgentId from the agent.create hook when no caller initiated it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, requests } = createCapturingPluginLifecycle();
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        labels: {},
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.callerAgentId).toBeUndefined();
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create forwards labels and initialPrompt to the agent.create hook", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, requests } = createCapturingPluginLifecycle();
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        workspaceId: "ws-create-test",
        title: "child",
        initialPrompt: "do the thing",
        labels: { "paseo.agent-type": "reviewer" },
        background: true,
        notifyOnFinish: false,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.labels).toEqual({ "paseo.agent-type": "reviewer" });
    expect(requests[0]?.initialPrompt).toBe("do the thing");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create forwards labels and initialPrompt to the agent.create hook", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, requests } = createCapturingPluginLifecycle();
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-source",
        initialPrompt: "do the thing",
        labels: { "paseo.agent-type": "reviewer" },
        provisionalTitle: null,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.labels).toEqual({ "paseo.agent-type": "reviewer" });
    expect(requests[0]?.initialPrompt).toBe("do the thing");
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a hook mutating labels persists the mutated labels on the created agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, hooks } = createRealHookPluginLifecycle();
  hooks.before("agent.create", ({ request }) => {
    return { ...request, labels: { ...request.labels, "paseo.agent-role": "leader" } };
  });
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        workspaceId: "ws-create-test",
        title: "child",
        initialPrompt: "do the thing",
        labels: { "paseo.agent-type": "reviewer" },
        background: true,
        notifyOnFinish: false,
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.labels).toEqual({
      "paseo.agent-type": "reviewer",
      "paseo.agent-role": "leader",
    });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a hook returning a fresh object without labels leaves the original labels intact on the created agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, hooks } = createRealHookPluginLifecycle();
  // A legacy hook that returns a fresh object without spreading the
  // original request — labels must be backfilled from the request rather
  // than wiped to the wire schema's {} default.
  hooks.before("agent.create", ({ request }) => {
    return { config: request.config, env: request.env };
  });
  const agentManager = createRealAgentManager(storage, { pluginLifecycle });

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        workspaceId: "ws-create-test",
        title: "child",
        initialPrompt: "do the thing",
        labels: { "paseo.agent-type": "reviewer" },
        background: true,
        notifyOnFinish: false,
      },
    );

    const stored = await storage.get(snapshot.id);
    expect(stored?.labels).toEqual({ "paseo.agent-type": "reviewer" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("a hook mutating initialPrompt does not alter the prompt actually sent to the provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const { pluginLifecycle, hooks } = createRealHookPluginLifecycle();
  hooks.before("agent.create", ({ request }) => {
    return { ...request, initialPrompt: "hook-injected prompt" };
  });
  const observedPrompts: unknown[] = [];
  const agentManager = createRealAgentManager(storage, {
    pluginLifecycle,
    clients: { onStartTurn: (prompt) => observedPrompts.push(prompt) },
  });

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        workspaceId: "ws-create-test",
        title: "child",
        initialPrompt: "do the thing",
        background: true,
        notifyOnFinish: false,
      },
    );

    expect(observedPrompts).toEqual(["do the thing"]);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("mcp create exposes the created worktree before dispatching the initial prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-worktree-callback-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const createdWorktree = await fakeWorktreeCreator({
    repoRoot: workdir,
    createdWorkspaceId: "ws-created-worktree",
  })();
  let observed:
    | {
        createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
        lifecycle: ManagedAgent["lifecycle"] | null;
      }
    | undefined;

  try {
    await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: {
          async resolveCreateConfig() {
            return {};
          },
        },
        createPaseoWorktree: async () => createdWorktree,
      },
      {
        kind: "mcp",
        provider: "codex",
        cwd: workdir,
        title: "worktree callback",
        initialPrompt: "Say done.",
        background: true,
        notifyOnFinish: false,
        worktree: { worktreeName: "feature", baseBranch: "main" },
        onCreated: ({ agentId, createdWorktree: callbackWorktree }) => {
          observed = {
            createdWorktree: callbackWorktree,
            lifecycle: agentManager.getAgent(agentId)?.lifecycle ?? null,
          };
        },
      },
    );

    expect(observed).toEqual({ createdWorktree, lifecycle: "idle" });
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps the prompt title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Implement auth retries with backoff";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir },
        workspaceId: "ws-title-source",
        initialPrompt: `${title}\n\ninclude tests`,
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});

test("session create keeps an explicit title after the initial prompt settles", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "create-agent-explicit-title-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const agentManager = createRealAgentManager(storage);
  const title = "Explicit override";

  try {
    const { snapshot } = await createAgentCommand(
      {
        agentManager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      },
      {
        kind: "session",
        config: { provider: "codex", cwd: workdir, title },
        workspaceId: "ws-explicit-title-source",
        initialPrompt: "Implement auth retries with backoff",
        labels: {},
        provisionalTitle: title,
        firstAgentContext: { attachments: [] },
        buildSessionConfig: async (config) => ({ sessionConfig: config }),
      },
    );

    const created = await storage.get(snapshot.id);
    expect(created?.title).toBe(title);

    await agentManager.waitForAgentEvent(snapshot.id, { waitForActive: true });

    const settled = await storage.get(snapshot.id);
    expect(settled?.title).toBe(title);
  } finally {
    await removeRealAgentManagerWorkdir({ agentManager, storage, workdir });
  }
});
