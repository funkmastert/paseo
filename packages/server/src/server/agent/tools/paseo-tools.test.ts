import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { PARENT_AGENT_ID_LABEL, COMPLETION_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import type { PaseoToolHostDependencies } from "./types.js";

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
  const agentManager = {
    listAgents: () => [...live.values()],
    getAgent: (id: string) => live.get(id) ?? null,
    setLabels,
  };
  const catalog = createPaseoToolCatalog({
    agentManager: agentManager as unknown as AgentManager,
    agentStorage: {} as unknown as AgentStorage,
    providerSnapshotManager: { listRegisteredProviderIds: () => [] },
    logger: pino({ level: "silent" }),
    ...(callerAgentId !== undefined ? { callerAgentId } : {}),
  } as unknown as PaseoToolHostDependencies);
  return { catalog, agentManager, setLabels, live };
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
});
