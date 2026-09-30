import { describe, expect, test, vi } from "vitest";

import type { AgentManager, WorkspaceTitleTrackerAgentSummary } from "./agent/agent-manager.js";
import type { StructuredAgentGenerationWithFallbackOptions } from "./agent/agent-response-loop.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import { createTestJevService, type TestJevServiceOptions } from "./jev/fake.js";
import type { JevService } from "./jev/contract.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import {
  TITLE_REFRESH_DEFAULTS,
  type ResolvedWorkspaceTitleRefreshConfig,
} from "./workspace-title-refresh-config.js";
import { WorkspaceTitleTracker } from "./workspace-title-tracker.js";

function createJevForTest(options: TestJevServiceOptions = {}) {
  return createTestJevService({
    ...options,
    service: { resolveAgentCwds: async () => [], ...options.service },
  });
}

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const MINUTE = 60_000;

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function workspace(overrides: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  return {
    ...createPersistedWorkspaceRecord({
      workspaceId: "wks_checkout",
      projectId: "prj_paseo",
      cwd: "/Users/t/paseo",
      kind: "local_checkout",
      displayName: "main",
      title: "i ran into a situation where my agents",
      titleSource: "auto",
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
    }),
    ...overrides,
  };
}

function agent(
  overrides: Partial<WorkspaceTitleTrackerAgentSummary> = {},
): WorkspaceTitleTrackerAgentSummary {
  return {
    id: "agent-1",
    workspaceId: "wks_checkout",
    internal: false,
    lifecycle: "running",
    title: "Debug Paseo daemon CPU spike",
    lastActivitySummary: "Read daemon.log",
    lastActivityAt: new Date(NOW - MINUTE).toISOString(),
    ...overrides,
  };
}

interface Harness {
  tracker: WorkspaceTitleTracker;
  records: Map<string, PersistedWorkspaceRecord>;
  prompts: string[];
  emitted: string[];
  titleRefreshEvents: unknown[];
  setNow(ms: number): void;
  setTitle(title: string): void;
  recordTurn(agentId: string): void;
}

function createHarness(input: {
  workspaces: PersistedWorkspaceRecord[];
  agents?: WorkspaceTitleTrackerAgentSummary[];
  config?: StructuredGenerationDaemonConfig;
  onUpdate?: (records: Map<string, PersistedWorkspaceRecord>) => void;
  jev?: Pick<JevService, "decide"> | null;
  titleRefreshConfig?: Partial<ResolvedWorkspaceTitleRefreshConfig>;
}): Harness {
  const records = new Map(input.workspaces.map((record) => [record.workspaceId, record]));
  const prompts: string[] = [];
  const emitted: string[] = [];
  const titleRefreshEvents: unknown[] = [];
  let nowMs = NOW;
  let generatedTitle = "Multi-account orchestrator fork";

  const registry = {
    list: async () => Array.from(records.values()),
    update: async (
      workspaceId: string,
      updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    ) => {
      input.onUpdate?.(records);
      const existing = records.get(workspaceId);
      if (!existing) return null;
      const next = updater(existing);
      records.set(workspaceId, next);
      return next;
    },
  } as unknown as Pick<WorkspaceRegistry, "list" | "update">;

  const agentsByWorkspace = new Map<string, string>();
  for (const a of input.agents ?? []) {
    if (a.workspaceId) agentsByWorkspace.set(a.id, a.workspaceId);
  }

  const tracker = new WorkspaceTitleTracker({
    agentManager: {
      listAgentsForWorkspaceTitleTracker: () => input.agents ?? [],
      getAgent: (id: string) => {
        const workspaceId = agentsByWorkspace.get(id);
        return workspaceId ? { workspaceId } : null;
      },
    } as unknown as AgentManager,
    workspaceRegistry: registry,
    readDaemonConfig: () => input.config ?? {},
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      emitted.push(workspaceId);
    },
    jev: input.jev,
    readTitleRefreshConfig: () => ({ ...TITLE_REFRESH_DEFAULTS, ...input.titleRefreshConfig }),
    recordTitleRefreshCheck: input.jev
      ? (event) => {
          titleRefreshEvents.push(event);
        }
      : undefined,
    logger: createLogger(),
    now: () => nowMs,
    deps: {
      generateStructuredAgentResponseWithFallback: (async <T>(
        options: StructuredAgentGenerationWithFallbackOptions<T>,
      ) => {
        prompts.push(options.prompt);
        return { title: generatedTitle } as T;
      }) as typeof import("./agent/agent-response-loop.js").generateStructuredAgentResponseWithFallback,
    },
  });

  return {
    tracker,
    records,
    prompts,
    emitted,
    titleRefreshEvents,
    recordTurn: (agentId) => {
      const workspaceId = agentsByWorkspace.get(agentId);
      tracker.recordAgentTurnFinished({ agentId, cwd: workspaceId ?? "" });
    },
    setNow: (ms) => {
      nowMs = ms;
    },
    setTitle: (title) => {
      generatedTitle = title;
    },
  };
}

/** The sweep anchors a workspace's interval on first sight, so a rename needs two ticks. */
async function sweepPastFirstSight(harness: Harness, elapsedMs = 31 * MINUTE): Promise<void> {
  await harness.tracker.tick();
  harness.setNow(NOW + elapsedMs);
  await harness.tracker.tick();
}

describe("WorkspaceTitleTracker", () => {
  test("renames an auto-named workspace from its recent agents", async () => {
    const harness = createHarness({ workspaces: [workspace()], agents: [agent()] });

    await sweepPastFirstSight(harness);

    expect(harness.records.get("wks_checkout")).toMatchObject({
      title: "Multi-account orchestrator fork",
      titleSource: "auto",
    });
    expect(harness.emitted).toEqual(["wks_checkout"]);
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Debug Paseo daemon CPU spike");
    expect(harness.prompts[0]).toContain("i ran into a situation where my agents");
  });

  test("first sight anchors the interval instead of renaming on sight", async () => {
    const harness = createHarness({ workspaces: [workspace()], agents: [agent()] });

    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(0);
    expect(harness.records.get("wks_checkout")?.title).toBe(
      "i ran into a situation where my agents",
    );
  });

  test("never touches a title the user set", async () => {
    const harness = createHarness({
      workspaces: [workspace({ title: "Bozeo fork", titleSource: "manual" })],
      agents: [agent()],
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(0);
    expect(harness.records.get("wks_checkout")?.title).toBe("Bozeo fork");
  });

  test("never touches a title whose provenance predates tracking", async () => {
    const harness = createHarness({
      workspaces: [workspace({ titleSource: undefined })],
      agents: [agent()],
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(0);
    expect(harness.records.get("wks_checkout")?.title).toBe(
      "i ran into a situation where my agents",
    );
  });

  test("a rename that lands mid-generation wins over the generated name", async () => {
    const harness = createHarness({
      workspaces: [workspace()],
      agents: [agent()],
      onUpdate: (records) => {
        const current = records.get("wks_checkout");
        if (current) {
          records.set("wks_checkout", {
            ...current,
            title: "Named by hand",
            titleSource: "manual",
          });
        }
      },
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(1);
    expect(harness.records.get("wks_checkout")?.title).toBe("Named by hand");
    expect(harness.emitted).toEqual([]);
  });

  test("unchanged agent titles cost no second call", async () => {
    const agents = [agent()];
    const harness = createHarness({ workspaces: [workspace()], agents });

    await sweepPastFirstSight(harness);
    expect(harness.prompts).toHaveLength(1);

    // Still busy an hour later, with the same title: nothing at the workspace's
    // altitude changed, so the second interval costs nothing.
    agents[0] = agent({ lastActivityAt: new Date(NOW + 61 * MINUTE).toISOString() });
    harness.setNow(NOW + 62 * MINUTE);
    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(1);
  });

  test("an agent title moving on earns a second call", async () => {
    const agents = [agent()];
    const harness = createHarness({ workspaces: [workspace()], agents });

    await sweepPastFirstSight(harness);
    expect(harness.prompts).toHaveLength(1);

    agents[0] = agent({
      title: "Add workspace title tracking",
      lastActivityAt: new Date(NOW + 61 * MINUTE).toISOString(),
    });
    harness.setTitle("Workspace title tracking");
    harness.setNow(NOW + 62 * MINUTE);
    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(2);
    expect(harness.records.get("wks_checkout")?.title).toBe("Workspace title tracking");
  });

  test("a changing activity summary alone is not worth a rename", async () => {
    const agents = [agent()];
    const harness = createHarness({ workspaces: [workspace()], agents });

    await sweepPastFirstSight(harness);
    expect(harness.prompts).toHaveLength(1);

    agents[0] = agent({
      lastActivitySummary: "Edit workspace-title-tracker.ts",
      lastActivityAt: new Date(NOW + 61 * MINUTE).toISOString(),
    });
    harness.setNow(NOW + 62 * MINUTE);
    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(1);
  });

  test("a dormant workspace is never swept", async () => {
    const harness = createHarness({
      workspaces: [workspace()],
      agents: [agent({ lastActivityAt: new Date(NOW - 6 * 60 * MINUTE).toISOString() })],
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(0);
  });

  test("internal, closed and foreign-workspace agents do not name a workspace", async () => {
    const harness = createHarness({
      workspaces: [workspace()],
      agents: [
        agent({ id: "internal", internal: true }),
        agent({ id: "closed", lifecycle: "closed" }),
        agent({ id: "elsewhere", workspaceId: "wks_other" }),
        agent({ id: "legacy", workspaceId: undefined }),
      ],
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(0);
  });

  test("an archived workspace is out of scope", async () => {
    const harness = createHarness({
      workspaces: [workspace({ archivedAt: "2026-09-20T00:00:00.000Z" })],
      agents: [agent()],
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(0);
  });

  test("config disables the sweep outright", async () => {
    const harness = createHarness({
      workspaces: [workspace()],
      agents: [agent()],
      config: { metadataGeneration: { workspaceTitleTracking: { enabled: false } } },
    });

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(0);
  });

  test("config paces the interval and the activity window", async () => {
    const harness = createHarness({
      workspaces: [workspace()],
      agents: [agent({ lastActivityAt: new Date(NOW - 90 * MINUTE).toISOString() })],
      config: {
        metadataGeneration: {
          workspaceTitleTracking: { refreshIntervalMinutes: 5, activityWindowMinutes: 180 },
        },
      },
    });

    await sweepPastFirstSight(harness, 6 * MINUTE);

    expect(harness.prompts).toHaveLength(1);
  });

  test("an unchanged generated name writes nothing", async () => {
    const harness = createHarness({ workspaces: [workspace()], agents: [agent()] });
    harness.setTitle("i ran into a situation where my agents");

    await sweepPastFirstSight(harness);

    expect(harness.prompts).toHaveLength(1);
    expect(harness.emitted).toEqual([]);
  });

  describe("feature 17: the JEV gate", () => {
    test("JEV saying the title still fits skips the generation call", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      // Two ticks to get past the outer sweep's own first-sight anchor, one more to get past
      // feature 17's own first-look anchor, and a new agent turn plus a moved-on agent title to
      // earn the third look (matching "an agent title moving on earns a second call" above).
      await sweepPastFirstSight(harness);
      harness.recordTurn(agents[0]!.id);
      agents[0] = agent({
        title: "Add workspace title tracking",
        lastActivityAt: new Date(NOW + 62 * MINUTE).toISOString(),
      });
      harness.setNow(NOW + 62 * MINUTE);
      await harness.tracker.tick();

      expect(harness.prompts).toHaveLength(0);
      expect(harness.titleRefreshEvents).toMatchObject([{ action: "jev-fits" }]);
      expect(harness.records.get("wks_checkout")?.title).toBe(
        "i ran into a situation where my agents",
      );
    });

    test("JEV saying the title is stale lets the generation call through", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      await sweepPastFirstSight(harness);
      harness.recordTurn(agents[0]!.id);
      agents[0] = agent({
        title: "Add workspace title tracking",
        lastActivityAt: new Date(NOW + 62 * MINUTE).toISOString(),
      });
      harness.setNow(NOW + 62 * MINUTE);
      await harness.tracker.tick();

      expect(harness.prompts).toHaveLength(1);
      expect(harness.titleRefreshEvents).toMatchObject([{ action: "jev-stale" }]);
    });

    test("the JEV gate's own switch off is exactly today's behaviour", async () => {
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({
        workspaces: [workspace()],
        agents: [agent()],
        jev,
        titleRefreshConfig: { enabled: false },
      });

      await sweepPastFirstSight(harness);

      expect(harness.prompts).toHaveLength(1);
      expect(harness.titleRefreshEvents).toEqual([]);
    });
  });
});
