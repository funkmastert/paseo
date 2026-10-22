import { expect, test } from "vitest";

import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentPersistenceHandle, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { resolveAgentIdentifier } from "./resolve-agent-identifier.js";

const TEST_CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};

function makeStoredAgentRecord(
  overrides: Pick<StoredAgentRecord, "id"> & Partial<StoredAgentRecord>,
): StoredAgentRecord {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    cwd: overrides.cwd ?? "/tmp/project",
    workspaceId: overrides.workspaceId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: overrides.lastUserMessageAt ?? null,
    title: overrides.title ?? null,
    labels: overrides.labels ?? {},
    lastStatus: overrides.lastStatus ?? "idle",
    lastModeId: overrides.lastModeId ?? null,
    config: overrides.config ?? null,
    runtimeInfo: overrides.runtimeInfo,
    features: overrides.features,
    persistence: overrides.persistence ?? null,
    lastError: overrides.lastError,
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason,
    attentionTimestamp: overrides.attentionTimestamp,
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
  };
}

function makeManagedAgent(args: { id: string; cwd?: string }): ManagedAgent {
  const provider = "claude";
  const cwd = args.cwd ?? "/tmp/project";
  const config: AgentSessionConfig = { provider, cwd };
  const persistence: AgentPersistenceHandle = {
    provider,
    sessionId: `session-${args.id}`,
    metadata: { provider, cwd },
  };
  return {
    id: args.id,
    provider,
    cwd,
    capabilities: TEST_CAPABILITIES,
    config,
    createdAt: new Date("2026-04-30T00:00:00.000Z"),
    updatedAt: new Date("2026-04-30T00:00:00.000Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence,
    historyPrimed: true,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    internal: false,
    labels: {},
    lifecycle: "closed",
    session: null,
    activeForegroundTurnId: null,
  };
}

function makeDeps(args: { storedRecords?: StoredAgentRecord[]; liveAgents?: ManagedAgent[] }): {
  agentStorage: Pick<AgentStorage, "list">;
  agentManager: Pick<AgentManager, "listAgents">;
} {
  return {
    agentStorage: {
      list: async () => args.storedRecords ?? [],
    },
    agentManager: {
      listAgents: () => args.liveAgents ?? [],
    },
  };
}

test("resolves an exact id match", async () => {
  const record = makeStoredAgentRecord({ id: "00000000-0000-4000-8000-000000000001" });
  const result = await resolveAgentIdentifier(record.id, makeDeps({ storedRecords: [record] }));
  expect(result).toEqual({ ok: true, agentId: record.id });
});

test("resolves a unique prefix of a live agent's id", async () => {
  const live = makeManagedAgent({ id: "00000000-0000-4000-8000-000000000002" });
  const result = await resolveAgentIdentifier(
    "00000000-0000-4000-8000",
    makeDeps({ liveAgents: [live] }),
  );
  expect(result).toEqual({ ok: true, agentId: live.id });
});

test("resolves a unique prefix of a stored-only agent's id", async () => {
  const record = makeStoredAgentRecord({ id: "00000000-0000-4000-8000-000000000003" });
  const result = await resolveAgentIdentifier(
    "00000000-0000-4000-8000",
    makeDeps({ storedRecords: [record] }),
  );
  expect(result).toEqual({ ok: true, agentId: record.id });
});

test("reports ambiguous when a prefix matches multiple known ids", async () => {
  const first = makeStoredAgentRecord({ id: "00000000-0000-4000-8000-000000000011" });
  const second = makeStoredAgentRecord({ id: "00000000-0000-4000-8000-000000000012" });
  const result = await resolveAgentIdentifier(
    "00000000-0000-4000-8000",
    makeDeps({ storedRecords: [first, second] }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected ambiguous result");
  }
  expect(result.error).toBe(
    `Agent identifier "00000000-0000-4000-8000" is ambiguous (${first.id.slice(0, 8)}, ${second.id.slice(0, 8)})`,
  );
});

test("truncates the ambiguous id list after 5 and appends an ellipsis", async () => {
  const records = Array.from({ length: 6 }, (_, i) =>
    makeStoredAgentRecord({ id: `00000000-0000-4000-8000-00000000001${i}` }),
  );
  const result = await resolveAgentIdentifier(
    "00000000-0000-4000-8000",
    makeDeps({ storedRecords: records }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected ambiguous result");
  }
  expect(result.error).toBe(
    `Agent identifier "00000000-0000-4000-8000" is ambiguous (${records
      .slice(0, 5)
      .map((r) => r.id.slice(0, 8))
      .join(", ")}, …)`,
  );
});

test("resolves a unique title match", async () => {
  const record = makeStoredAgentRecord({
    id: "00000000-0000-4000-8000-000000000021",
    title: "my special agent",
  });
  const result = await resolveAgentIdentifier(
    "my special agent",
    makeDeps({ storedRecords: [record] }),
  );
  expect(result).toEqual({ ok: true, agentId: record.id });
});

test("reports ambiguous when a title matches multiple stored records", async () => {
  const first = makeStoredAgentRecord({
    id: "00000000-0000-4000-8000-000000000022",
    title: "shared title",
  });
  const second = makeStoredAgentRecord({
    id: "00000000-0000-4000-8000-000000000023",
    title: "shared title",
  });
  const result = await resolveAgentIdentifier(
    "shared title",
    makeDeps({ storedRecords: [first, second] }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected ambiguous result");
  }
  expect(result.error).toBe(
    `Agent title "shared title" is ambiguous (${first.id.slice(0, 8)}, ${second.id.slice(0, 8)})`,
  );
});

test("rejects an empty identifier", async () => {
  const result = await resolveAgentIdentifier("", makeDeps({}));
  expect(result).toEqual({ ok: false, error: "Agent identifier cannot be empty" });
});

test("rejects a whitespace-only identifier", async () => {
  const result = await resolveAgentIdentifier("   ", makeDeps({}));
  expect(result).toEqual({ ok: false, error: "Agent identifier cannot be empty" });
});

test("reports not found for a completely unknown identifier", async () => {
  const result = await resolveAgentIdentifier("does-not-exist", makeDeps({}));
  expect(result).toEqual({ ok: false, error: "Agent not found: does-not-exist" });
});

test("excludes internal records from id, prefix, and title matching", async () => {
  const internalRecord = makeStoredAgentRecord({
    id: "00000000-0000-4000-8000-000000000099",
    title: "internal only",
    internal: true,
  });
  const deps = makeDeps({ storedRecords: [internalRecord] });

  const byExactId = await resolveAgentIdentifier(internalRecord.id, deps);
  expect(byExactId).toEqual({
    ok: false,
    error: `Agent not found: ${internalRecord.id}`,
  });

  const byPrefix = await resolveAgentIdentifier("00000000-0000-4000-8000", deps);
  expect(byPrefix).toEqual({
    ok: false,
    error: "Agent not found: 00000000-0000-4000-8000",
  });

  const byTitle = await resolveAgentIdentifier("internal only", deps);
  expect(byTitle).toEqual({
    ok: false,
    error: "Agent not found: internal only",
  });
});
