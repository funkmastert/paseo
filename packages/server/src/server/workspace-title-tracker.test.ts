import { describe, expect, test, vi } from "vitest";

import type {
  AgentManager,
  WorkspaceTitleConversation,
  WorkspaceTitleTrackerAgentSummary,
} from "./agent/agent-manager.js";
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
import { isNearEqualTitle, WorkspaceTitleTracker } from "./workspace-title-tracker.js";

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
  titleRefreshEvents: { action: string; generationCalled: boolean }[];
  setNow(ms: number): void;
  setTitle(title: string): void;
  recordTurn(agentId?: string): void;
}

function createHarness(input: {
  workspaces: PersistedWorkspaceRecord[];
  agents?: WorkspaceTitleTrackerAgentSummary[];
  config?: StructuredGenerationDaemonConfig;
  onUpdate?: (records: Map<string, PersistedWorkspaceRecord>) => void;
  jev?: Pick<JevService, "decide"> | null;
  titleRefreshConfig?: Partial<ResolvedWorkspaceTitleRefreshConfig>;
  conversation?: WorkspaceTitleConversation;
}): Harness {
  const records = new Map(input.workspaces.map((record) => [record.workspaceId, record]));
  const prompts: string[] = [];
  const emitted: string[] = [];
  const titleRefreshEvents: { action: string; generationCalled: boolean }[] = [];
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
      getWorkspaceTitleConversation: async () =>
        input.conversation ?? {
          firstUserMessage: "Why is the daemon at 100% CPU?",
          recentUserMessages: ["Profile the sweep loop"],
          lastAssistantMessage: "The sweep loop allocates on every tick.",
        },
    } as unknown as AgentManager,
    workspaceRegistry: registry,
    readDaemonConfig: () => input.config ?? {},
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      emitted.push(workspaceId);
    },
    jev: input.jev,
    readTitleRefreshConfig: () => ({ ...TITLE_REFRESH_DEFAULTS, ...input.titleRefreshConfig }),
    recordTitleRefreshCheck: (event) => {
      titleRefreshEvents.push(event);
    },
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
    recordTurn: (agentId = "agent-1") => {
      tracker.recordAgentTurnFinished({ agentId, cwd: "" });
    },
    setNow: (ms) => {
      nowMs = ms;
    },
    setTitle: (title) => {
      generatedTitle = title;
    },
  };
}

function actionsOf(harness: Harness): string[] {
  return harness.titleRefreshEvents.map((event) => event.action);
}

function isJevFits(action: string): boolean {
  return action === "jev-fits";
}

/**
 * Drives the tracker like a busy day: every `stepMinutes` the agent finishes `turnsPerStep`
 * turns (so it stays inside the activity window) and the sweep ticks. Returns how many
 * generations ran by the end.
 */
async function simulateActivity(
  harness: Harness,
  agents: WorkspaceTitleTrackerAgentSummary[],
  options: { steps: number; stepMinutes: number; turnsPerStep?: number },
): Promise<void> {
  await harness.tracker.tick();
  for (let step = 1; step <= options.steps; step += 1) {
    const at = NOW + step * options.stepMinutes * MINUTE;
    for (let turn = 0; turn < (options.turnsPerStep ?? 1); turn += 1) harness.recordTurn();
    agents[0] = { ...agents[0]!, lastActivityAt: new Date(at - MINUTE).toISOString() };
    harness.setNow(at);
    await harness.tracker.tick();
  }
}

/** First sight anchors, then turns and a full interval earn the first look. */
async function lookOnce(
  harness: Harness,
  agents: WorkspaceTitleTrackerAgentSummary[],
  turns = 1,
): Promise<void> {
  await simulateActivity(harness, agents, { steps: 1, stepMinutes: 31, turnsPerStep: turns });
}

describe("WorkspaceTitleTracker", () => {
  test("first sight anchors the clocks instead of renaming on sight", async () => {
    const harness = createHarness({ workspaces: [workspace()], agents: [agent()] });
    harness.recordTurn();

    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(0);
    expect(harness.titleRefreshEvents).toEqual([]);
  });

  test("never touches a title a person set", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace({ title: "Bozeo fork", titleSource: "manual" })],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await lookOnce(harness, agents);

    expect(harness.prompts).toHaveLength(0);
    expect(harness.records.get("wks_checkout")?.title).toBe("Bozeo fork");
  });

  test("never touches a title whose provenance predates tracking", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace({ titleSource: undefined })],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await lookOnce(harness, agents);

    expect(harness.prompts).toHaveLength(0);
  });

  test("an agent-supplied title is refreshed like a generated one", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace({ title: "polish-android-a9ds", titleSource: "agent" })],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await lookOnce(harness, agents);

    expect(harness.records.get("wks_checkout")).toMatchObject({
      title: "Multi-account orchestrator fork",
      titleSource: "auto",
    });
    expect(harness.emitted).toEqual(["wks_checkout"]);
  });

  test("a rename that lands mid-generation wins over the generated name", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace()],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
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

    await lookOnce(harness, agents);

    expect(harness.prompts).toHaveLength(1);
    expect(harness.records.get("wks_checkout")?.title).toBe("Named by hand");
    expect(harness.emitted).toEqual([]);
  });

  test("a title that changed mid-generation is not overwritten, even if still auto", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace()],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
      onUpdate: (records) => {
        const current = records.get("wks_checkout");
        if (current) records.set("wks_checkout", { ...current, title: "Named meanwhile" });
      },
    });

    await lookOnce(harness, agents);

    expect(harness.records.get("wks_checkout")?.title).toBe("Named meanwhile");
    expect(harness.emitted).toEqual([]);
  });

  test("without new turns nothing is looked at, however much time passes", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace()],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await simulateActivity(harness, agents, { steps: 20, stepMinutes: 31, turnsPerStep: 0 });

    expect(harness.prompts).toHaveLength(0);
    expect(harness.titleRefreshEvents).toEqual([]);
  });

  test("a dormant workspace is never swept", async () => {
    const harness = createHarness({
      workspaces: [workspace()],
      agents: [agent({ lastActivityAt: new Date(NOW - 6 * 60 * MINUTE).toISOString() })],
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });
    harness.recordTurn();

    await harness.tracker.tick();
    harness.setNow(NOW + 31 * MINUTE);
    await harness.tracker.tick();

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
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await harness.tracker.tick();
    harness.setNow(NOW + 31 * MINUTE);
    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(0);
  });

  test("an archived workspace is out of scope", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace({ archivedAt: "2026-09-20T00:00:00.000Z" })],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await lookOnce(harness, agents);

    expect(harness.prompts).toHaveLength(0);
  });

  test("config disables the sweep outright", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace()],
      agents,
      config: { metadataGeneration: { workspaceTitleTracking: { enabled: false } } },
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await lookOnce(harness, agents);

    expect(harness.prompts).toHaveLength(0);
  });

  test("an unchanged or near-equal generated name writes nothing", async () => {
    for (const generated of [
      "i ran into a situation where my agents",
      "I ran into a situation, where my agents",
      "i ran into the situation where all my agents",
    ]) {
      const agents = [agent()];
      const harness = createHarness({
        workspaces: [workspace()],
        agents,
        titleRefreshConfig: { ceilingUserTurns: 1 },
      });
      harness.setTitle(generated);

      await lookOnce(harness, agents);

      expect(harness.prompts).toHaveLength(1);
      expect(harness.emitted).toEqual([]);
      expect(harness.records.get("wks_checkout")?.title).toBe(
        "i ran into a situation where my agents",
      );
    }
  });

  test("near-equality is about words, not spelling", () => {
    expect(isNearEqualTitle("FormVue upload files to web", "FormVue upload files on web")).toBe(
      true,
    );
    expect(isNearEqualTitle("Terminal latency pipeline", "terminal latency pipeline.")).toBe(true);
    expect(isNearEqualTitle("Terminal latency pipeline", "Workspace title tracking")).toBe(false);
    expect(isNearEqualTitle("Fix PR #12", "Fix PR #13")).toBe(false);
  });

  test("a cleared title is named at the next tick, not the next interval", async () => {
    const harness = createHarness({
      workspaces: [workspace({ title: null, titleSource: "auto" })],
      agents: [agent()],
    });

    await harness.tracker.tick();

    expect(harness.prompts).toHaveLength(1);
    expect(harness.records.get("wks_checkout")).toMatchObject({
      title: "Multi-account orchestrator fork",
      titleSource: "auto",
    });
    expect(harness.titleRefreshEvents).toMatchObject([
      { action: "untitled", generationCalled: true },
    ]);

    // One immediate attempt only; a failed or empty one waits for the normal gate.
    await harness.tracker.tick();
    expect(harness.prompts).toHaveLength(1);
  });

  test("the generation prompt carries what the sessions were asked recently", async () => {
    const agents = [agent()];
    const harness = createHarness({
      workspaces: [workspace()],
      agents,
      titleRefreshConfig: { ceilingUserTurns: 1 },
    });

    await lookOnce(harness, agents);

    expect(harness.prompts[0]).toContain("asked: Profile the sweep loop");
    expect(harness.prompts[0]).toContain("Debug Paseo daemon CPU spike");
  });

  describe("without JEV: the cadence", () => {
    test("renames once enough turns and time have passed", async () => {
      const agents = [agent()];
      const harness = createHarness({ workspaces: [workspace()], agents, jev: null });

      // 31-minute looks, one turn each: the third turn arrives at 93 minutes, past both bars.
      await simulateActivity(harness, agents, { steps: 2, stepMinutes: 31 });
      expect(harness.prompts).toHaveLength(0);
      expect(actionsOf(harness)).toEqual(["cadence-not-ready", "cadence-not-ready"]);

      harness.recordTurn();
      harness.setNow(NOW + 93 * MINUTE);
      agents[0] = { ...agents[0]!, lastActivityAt: new Date(NOW + 92 * MINUTE).toISOString() };
      await harness.tracker.tick();

      expect(harness.prompts).toHaveLength(1);
      expect(harness.records.get("wks_checkout")?.title).toBe("Multi-account orchestrator fork");
    });

    test("keeps renaming as the work moves on over a long day", async () => {
      const agents = [agent()];
      const harness = createHarness({ workspaces: [workspace()], agents, jev: null });
      const titles = ["Profile the sweep loop", "Ship the CPU fix", "Release notes"];
      let index = 0;
      await harness.tracker.tick();
      for (let step = 1; step <= 12; step += 1) {
        harness.setTitle(titles[index % titles.length]!);
        harness.recordTurn();
        const at = NOW + step * 31 * MINUTE;
        agents[0] = { ...agents[0]!, lastActivityAt: new Date(at - MINUTE).toISOString() };
        harness.setNow(at);
        const before = harness.prompts.length;
        await harness.tracker.tick();
        if (harness.prompts.length > before) index += 1;
      }
      // Six hours of steady work on the cadence (3 turns, 60 minutes): several renames.
      expect(harness.prompts.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("feature 17: the JEV gate", () => {
    test("JEV saying the title still fits skips the generation call", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      await lookOnce(harness, agents);

      expect(harness.prompts).toHaveLength(0);
      expect(harness.titleRefreshEvents).toMatchObject([
        { action: "jev-fits", generationCalled: false },
      ]);
    });

    test("JEV saying the title is stale renames on the first look", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 3 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      await lookOnce(harness, agents);

      expect(harness.prompts).toHaveLength(1);
      expect(harness.titleRefreshEvents).toMatchObject([{ action: "jev-stale" }]);
      expect(harness.records.get("wks_checkout")?.title).toBe("Multi-account orchestrator fork");
    });

    test("JEV is not re-asked until a new turn", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      await lookOnce(harness, agents);
      harness.setNow(NOW + 62 * MINUTE);
      await harness.tracker.tick();

      expect(jev.transport.calls).toHaveLength(1);
    });

    test("hours of 'still fits' with a stable workspace still rename at the turn ceiling", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      // Same agent, same agent title, one turn per 31-minute look: nothing but turns changes.
      await simulateActivity(harness, agents, {
        steps: TITLE_REFRESH_DEFAULTS.ceilingUserTurns - 1,
        stepMinutes: 31,
      });
      expect(harness.prompts).toHaveLength(0);

      harness.recordTurn();
      harness.setNow(NOW + TITLE_REFRESH_DEFAULTS.ceilingUserTurns * 31 * MINUTE);
      await harness.tracker.tick();

      expect(harness.prompts).toHaveLength(1);
      expect(harness.titleRefreshEvents.at(-1)).toMatchObject({
        action: "ceiling",
        generationCalled: true,
      });
      expect(actionsOf(harness).filter(isJevFits)).toHaveLength(
        TITLE_REFRESH_DEFAULTS.ceilingUserTurns - 1,
      );
      expect(harness.records.get("wks_checkout")?.title).toBe("Multi-account orchestrator fork");
    });

    test("hours of 'still fits' rename at the hour ceiling when turns are sparse", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({
        workspaces: [workspace()],
        agents,
        jev,
        titleRefreshConfig: { ceilingUserTurns: 1000 },
      });

      // One turn an hour for seven hours.
      await simulateActivity(harness, agents, { steps: 7, stepMinutes: 60 });

      expect(harness.prompts).toHaveLength(1);
      expect(actionsOf(harness)).toEqual([
        "jev-fits",
        "jev-fits",
        "jev-fits",
        "jev-fits",
        "jev-fits",
        "ceiling",
        "jev-fits",
      ]);
    });

    test("JEV down renames on the cadence", async () => {
      const agents = [agent()];
      const jev = createJevForTest({
        behavior: { kind: "network" },
        answers: { fit: { type: "score", score: 0 } },
      });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      await simulateActivity(harness, agents, { steps: 3, stepMinutes: 31 });

      expect(actionsOf(harness)).toEqual(["cadence-not-ready", "cadence-not-ready", "cadence"]);
      expect(harness.prompts).toHaveLength(1);
      expect(harness.records.get("wks_checkout")?.title).toBe("Multi-account orchestrator fork");
    });

    test("the JEV gate's own switch off falls to the cadence and asks nothing", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({
        workspaces: [workspace()],
        agents,
        jev,
        titleRefreshConfig: { enabled: false },
      });

      await simulateActivity(harness, agents, { steps: 3, stepMinutes: 31 });

      expect(jev.transport.calls).toHaveLength(0);
      expect(harness.prompts).toHaveLength(1);
    });

    test("JEV sees the conversation, not the agent titles the name came from", async () => {
      const agents = [agent()];
      const jev = createJevForTest({ answers: { fit: { type: "score", score: 0 } } });
      const harness = createHarness({ workspaces: [workspace()], agents, jev });

      await lookOnce(harness, agents);

      const sent = JSON.stringify(jev.transport.calls[0]);
      expect(sent).toContain("Profile the sweep loop");
      expect(sent).toContain("The sweep loop allocates on every tick.");
      expect(sent).not.toContain("Debug Paseo daemon CPU spike");
    });
  });
});
