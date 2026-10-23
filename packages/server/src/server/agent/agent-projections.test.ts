import { describe, expect, it } from "vitest";

import { AGENT_LIFECYCLE_STATUSES } from "./agent-manager.js";
import {
  buildStoredAgentPayload,
  toAgentListItemPayload,
  toAgentPayload,
  toRecentProviderSessionDescriptorPayload,
  toStoredAgentRecord,
  type ManagedAgent,
} from "./agent-projections.js";
import type { AgentSession } from "./agent-sdk-types.js";
import type {
  AgentFeature,
  ImportableProviderSession,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { recordTokenDelta, TOKEN_RATE_TRACKER_WINDOW_MS } from "./token-rate-tracker.js";

type ManagedAgentOverrides = Omit<Partial<ManagedAgent>, "config" | "pendingPermissions"> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
};

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const baseConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: "/tmp/project",
    modeId: "plan",
    model: "claude-3.5-sonnet",
    providerOptions: { allowedTools: ["Read"] },
  };

  const basePersistence: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: "persist-1",
    metadata: { branch: "feature/refactor" },
  };

  const configOverrides = overrides.config ?? {};
  const {
    config: _ignoredConfig,
    pendingPermissions: pendingPermissionsOverride,
    lifecycle = "idle",
    ...restOverrides
  } = overrides;

  const sessionValue =
    lifecycle === "closed" ? null : (restOverrides.session ?? ({} as AgentSession));
  const activeForegroundTurnIdValue =
    restOverrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  const lastErrorValue =
    restOverrides.lastError ?? (lifecycle === "error" ? "encountered error" : undefined);

  const agent: ManagedAgent = {
    id: "agent-123",
    provider: "claude",
    cwd: "/tmp/project",
    session: sessionValue,
    sessionId: "session-123",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: { ...baseConfig, ...configOverrides },
    lifecycle,
    createdAt: now,
    updatedAt: now,
    availableModes: [
      { id: "plan", label: "Planning" },
      { id: "build", label: "Building", description: "Detailed" },
    ],
    currentModeId: "plan",
    pendingPermissions: pendingPermissionsOverride ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: activeForegroundTurnIdValue,
    activeTurnId: activeForegroundTurnIdValue,
    activeTurnStartedAt: lifecycle === "running" ? new Date("2025-01-01T00:00:01.000Z") : null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    },
    persistence: { ...basePersistence },
    lastUsage: undefined,
    lastError: lastErrorValue,
    historyPrimed: true,
    lastUserMessageAt: now,
    attention: { requiresAttention: false },
  };

  return {
    ...agent,
    ...restOverrides,
    lifecycle,
    config: agent.config,
    pendingPermissions: agent.pendingPermissions,
  };
}

it("projects the daemon-owned active turn identity", () => {
  expect(toAgentPayload(createManagedAgent({ lifecycle: "running" })).activeTurn).toEqual({
    turnId: "test-turn-id",
    startedAt: "2025-01-01T00:00:01.000Z",
  });
});

function createPermission(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  const base: AgentPermissionRequest = {
    id: "perm-1",
    provider: "claude",
    name: "execute_command",
    kind: "tool",
    title: "Run command",
    description: "Execute shell command",
    input: { command: "ls", args: undefined },
    suggestions: [{ behavior: "allow" }],
    metadata: { requestedAt: new Date("2025-02-01T12:00:00.000Z") },
  };
  return { ...base, ...overrides };
}

function createFeature(overrides: Partial<AgentFeature> = {}): AgentFeature {
  return {
    type: "toggle",
    id: "fast_mode",
    label: "Fast mode",
    value: true,
    ...overrides,
  };
}

describe("toStoredAgentRecord", () => {
  it("captures lifecycle metadata, config, and persistence", () => {
    const agent = createManagedAgent({
      currentModeId: "focus",
      persistence: {
        provider: "claude",
        sessionId: "persist-2",
        metadata: { resumedAt: new Date("2025-01-05T00:00:00.000Z"), note: "warm" },
      },
    });

    const record = toStoredAgentRecord(agent, { title: "Refactor Agent" });

    expect(record).toMatchObject({
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      title: "Refactor Agent",
      lastStatus: agent.lifecycle,
      lastModeId: "focus",
    });
    expect(record.createdAt).toBe(agent.createdAt.toISOString());
    expect(record.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastActivityAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(record.persistence).toEqual({
      provider: "claude",
      sessionId: "persist-2",
      metadata: {
        resumedAt: "2025-01-05T00:00:00.000Z",
        note: "warm",
      },
    });
    expect(record.runtimeInfo).toEqual({
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    });
    expect(record.config).toEqual({
      modeId: agent.config.modeId,
      model: agent.config.model,
      providerOptions: { allowedTools: ["Read"] },
    });

    record.config!.providerOptions!.allowedTools = ["Bash"];
    expect(agent.config.providerOptions!.allowedTools).toEqual(["Read"]);
    record.persistence!.sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-2");
  });

  it("falls back to config mode when current mode is null and handles null title", () => {
    const agent = createManagedAgent({
      currentModeId: null,
      config: { modeId: "auto" },
      lastUserMessageAt: null,
    });

    const record = toStoredAgentRecord(agent);
    expect(record.title).toBeNull();
    expect(record.lastModeId).toBe("auto");
    expect(record.lastUserMessageAt).toBeNull();
  });

  it("omits config when no serializable fields exist", () => {
    const agent = createManagedAgent({
      config: {
        modeId: undefined,
        model: undefined,
        providerOptions: undefined,
        toolPolicy: undefined,
      },
    });

    const record = toStoredAgentRecord(agent);
    expect(record.config).toBeNull();
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const record = toStoredAgentRecord(agent);
      expect(record.lastStatus).toBe(status);
    }
  });
});

describe("toAgentPayload", () => {
  it("serializes dates, clones arrays, and hides session", () => {
    const permissionA = createPermission({ id: "perm-a" });
    const permissionB = createPermission({
      id: "perm-b",
      provider: "codex",
      metadata: { requestedAt: new Date("2025-02-02T00:00:00.000Z"), extra: { flag: true } },
    });
    const pending = new Map([
      [permissionA.id, permissionA],
      [permissionB.id, permissionB],
    ]);
    const agent = createManagedAgent({
      pendingPermissions: pending,
      lastUsage: { inputTokens: 10, outputTokens: 20 },
      lastError: "boom",
    });

    const payload = toAgentPayload(agent, { title: "UI Payload" });

    expect(payload.createdAt).toBe(agent.createdAt.toISOString());
    expect(payload.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(payload.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(payload.title).toBe("UI Payload");
    expect(payload.model).toBe(agent.config.model);
    expect(payload.thinkingOptionId).toBeNull();
    expect(payload.pendingPermissions.map((item) => item.id)).toEqual(["perm-a", "perm-b"]);
    expect(payload.pendingPermissions[0]).not.toBe(permissionA);
    expect(payload.pendingPermissions[0].input).toEqual({ command: "ls" });
    expect(payload.pendingPermissions[1].metadata).toEqual({
      requestedAt: "2025-02-02T00:00:00.000Z",
      extra: { flag: true },
    });
    expect(payload.runtimeInfo).toEqual(agent.runtimeInfo);
    expect(payload.runtimeInfo).not.toBe(agent.runtimeInfo);
    expect(payload.availableModes).not.toBe(agent.availableModes);
    expect(payload.availableModes).toEqual(agent.availableModes);
    expect(payload.capabilities).not.toBe(agent.capabilities);
    expect(payload.capabilities).toEqual(agent.capabilities);
    expect(payload.lastUsage).toEqual(agent.lastUsage);
    expect(payload.lastUsage).not.toBe(agent.lastUsage);
    expect(payload.lastError).toBe("boom");
    expect((payload as unknown as { session?: unknown }).session).toBeUndefined();

    payload.availableModes[0].label = "Changed";
    expect(agent.availableModes[0].label).toBe("Planning");
    payload.capabilities.supportsStreaming = false;
    expect(agent.capabilities.supportsStreaming).toBe(true);
    payload.pendingPermissions[0].title = "Mutated title";
    expect(permissionA.title).toBe("Run command");
  });

  it("omits usage when any numeric usage field is NaN", () => {
    const fields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "totalCostUsd",
      "contextWindowMaxTokens",
      "contextWindowUsedTokens",
    ] as const;

    for (const field of fields) {
      const agent = createManagedAgent({
        lastUsage: {
          inputTokens: 10,
          cachedInputTokens: 5,
          outputTokens: 20,
          totalCostUsd: 0.5,
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 100_000,
          [field]: Number.NaN,
        },
      });

      const payload = toAgentPayload(agent);
      expect(payload.lastUsage).toBeUndefined();
    }
  });

  it("produces null title and current mode even without overrides", () => {
    const agent = createManagedAgent({ currentModeId: null, lastUserMessageAt: null });
    const payload = toAgentPayload(agent);
    expect(payload.title).toBeNull();
    expect(payload.currentModeId).toBeNull();
    expect(payload.lastUserMessageAt).toBeNull();
    expect(payload.pendingPermissions).toEqual([]);
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const payload = toAgentPayload(agent);
      expect(payload.status).toBe(status);
    }
  });

  it("keeps persistence handles sanitized and detached", () => {
    const agent = createManagedAgent({
      persistence: {
        provider: "codex",
        sessionId: "persist-99",
        nativeHandle: { id: "native" } as unknown,
        metadata: {
          restored: new Date("2025-03-01T00:00:00.000Z"),
          empty: {},
          mcpServers: {
            hub: {
              type: "http",
              headers: { Authorization: "Bearer projection-secret" },
            },
          },
        },
      },
    });
    const payload = toAgentPayload(agent);
    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-99",
      nativeHandle: { id: "native" },
      metadata: { restored: "2025-03-01T00:00:00.000Z" },
    });
    (payload.persistence as AgentPersistenceHandle).sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-99");
  });

  it("removes empty persistence metadata after projecting MCP configuration", () => {
    const payload = toAgentPayload(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-mcp-only",
          metadata: { mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } } },
        },
      }),
    );

    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-mcp-only",
    });
  });

  it("strips MCP metadata from stored wire payloads while preserving private persistence", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-stored",
          metadata: {
            conversationId: "conversation-stored",
            mcpServers: {
              hub: {
                type: "http",
                headers: { Authorization: "Bearer stored-projection-secret" },
              },
            },
          },
        },
      }),
    );

    const payload = buildStoredAgentPayload(record, ["codex"]);

    expect(record.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
      mcpServers: {
        hub: {
          type: "http",
          headers: { Authorization: "Bearer stored-projection-secret" },
        },
      },
    });
    expect(payload.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
    });
  });

  it("omits lastUsage when not available", () => {
    const agent = createManagedAgent({ lastUsage: undefined });
    const payload = toAgentPayload(agent);
    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("preserves context window usage fields when they are valid numbers", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 42_000,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 42_000,
    });
  });

  it("omits lastUsage when context window usage fields are invalid", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: "200000" as unknown as number,
        contextWindowUsedTokens: NaN,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("keeps existing lastUsage behavior when context window fields are absent", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 1.25,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalCostUsd: 1.25,
    });
  });

  it("includes features in the snapshot payload", () => {
    const features = [createFeature()];
    const agent = createManagedAgent({ features });

    const payload = toAgentPayload(agent);

    expect(payload.features).toEqual(features);
  });

  it("includes lastActivitySummary when set", () => {
    const agent = createManagedAgent({ lastActivitySummary: "[Read] src/index.ts" });

    const payload = toAgentPayload(agent);

    expect(payload.lastActivitySummary).toBe("[Read] src/index.ts");
  });

  it("omits lastActivitySummary when not set", () => {
    const agent = createManagedAgent({ lastActivitySummary: undefined });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("lastActivitySummary");
  });

  it("includes mcpServerStatuses when set (KTD8)", () => {
    const agent = createManagedAgent({
      mcpServerStatuses: [{ name: "zeeq", status: "needs-auth" }],
    });

    const payload = toAgentPayload(agent);

    expect(payload.mcpServerStatuses).toEqual([{ name: "zeeq", status: "needs-auth" }]);
  });

  it("omits mcpServerStatuses when not set", () => {
    const agent = createManagedAgent({ mcpServerStatuses: undefined });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("mcpServerStatuses");
  });

  it("includes recentTokenRate and totalTokens when the buckets have current activity", () => {
    const agent = createManagedAgent({
      tokenRateBuckets: recordTokenDelta([], 40, Date.now()),
      totalTokens: 40,
    });

    const payload = toAgentPayload(agent);

    expect(payload.recentTokenRate).toEqual({
      tokensPerMinute: expect.any(Number),
      asOfMs: expect.any(Number),
    });
    expect(payload.totalTokens).toBe(40);
  });

  it("omits recentTokenRate and totalTokens when never recorded", () => {
    const agent = createManagedAgent({ tokenRateBuckets: undefined, totalTokens: undefined });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("recentTokenRate");
    expect(payload).not.toHaveProperty("totalTokens");
  });

  it("omits recentTokenRate once every bucket has aged out of the trailing window", () => {
    const agent = createManagedAgent({
      tokenRateBuckets: recordTokenDelta(
        [],
        40,
        Date.now() - TOKEN_RATE_TRACKER_WINDOW_MS - 60_000,
      ),
      totalTokens: 40,
    });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("recentTokenRate");
    // totalTokens is a lifetime counter, independent of the trailing-window rate.
    expect(payload.totalTokens).toBe(40);
  });

  it("includes tokenBurnAlert when the monitor has set one", () => {
    const tokenBurnAlert = {
      trigger: "rate" as const,
      ratePerMinute: 50_000,
      firstBreachedAt: "2026-09-12T00:00:00.000Z",
    };
    const agent = createManagedAgent({ tokenBurnAlert });

    const payload = toAgentPayload(agent);

    expect(payload.tokenBurnAlert).toEqual(tokenBurnAlert);
  });

  it("omits tokenBurnAlert when the monitor hasn't set one", () => {
    const agent = createManagedAgent({ tokenBurnAlert: undefined });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("tokenBurnAlert");
  });

  it("includes resourceAlert when the monitor has set one", () => {
    const resourceAlert = {
      trigger: "memory" as const,
      memoryBytes: 7_730_941_133,
      cpuPercent: 410,
      firstBreachedAt: "2026-09-12T00:00:00.000Z",
    };
    const agent = createManagedAgent({ resourceAlert });

    const payload = toAgentPayload(agent);

    expect(payload.resourceAlert).toEqual(resourceAlert);
  });

  it("omits resourceAlert when the monitor hasn't set one", () => {
    const agent = createManagedAgent({ resourceAlert: undefined });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("resourceAlert");
  });
});

describe("buildStoredAgentPayload", () => {
  it("drops a stale finished flag from a delegated record written before the rule", () => {
    // 27 such records existed on one daemon, nothing would ever have cleared them, and each
    // one badged an agent a human never opens. The rule applies at read time so they stop
    // showing without rewriting agent state.
    const agent = createManagedAgent({ labels: { "paseo.parent-agent-id": "parent-1" } });
    const record = {
      ...toStoredAgentRecord(agent, { title: "Worker" }),
      requiresAttention: true,
      attentionReason: "finished" as const,
      attentionTimestamp: "2026-08-22T02:40:47.743Z",
    };

    const payload = buildStoredAgentPayload(record, ["claude"]);

    expect(payload.requiresAttention).toBe(false);
    expect(payload.attentionReason).toBeNull();
    expect(payload.attentionTimestamp).toBeNull();
  });

  it("keeps a delegated record's error flag: a failed subagent is not the normal case", () => {
    const agent = createManagedAgent({ labels: { "paseo.parent-agent-id": "parent-1" } });
    const record = {
      ...toStoredAgentRecord(agent, { title: "Worker" }),
      requiresAttention: true,
      attentionReason: "error" as const,
      attentionTimestamp: "2026-08-22T02:40:47.743Z",
    };

    expect(buildStoredAgentPayload(record, ["claude"]).requiresAttention).toBe(true);
  });

  it("keeps a top-level record's finished flag, which is the whole signal", () => {
    const record = {
      ...toStoredAgentRecord(createManagedAgent({}), { title: "Leader" }),
      requiresAttention: true,
      attentionReason: "finished" as const,
      attentionTimestamp: "2026-09-19T03:57:12.400Z",
    };

    const payload = buildStoredAgentPayload(record, ["claude"]);

    expect(payload.requiresAttention).toBe(true);
    expect(payload.attentionReason).toBe("finished");
  });

  it("omits lastActivitySummary for persisted records, which never carry it", () => {
    const agent = createManagedAgent({ lastActivitySummary: "[Read] src/index.ts" });
    const record = toStoredAgentRecord(agent, { title: "Stored Agent" });

    const payload = buildStoredAgentPayload(record, ["claude"]);

    expect(payload).not.toHaveProperty("lastActivitySummary");
  });

  it("omits recentTokenRate and totalTokens for persisted records, which never carry them", () => {
    const agent = createManagedAgent({
      tokenRateBuckets: recordTokenDelta([], 40, Date.now()),
      totalTokens: 40,
    });
    const record = toStoredAgentRecord(agent, { title: "Stored Agent" });

    const payload = buildStoredAgentPayload(record, ["claude"]);

    expect(payload).not.toHaveProperty("recentTokenRate");
    expect(payload).not.toHaveProperty("totalTokens");
  });

  it("omits tokenBurnAlert for persisted records — it's live-only and never stored", () => {
    const agent = createManagedAgent({
      tokenBurnAlert: {
        trigger: "total",
        totalTokens: 5_000_000,
        firstBreachedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const record = toStoredAgentRecord(agent, { title: "Stored Agent" });

    expect(record).not.toHaveProperty("tokenBurnAlert");

    const payload = buildStoredAgentPayload(record, ["claude"]);

    expect(payload).not.toHaveProperty("tokenBurnAlert");
  });

  it("omits resourceAlert for persisted records — it's live-only and never stored", () => {
    const agent = createManagedAgent({
      resourceAlert: {
        trigger: "cpu",
        memoryBytes: 1_073_741_824,
        cpuPercent: 500,
        firstBreachedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const record = toStoredAgentRecord(agent, { title: "Stored Agent" });

    expect(record).not.toHaveProperty("resourceAlert");

    const payload = buildStoredAgentPayload(record, ["claude"]);

    expect(payload).not.toHaveProperty("resourceAlert");
  });
});

describe("toAgentListItemPayload", () => {
  it("carries lastActivitySummary through from the snapshot payload", () => {
    const agent = createManagedAgent({ lastActivitySummary: "[Shell] npm test" });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem.lastActivitySummary).toBe("[Shell] npm test");
  });

  it("carries recentTokenRate and totalTokens through from the snapshot payload", () => {
    const agent = createManagedAgent({
      tokenRateBuckets: recordTokenDelta([], 40, Date.now()),
      totalTokens: 40,
    });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem.recentTokenRate).toEqual(snapshot.recentTokenRate);
    expect(listItem.totalTokens).toBe(40);
  });

  it("omits recentTokenRate and totalTokens when the snapshot doesn't have them", () => {
    const agent = createManagedAgent({ tokenRateBuckets: undefined, totalTokens: undefined });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem).not.toHaveProperty("recentTokenRate");
    expect(listItem).not.toHaveProperty("totalTokens");
  });

  it("carries tokenBurnAlert through from the snapshot payload", () => {
    const agent = createManagedAgent({
      tokenBurnAlert: {
        trigger: "rate",
        ratePerMinute: 50_000,
        firstBreachedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem.tokenBurnAlert).toEqual(snapshot.tokenBurnAlert);
  });

  it("omits tokenBurnAlert when the snapshot doesn't have one", () => {
    const agent = createManagedAgent({ tokenBurnAlert: undefined });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem).not.toHaveProperty("tokenBurnAlert");
  });

  it("carries resourceAlert through from the snapshot payload", () => {
    const agent = createManagedAgent({
      resourceAlert: {
        trigger: "memory",
        memoryBytes: 7_730_941_133,
        cpuPercent: 410,
        firstBreachedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem.resourceAlert).toEqual(snapshot.resourceAlert);
  });

  it("omits resourceAlert when the snapshot doesn't have one", () => {
    const agent = createManagedAgent({ resourceAlert: undefined });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem).not.toHaveProperty("resourceAlert");
  });

  it("omits lastActivitySummary when the snapshot doesn't have one", () => {
    const agent = createManagedAgent({ lastActivitySummary: undefined });
    const snapshot = toAgentPayload(agent);

    const listItem = toAgentListItemPayload(snapshot);

    expect(listItem).not.toHaveProperty("lastActivitySummary");
  });
});

describe("toRecentProviderSessionDescriptorPayload", () => {
  it("projects provider import rows to provider-opaque public recent sessions", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "codex-custom",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
    };

    const payload = toRecentProviderSessionDescriptorPayload(session, {
      providerLabel: "Custom Codex",
    });

    expect(payload).toEqual({
      providerId: "codex-custom",
      providerLabel: "Custom Codex",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: "2026-04-30T12:34:56.000Z",
    });
    expect(payload).not.toHaveProperty("providerKind");
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("nativeHandle");
  });

  it("preserves null prompt previews", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "claude-custom",
      providerHandleId: "provider-session-id",
      cwd: "/tmp/project",
      title: null,
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
      firstPromptPreview: null,
      lastPromptPreview: null,
    };

    expect(
      toRecentProviderSessionDescriptorPayload(session, {
        providerLabel: "Custom Claude",
      }),
    ).toMatchObject({
      providerId: "claude-custom",
      providerLabel: "Custom Claude",
      providerHandleId: "provider-session-id",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });
  });
});
