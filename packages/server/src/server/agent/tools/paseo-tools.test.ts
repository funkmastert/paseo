import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { PARENT_AGENT_ID_LABEL, COMPLETION_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolHostDependencies } from "./types.js";

// send_agent_prompt delegates delivery to sendPromptToAgent (agent-prompt.ts), which drives a
// real provider run. These tests only care which agentId a short/prefix identifier resolves to
// before delivery, so the real implementation is swapped for a mock that just echoes the agentId
// it was given — proving (or disproving) the resolved-vs-requested comparison paseo-tools.ts does
// to decide whether the response looks "moved".
const { sendPromptToAgentMock } = vi.hoisted(() => ({
  sendPromptToAgentMock: vi.fn(),
}));

vi.mock("../agent-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-prompt.js")>();
  return { ...actual, sendPromptToAgent: sendPromptToAgentMock };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Structured tool output is untyped JSON.
type Loose = any;

interface FakeAgentSpec {
  id: string;
  status?: ManagedAgent["lifecycle"];
  labels?: Record<string, string>;
  pendingPermissions?: number;
  workspaceId?: string;
  title?: string;
  /** Archived: present in storage but not in the live agent manager, like a real archived agent. */
  archived?: boolean;
}

function liveAgent(spec: FakeAgentSpec): ManagedAgent {
  return {
    id: spec.id,
    provider: "claude",
    cwd: "/work",
    workspaceId: spec.workspaceId,
    labels: spec.labels ?? {},
    lifecycle: spec.status ?? "idle",
    pendingPermissions: new Map(
      Array.from({ length: spec.pendingPermissions ?? 0 }, (_, i) => [`p${i}`, {}]),
    ),
    // Minimal shape so toAgentPayload (agent-projections.ts), which get_agent_status's full
    // snapshot path runs through, doesn't crash reading these.
    config: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    features: [],
    persistence: null,
    attention: { requiresAttention: false },
  } as unknown as ManagedAgent;
}

function createHarness(specs: FakeAgentSpec[], callerAgentId?: string) {
  // Archived specs never go live — a real archived agent is interrupted and removed from the
  // active fleet, leaving only its storage record.
  const archivedIds = new Set(specs.filter((s) => s.archived).map((s) => s.id));
  const live = new Map(specs.filter((s) => !s.archived).map((s) => [s.id, liveAgent(s)]));
  const setLabels = vi.fn(async (id: string, patch: Record<string, string | null>) => {
    const agent = live.get(id);
    if (!agent) return;
    const nextLabels = { ...agent.labels };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete nextLabels[key];
      else nextLabels[key] = value;
    }
    live.set(id, { ...agent, labels: nextLabels });
  });
  const toStoredRecord = (s: FakeAgentSpec) =>
    ({
      id: s.id,
      internal: false,
      title: s.title ?? null,
      archivedAt: archivedIds.has(s.id) ? "2026-04-12T00:00:00.000Z" : null,
      labels: s.labels ?? {},
      provider: "claude",
      cwd: "/work",
      createdAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
      lastUserMessageAt: null,
    }) as unknown as StoredAgentRecord;
  // resolveAgentIdentifier (resolve-agent-identifier.ts) reads this to build its prefix/title
  // lookup table, so it has to list the same ids the fake agentManager knows about.
  const agentStorageList = async () => specs.map(toStoredRecord);
  const hasInFlightRun = vi.fn((_id: string) => false);
  const cancelAgentRun = vi.fn(async (_id: string) => ({ status: "settled" as const }));
  const closeAgent = vi.fn(async (_id: string) => undefined);
  const clearAgentAttention = vi.fn(async (_id: string) => undefined);
  const archiveAgent = vi.fn(async (id: string) => {
    archivedIds.add(id);
    live.delete(id);
    return { archivedAt: "2026-04-12T00:00:00.000Z" };
  });
  const updateAgentMetadata = vi.fn(
    async (_id: string, _updates: { title?: string; labels?: Record<string, string> }) => undefined,
  );
  const setAgentMode = vi.fn(async (_id: string, _modeId: string) => null);
  const respondToPermission = vi.fn(
    async (_id: string, _requestId: string, _response: unknown) => undefined,
  );
  const getTimeline = vi.fn((_id: string) => [] as unknown[]);
  const agentManager = {
    listAgents: () => [...live.values()],
    getAgent: (id: string) => live.get(id) ?? null,
    setLabels,
    hasInFlightRun,
    cancelAgentRun,
    closeAgent,
    clearAgentAttention,
    archiveAgent,
    updateAgentMetadata,
    setAgentMode,
    respondToPermission,
    getTimeline,
  };
  const agentStorage = {
    list: agentStorageList,
    get: async (id: string) => {
      const spec = specs.find((s) => s.id === id);
      return spec ? toStoredRecord(spec) : null;
    },
  };
  const catalog = createPaseoToolCatalog({
    agentManager: agentManager as unknown as AgentManager,
    agentStorage: agentStorage as unknown as AgentStorage,
    providerSnapshotManager: { listRegisteredProviderIds: () => [] },
    logger: pino({ level: "silent" }),
    ...(callerAgentId !== undefined ? { callerAgentId } : {}),
  } as unknown as PaseoToolHostDependencies);
  return { catalog, agentManager, agentStorage, setLabels, hasInFlightRun, cancelAgentRun, live };
}

async function call(
  harness: ReturnType<typeof createHarness>,
  tool: string,
  input: Record<string, unknown> = {},
) {
  const result = await harness.catalog.executeTool(tool, input);
  return result.structuredContent as Record<string, Loose>;
}

describe("set_completion_state", () => {
  test("with no agentId, resolves to the caller itself", async () => {
    const harness = createHarness([{ id: "self-1" }], "self-1");

    const result = await call(harness, "set_completion_state", { state: "ready-to-merge" });

    expect(result).toMatchObject({ success: true, state: "ready-to-merge" });
    expect(harness.setLabels).toHaveBeenCalledWith(
      "self-1",
      expect.objectContaining({ [COMPLETION_LABEL]: "ready-to-merge" }),
    );
  });

  test("a parent may set state on its own child via agentId", async () => {
    const harness = createHarness(
      [{ id: "parent-1" }, { id: "child-1", labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } }],
      "parent-1",
    );

    const result = await call(harness, "set_completion_state", {
      state: "done",
      agentId: "child-1",
    });

    expect(result).toMatchObject({ success: true, state: "done" });
    expect(harness.setLabels).toHaveBeenCalledWith("child-1", expect.anything());
  });

  test("an empty agentId targets the caller itself, same as omitting it", async () => {
    const harness = createHarness([{ id: "self-1" }], "self-1");

    const result = await call(harness, "set_completion_state", {
      state: "ready-to-merge",
      agentId: "",
    });

    expect(result).toMatchObject({ success: true, state: "ready-to-merge" });
    expect(harness.setLabels).toHaveBeenCalledWith(
      "self-1",
      expect.objectContaining({ [COMPLETION_LABEL]: "ready-to-merge" }),
    );
  });

  test("a whitespace-only agentId targets the caller itself, same as omitting it", async () => {
    const harness = createHarness([{ id: "self-1" }], "self-1");

    const result = await call(harness, "set_completion_state", {
      state: "ready-to-merge",
      agentId: "   ",
    });

    expect(result).toMatchObject({ success: true, state: "ready-to-merge" });
    expect(harness.setLabels).toHaveBeenCalledWith(
      "self-1",
      expect.objectContaining({ [COMPLETION_LABEL]: "ready-to-merge" }),
    );
  });

  test("refuses a caller with no agent session", async () => {
    const harness = createHarness([{ id: "self-1" }]);

    await expect(
      call(harness, "set_completion_state", { state: "ready-to-merge" }),
    ).rejects.toThrow(/requires a caller agent/);
  });

  test("refuses a stranger targeting an agent that is not its child", async () => {
    const harness = createHarness([{ id: "caller-1" }, { id: "other-1" }], "caller-1");

    await expect(
      call(harness, "set_completion_state", { state: "done", agentId: "other-1" }),
    ).rejects.toThrow(/not the parent/);
  });

  test("clear always succeeds and removes the labels", async () => {
    const harness = createHarness(
      [{ id: "self-1", labels: { [COMPLETION_LABEL]: "ready-to-merge" } }],
      "self-1",
    );

    const result = await call(harness, "set_completion_state", { state: "clear" });

    expect(result).toEqual({ success: true, state: null, note: null, completionAt: null });
  });

  test("a note over 200 chars is rejected by the input schema", async () => {
    const harness = createHarness([{ id: "self-1" }], "self-1");

    await expect(
      call(harness, "set_completion_state", { state: "done", note: "x".repeat(201) }),
    ).rejects.toThrow();
  });

  test("a parent targeting a stranger via a short prefix is still refused", async () => {
    // "stranger-1" is seeded with a unique 7-char prefix, but it is not parent-1's child. Prefix
    // resolution must land on the same full id a direct call would — it must never widen access
    // beyond what the caller could already reach with the full id.
    const harness = createHarness(
      [
        { id: "parent-1" },
        { id: "child-1", labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } },
        { id: "strangr9-unrelated" },
      ],
      "parent-1",
    );

    await expect(
      call(harness, "set_completion_state", { state: "done", agentId: "strangr9" }),
    ).rejects.toThrow(/not the parent/);
  });
});

describe("agent id resolution (short id / prefix)", () => {
  test("get_agent_status resolves a unique prefix to the same snapshot as the full id", async () => {
    const harness = createHarness([{ id: "abcdefg-live-agent", status: "running" }]);

    const byFullId = await call(harness, "get_agent_status", { agentId: "abcdefg-live-agent" });
    const byPrefix = await call(harness, "get_agent_status", { agentId: "abcdefg" });

    expect(byPrefix).toEqual(byFullId);
    expect(byPrefix.snapshot).toMatchObject({ id: "abcdefg-live-agent" });
  });

  test("get_agent_status throws the resolver's ambiguous-identifier message for a shared prefix", async () => {
    const harness = createHarness([{ id: "abcdefg-one" }, { id: "abcdefg-two" }]);

    await expect(call(harness, "get_agent_status", { agentId: "abcdefg" })).rejects.toThrow(
      /ambiguous/,
    );
    await expect(call(harness, "get_agent_status", { agentId: "abcdefg" })).rejects.toThrow(
      /abcdefg-/,
    );
  });

  test("get_agent_status throws the resolver's not-found message for an unmatched identifier", async () => {
    const harness = createHarness([{ id: "abcdefg-live-agent" }]);

    await expect(call(harness, "get_agent_status", { agentId: "no-such-agent" })).rejects.toThrow(
      /Agent not found: no-such-agent/,
    );
  });

  test("cancel_agent called with a unique prefix cancels the correct agent", async () => {
    const harness = createHarness([
      { id: "abcdefg-target", status: "running" },
      { id: "zzzzzzz-other", status: "running" },
    ]);
    harness.hasInFlightRun.mockImplementation((id: string) => id === "abcdefg-target");

    const result = await call(harness, "cancel_agent", { agentId: "abcdefg" });

    expect(result).toEqual({ success: true });
    expect(harness.cancelAgentRun).toHaveBeenCalledWith("abcdefg-target", "archive");
    expect(harness.cancelAgentRun).not.toHaveBeenCalledWith("zzzzzzz-other", expect.anything());
  });

  test("send_agent_prompt with a unique prefix that does not move accounts reports no moved fields", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);
    // Echoes back whatever agentId it was given — the harness's stand-in for a delivery that
    // never moved accounts, so the handler's resolved-vs-returned comparison should see a match.
    sendPromptToAgentMock.mockImplementation(
      async (params: Loose) => ({ disposition: "turn_started", agentId: params.agentId }) as Loose,
    );

    const result = await call(harness, "send_agent_prompt", {
      agentId: "abcdefg",
      prompt: "hello",
      background: true,
    });

    const lastCall = sendPromptToAgentMock.mock.calls.at(-1) as Loose;
    expect(lastCall?.[0]?.agentId).toBe("abcdefg-target");
    expect(result.deliveredToAgentId).toBeUndefined();
    expect(result.guidance).toBeUndefined();
  });

  test("send_agent_prompt with a unique prefix that moves accounts reports the resolved id as moved", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);
    // Delivery landed on a different agent (account failover) than the one resolution picked —
    // the handler must compare its own resolved id against this returned id, not the raw prefix
    // the caller typed, or every prefix call would look "moved" even when nothing moved.
    sendPromptToAgentMock.mockImplementation(
      async () => ({ disposition: "turn_started", agentId: "moved-to-agent" }) as Loose,
    );

    const result = await call(harness, "send_agent_prompt", {
      agentId: "abcdefg",
      prompt: "hello",
      background: true,
    });

    expect(result.deliveredToAgentId).toBe("moved-to-agent");
    expect(result.guidance).toContain("abcdefg-target moved to moved-to-agent");
  });

  test("archive_agent called with a unique prefix archives the correct agent", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    const result = await call(harness, "archive_agent", { agentId: "abcdefg" });

    expect(result).toEqual({ success: true });
    expect(harness.agentManager.archiveAgent).toHaveBeenCalledWith("abcdefg-target");
  });

  test("kill_agent called with a unique prefix kills the correct agent", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    const result = await call(harness, "kill_agent", { agentId: "abcdefg" });

    expect(result).toEqual({ success: true });
    expect(harness.agentManager.closeAgent).toHaveBeenCalledWith("abcdefg-target");
  });

  test("update_agent called with a unique prefix updates the correct agent", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    const result = await call(harness, "update_agent", { agentId: "abcdefg", name: "Renamed" });

    expect(result).toEqual({ success: true });
    expect(harness.agentManager.updateAgentMetadata).toHaveBeenCalledWith("abcdefg-target", {
      title: "Renamed",
    });
  });

  test("get_agent_activity called with a unique prefix reads the correct agent's timeline", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    const result = await call(harness, "get_agent_activity", { agentId: "abcdefg" });

    expect(result.agentId).toBe("abcdefg-target");
    expect(harness.agentManager.getTimeline).toHaveBeenCalledWith("abcdefg-target");
  });

  test("set_agent_mode called with a unique prefix sets mode on the correct agent", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    const result = await call(harness, "set_agent_mode", { agentId: "abcdefg", modeId: "auto" });

    expect(result).toEqual({ success: true, newMode: "auto" });
    expect(harness.agentManager.setAgentMode).toHaveBeenCalledWith("abcdefg-target", "auto");
  });

  test("respond_to_permission called with a unique prefix responds on the correct agent", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    const result = await call(harness, "respond_to_permission", {
      agentId: "abcdefg",
      requestId: "perm-1",
      response: { behavior: "allow" },
    });

    expect(result).toEqual({ success: true });
    expect(harness.agentManager.respondToPermission).toHaveBeenCalledWith(
      "abcdefg-target",
      "perm-1",
      { behavior: "allow" },
    );
  });

  test("a prefix shorter than 4 characters is rejected even when it uniquely matches", async () => {
    const harness = createHarness([{ id: "abcdefg-target", status: "idle" }]);

    await expect(call(harness, "get_agent_status", { agentId: "abc" })).rejects.toThrow(
      /Agent not found: abc/,
    );
  });

  test("get_agent_status does not resolve a unique archived title match by default", async () => {
    // send_agent_prompt (and every other MCP tool) defaults to unarchiving its target, so a
    // title match landing on an archived agent would silently revive it. The resolver's
    // includeArchived:false wiring for MCP tools must keep this refused.
    const harness = createHarness([
      { id: "archived-1", archived: true, title: "old research spike" },
    ]);

    await expect(
      call(harness, "get_agent_status", { agentId: "old research spike" }),
    ).rejects.toThrow(/Agent not found: old research spike/);
  });

  test("get_agent_status resolves an archived agent by its exact full id", async () => {
    const harness = createHarness([{ id: "archived-1", archived: true }]);

    const result = await call(harness, "get_agent_status", { agentId: "archived-1" });

    expect(result.snapshot).toMatchObject({ id: "archived-1", archivedAt: expect.any(String) });
  });
});
