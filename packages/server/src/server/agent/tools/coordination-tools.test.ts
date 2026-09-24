import { beforeEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";
import {
  DEFAULT_MAX_WAKES,
  MAX_BROADCAST_TARGETS,
  buildWhoami,
  planBroadcastDelivery,
  type FleetEntry,
} from "./coordination-tools.js";
import type { PaseoToolHostDependencies } from "./types.js";

const promptMocks = vi.hoisted(() => ({
  sendPromptToAgent: vi.fn(async () => ({ disposition: "turn_started" })),
  setupFinishNotification: vi.fn(),
}));

// The delivery boundary: whether a prompt reaches an agent is exactly what these tests assert,
// so it is the one seam replaced. Everything that decides whether to call it is real.
vi.mock("../agent-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-prompt.js")>()),
  sendPromptToAgent: promptMocks.sendPromptToAgent,
  setupFinishNotification: promptMocks.setupFinishNotification,
}));

// Tool payloads are asserted field by field; each test states the shape it expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Structured tool output is untyped JSON.
type Loose = any;

const PARENT_LABEL = "paseo.parent-agent-id";

interface FakeAgentSpec {
  id: string;
  title?: string;
  status?: ManagedAgent["lifecycle"];
  provider?: string;
  labels?: Record<string, string>;
  runningModel?: string | null;
  configuredModel?: string | null;
  activity?: string;
  totalTokens?: number;
  /** A stored record only: not loaded in the manager. */
  stored?: boolean;
  archived?: boolean;
}

function record(spec: FakeAgentSpec): StoredAgentRecord {
  return {
    id: spec.id,
    provider: spec.provider ?? "claude",
    cwd: "/work",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    title: spec.title ?? null,
    labels: spec.labels ?? {},
    lastStatus: spec.status ?? "idle",
    config: spec.configuredModel ? { model: spec.configuredModel } : null,
    archivedAt: spec.archived ? "2026-09-23T01:00:00.000Z" : null,
  } as StoredAgentRecord;
}

function liveAgent(spec: FakeAgentSpec): ManagedAgent {
  return {
    id: spec.id,
    provider: spec.provider ?? "claude",
    cwd: "/work",
    labels: spec.labels ?? {},
    lifecycle: spec.status ?? "idle",
    config: { model: spec.configuredModel ?? null },
    runtimeInfo: spec.runningModel
      ? { provider: spec.provider ?? "claude", sessionId: "sess", model: spec.runningModel }
      : undefined,
    lastActivitySummary: spec.activity,
    totalTokens: spec.totalTokens,
    attention: { requiresAttention: false },
    pendingPermissions: new Map(),
    currentModeId: null,
    persistence: null,
  } as unknown as ManagedAgent;
}

function createHarness(specs: FakeAgentSpec[], callerAgentId?: string) {
  const live = new Map(specs.filter((s) => !s.stored).map((s) => [s.id, liveAgent(s)]));
  const steerAgentRun = vi.fn(async () => ({ status: "accepted" as const }));
  const agentManager = {
    listAgents: () => [...live.values()],
    getAgent: (id: string) => live.get(id) ?? null,
    getSpendFanOutDenial: vi.fn(() => null),
    getPaseoToolPolicy: () => undefined,
    steerAgentRun,
    // Anything that starts or replaces a turn. A broadcast must never reach these directly.
    streamAgent: vi.fn(),
    replaceAgentRun: vi.fn(),
    steerIntoActiveTurn: vi.fn(),
  };
  const agentStorage = {
    list: async () => specs.map(record),
    get: async (id: string) => {
      const spec = specs.find((s) => s.id === id);
      return spec ? record(spec) : null;
    },
  };
  const catalog = createPaseoToolCatalog({
    agentManager: agentManager as unknown as AgentManager,
    agentStorage: agentStorage as unknown as AgentStorage,
    providerSnapshotManager: { listRegisteredProviderIds: () => [] },
    logger: pino({ level: "silent" }),
    ...(callerAgentId !== undefined ? { callerAgentId } : {}),
  } as unknown as PaseoToolHostDependencies);
  return { catalog, agentManager, steerAgentRun };
}

async function call(
  harness: ReturnType<typeof createHarness>,
  tool: string,
  input: Record<string, unknown> = {},
) {
  const result = await harness.catalog.executeTool(tool, input);
  return result.structuredContent as Record<string, Loose>;
}

beforeEach(() => {
  promptMocks.sendPromptToAgent.mockClear();
  promptMocks.setupFinishNotification.mockClear();
});

describe("whoami", () => {
  test("names the caller, its parent, the model it actually runs and its budget", async () => {
    const harness = createHarness(
      [
        { id: "leader-1", title: "Leader", status: "running" },
        {
          id: "me",
          title: "Implement the parser",
          status: "running",
          provider: "claude-pool-b",
          configuredModel: "claude-opus-5-5",
          runningModel: "claude-sonnet-5",
          totalTokens: 41_000,
          labels: {
            [PARENT_LABEL]: "leader-1",
            "paseo.agent-role": "implementer",
            "paseo.task-class": "standard",
            "paseo.budget": "300000",
            "paseo.tools-denied": "Bash, Write",
          },
        },
      ],
      "me",
    );

    const who = await call(harness, "whoami");

    expect(who.id).toBe("me");
    expect(who.account.provider).toBe("claude-pool-b");
    expect(who.parent).toEqual({ id: "leader-1", title: "Leader", status: "running" });
    expect(who.model).toEqual({
      running: "claude-sonnet-5",
      configured: "claude-opus-5-5",
      diverged: true,
    });
    expect(who.warnings.join(" ")).toContain("claude-sonnet-5, not the claude-opus-5-5");
    expect(who.classifier).toMatchObject({
      role: "implementer",
      taskClass: "standard",
      toolsDenied: ["Bash", "Write"],
    });
    expect(who.budget).toEqual({ budgetTokens: 300000, spentTokens: 41000, fanOutBlocked: false });
  });

  test("lists children and siblings by state, and hides per-agent detail until asked", async () => {
    const harness = createHarness(
      [
        { id: "leader-1", status: "running" },
        { id: "me", status: "running", labels: { [PARENT_LABEL]: "leader-1" } },
        {
          id: "sib-a",
          status: "running",
          labels: { [PARENT_LABEL]: "leader-1" },
          activity: "[Edit] a.ts",
        },
        { id: "sib-b", status: "idle", labels: { [PARENT_LABEL]: "leader-1" } },
        { id: "kid-1", status: "idle", labels: { [PARENT_LABEL]: "me" } },
        { id: "stranger", status: "running" },
      ],
      "me",
    );

    const compact = await call(harness, "whoami");
    expect(compact.peers).toEqual({ count: 2, byState: { running: 1, idle: 1 } });
    expect(compact.children.count).toBe(1);
    expect(compact.children.agents).toEqual([{ id: "kid-1", title: null, status: "idle" }]);
    expect(compact.labels).toBeUndefined();

    const full = await call(harness, "whoami", { full: true });
    expect(full.peers.agents.map((a: { id: string }) => a.id).sort()).toEqual(["sib-a", "sib-b"]);
    expect(full.peers.agents.find((a: { id: string }) => a.id === "sib-a").activity).toBe(
      "[Edit] a.ts",
    );
    expect(full.labels).toEqual({ [PARENT_LABEL]: "leader-1" });
  });

  test("a hand-made successor with no parent label is told who is not being notified", async () => {
    const harness = createHarness(
      [
        { id: "leader-1", status: "running" },
        {
          id: "old",
          status: "closed",
          labels: { [PARENT_LABEL]: "leader-1", "paseo.account-failover.migrated-to": "me" },
        },
        { id: "me", status: "running", labels: { "handoff-from": "old" } },
      ],
      "me",
    );

    const who = await call(harness, "whoami");

    expect(who.id).toBe("me");
    expect(who.parent).toBeNull();
    expect(who.predecessor.id).toBe("old");
    expect(who.movedByFailover).toBe(true);
    expect(who.warnings.join(" ")).toContain("leader-1");
    expect(who.warnings.join(" ")).toContain("will not be told when you finish");
  });

  test("a retired handle is told the live end is elsewhere", () => {
    const self = entry({
      id: "old",
      labels: { "paseo.account-failover.migrated-to": "successor-9" },
    });
    const who = buildWhoami({
      self,
      fleet: new Map([[self.id, self]]),
      fanOutDenial: null,
      full: false,
    });

    expect(who.retiredTo).toBe("successor-9");
    expect((who.warnings as string[]).join(" ")).toContain("successor-9");
  });

  test("reports what the classifier stamped and does not invent a role", async () => {
    const harness = createHarness(
      [
        {
          id: "me",
          status: "running",
          labels: {
            "paseo.model-overridden-by-policy": "claude-opus-5-5",
            "paseo.model-unadvertised": "claude-x",
          },
        },
      ],
      "me",
    );

    const who = await call(harness, "whoami");

    expect(who.classifier.role).toBeNull();
    expect(who.classifier.modelOverriddenFrom).toBe("claude-opus-5-5");
    expect(who.classifier.modelUnverified).toBe("claude-x");
  });

  test("refuses outside an agent session instead of answering for nobody", async () => {
    const harness = createHarness([{ id: "me" }]);
    await expect(harness.catalog.executeTool("whoami", {})).rejects.toThrow(/agent session/);
  });
});

describe("planBroadcastDelivery", () => {
  const plan = (
    status: string,
    opts: { live?: boolean; wakeIdle?: boolean; wakes?: number } = {},
  ) =>
    planBroadcastDelivery({
      entry: { status, live: opts.live ?? true },
      wakeIdle: opts.wakeIdle ?? false,
      wakesRemaining: opts.wakes ?? DEFAULT_MAX_WAKES,
    });

  test("a running agent takes the message into its current turn", () => {
    expect(plan("running")).toEqual({ action: "steer" });
  });

  test("an idle agent is skipped unless the caller opted in to paying for a turn", () => {
    expect(plan("idle")).toMatchObject({ action: "skip" });
    expect(plan("idle", { wakeIdle: true })).toEqual({ action: "wake" });
  });

  test("idle agents beyond the wake cap are skipped", () => {
    expect(plan("idle", { wakeIdle: true, wakes: 0 })).toMatchObject({ action: "skip" });
  });

  test.each(["error", "closed", "initializing"])("a %s agent is never contacted", (status) => {
    expect(plan(status, { wakeIdle: true })).toMatchObject({ action: "skip" });
  });

  test("a stored agent is never loaded to receive a broadcast", () => {
    expect(plan("idle", { live: false, wakeIdle: true })).toMatchObject({ action: "skip" });
    expect(plan("running", { live: false })).toMatchObject({ action: "skip" });
  });
});

describe("broadcast_agent_prompt", () => {
  const fleet: FakeAgentSpec[] = [
    { id: "boss", status: "running" },
    {
      id: "run-1",
      title: "Reviewer A",
      status: "running",
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
    },
    {
      id: "idle-1",
      title: "Reviewer B",
      status: "idle",
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
    },
    {
      id: "idle-2",
      status: "idle",
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
    },
    {
      id: "err-1",
      status: "error",
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
    },
    {
      id: "stored-1",
      status: "idle",
      stored: true,
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
    },
    {
      id: "archived-1",
      status: "idle",
      archived: true,
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
    },
    {
      id: "impl-1",
      status: "running",
      labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "implementer" },
    },
    { id: "other-tree", status: "running", labels: { "paseo.agent-role": "reviewer" } },
  ];

  test("by default it reaches only the running agents and starts no turn anywhere", async () => {
    const harness = createHarness(fleet, "boss");

    const result = await call(harness, "broadcast_agent_prompt", {
      prompt: "Freeze the API surface.",
      labels: { "paseo.agent-role": "reviewer" },
    });

    expect(result.steered).toBe(1);
    expect(result.turnsStarted).toBe(0);
    const byId = Object.fromEntries(result.results.map((r: Loose) => [r.agentId, r]));
    expect(byId["run-1"].outcome).toBe("steered");
    expect(byId["idle-1"]).toMatchObject({ outcome: "skipped" });
    expect(byId["idle-1"].reason).toContain("paid turn");
    expect(byId["err-1"].outcome).toBe("skipped");
    expect(byId["stored-1"].outcome).toBe("skipped");
    // The label selector, the archive filter and the scope all applied.
    expect(Object.keys(byId).sort()).toEqual(["err-1", "idle-1", "idle-2", "run-1", "stored-1"]);

    expect(harness.steerAgentRun).toHaveBeenCalledTimes(1);
    expect(harness.steerAgentRun).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("Freeze the API surface."),
    );
    expect(harness.steerAgentRun.mock.calls[0]?.[1]).toContain("Broadcast from agent boss");
    // Nothing that starts or replaces a turn was touched, and no prompt was dispatched.
    expect(promptMocks.sendPromptToAgent).not.toHaveBeenCalled();
    expect(harness.agentManager.streamAgent).not.toHaveBeenCalled();
    expect(harness.agentManager.replaceAgentRun).not.toHaveBeenCalled();
    expect(harness.agentManager.steerIntoActiveTurn).not.toHaveBeenCalled();
  });

  test("a steer the provider cannot take is skipped, never turned into a replacement turn", async () => {
    const harness = createHarness(fleet, "boss");
    harness.steerAgentRun.mockResolvedValueOnce({ status: "unavailable" } as never);

    const result = await call(harness, "broadcast_agent_prompt", {
      prompt: "Status?",
      labels: { "paseo.agent-role": "implementer" },
    });

    expect(result.steered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.turnsStarted).toBe(0);
    expect(promptMocks.sendPromptToAgent).not.toHaveBeenCalled();
    expect(harness.agentManager.replaceAgentRun).not.toHaveBeenCalled();
  });

  test("wakeIdle starts turns on idle agents up to maxWakes, without unarchiving, and tells the caller when they finish", async () => {
    const harness = createHarness(fleet, "boss");

    const result = await call(harness, "broadcast_agent_prompt", {
      prompt: "Re-review the diff.",
      labels: { "paseo.agent-role": "reviewer" },
      wakeIdle: true,
      maxWakes: 1,
    });

    expect(result.woken).toBe(1);
    expect(result.turnsStarted).toBe(1);
    const byId = Object.fromEntries(result.results.map((r: Loose) => [r.agentId, r]));
    expect(byId["idle-1"].outcome).toBe("woken");
    expect(byId["idle-2"]).toMatchObject({ outcome: "skipped", reason: "idle: maxWakes reached" });

    expect(promptMocks.sendPromptToAgent).toHaveBeenCalledTimes(1);
    expect(promptMocks.sendPromptToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "idle-1", unarchive: false, activeTurnBehavior: "steer" }),
    );
    expect(promptMocks.setupFinishNotification).toHaveBeenCalledWith(
      expect.objectContaining({ childAgentId: "idle-1", callerAgentId: "boss" }),
    );
  });

  test("dry run reports the plan and sends nothing", async () => {
    const harness = createHarness(fleet, "boss");

    const result = await call(harness, "broadcast_agent_prompt", {
      prompt: "x",
      labels: { "paseo.agent-role": "reviewer" },
      wakeIdle: true,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.turnsStarted).toBe(0);
    expect(result.woken).toBe(2);
    expect(harness.steerAgentRun).not.toHaveBeenCalled();
    expect(promptMocks.sendPromptToAgent).not.toHaveBeenCalled();
  });

  test("a selector that matches too many agents is refused whole, not truncated", async () => {
    const many: FakeAgentSpec[] = [{ id: "boss", status: "running" }];
    for (let i = 0; i <= MAX_BROADCAST_TARGETS; i += 1) {
      many.push({ id: `kid-${i}`, status: "running", labels: { [PARENT_LABEL]: "boss" } });
    }
    const harness = createHarness(many, "boss");

    await expect(
      harness.catalog.executeTool("broadcast_agent_prompt", { prompt: "x" }),
    ).rejects.toThrow(/Nothing was sent/);
    expect(harness.steerAgentRun).not.toHaveBeenCalled();
  });

  test("the description states the cost so a leader does not fan it out casually", () => {
    const harness = createHarness([{ id: "boss" }], "boss");
    const description = harness.catalog.getTool("broadcast_agent_prompt")?.description ?? "";
    expect(description).toContain("COST");
    expect(description).toContain("paid turn");
    expect(description).toContain("wakeIdle");
  });

  test("siblings scope reaches agents under the same parent, not the caller", async () => {
    const harness = createHarness(
      [
        { id: "boss", status: "running" },
        { id: "me", status: "running", labels: { [PARENT_LABEL]: "boss" } },
        { id: "sib", status: "running", labels: { [PARENT_LABEL]: "boss" } },
      ],
      "me",
    );

    const result = await call(harness, "broadcast_agent_prompt", {
      prompt: "hi",
      scope: "siblings",
    });

    expect(result.results.map((r: Loose) => r.agentId)).toEqual(["sib"]);
  });
});

describe("list_peers", () => {
  test("shows what children are doing, filtered by label and state", async () => {
    const harness = createHarness(
      [
        { id: "boss", status: "running" },
        {
          id: "a",
          title: "A",
          status: "running",
          activity: "[Bash] npm test",
          labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
        },
        {
          id: "b",
          title: "B",
          status: "idle",
          labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "reviewer" },
        },
        {
          id: "c",
          title: "C",
          status: "running",
          labels: { [PARENT_LABEL]: "boss", "paseo.agent-role": "implementer" },
        },
      ],
      "boss",
    );

    const result = await call(harness, "list_peers", {
      labels: { "paseo.agent-role": "reviewer" },
      statuses: ["running"],
    });

    expect(result.count).toBe(1);
    expect(result.agents).toEqual([
      {
        id: "a",
        title: "A",
        status: "running",
        activity: "[Bash] npm test",
        model: null,
        role: "reviewer",
      },
    ]);
  });
});

function entry(overrides: Partial<FleetEntry> & { id: string }): FleetEntry {
  return {
    title: null,
    status: "idle",
    live: true,
    provider: "claude",
    cwd: "/work",
    workspaceId: null,
    labels: {},
    runningModel: null,
    configuredModel: null,
    activity: null,
    totalTokens: null,
    archived: false,
    requiresAttention: false,
    pendingPermissionCount: 0,
    currentModeId: null,
    sessionId: null,
    ...overrides,
  };
}
