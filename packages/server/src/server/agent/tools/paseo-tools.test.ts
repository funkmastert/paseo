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
  const live = new Map(specs.map((s) => [s.id, liveAgent(s)]));
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
  // resolveAgentIdentifier (resolve-agent-identifier.ts) reads this to build its prefix/title
  // lookup table, so it has to list the same ids the fake agentManager knows about.
  const agentStorageList = async () =>
    specs.map(
      (s) =>
        ({
          id: s.id,
          internal: false,
          title: null,
          archivedAt: null,
          labels: s.labels ?? {},
        }) as unknown as StoredAgentRecord,
    );
  const hasInFlightRun = vi.fn((_id: string) => false);
  const cancelAgentRun = vi.fn(async (_id: string) => ({ status: "settled" as const }));
  const agentManager = {
    listAgents: () => [...live.values()],
    getAgent: (id: string) => live.get(id) ?? null,
    setLabels,
    hasInFlightRun,
    cancelAgentRun,
  };
  const agentStorage = {
    list: agentStorageList,
    get: async (_id: string) => null,
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
});
