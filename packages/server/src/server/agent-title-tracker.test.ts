import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import type { StructuredAgentGenerationWithFallbackOptions } from "./agent/agent-response-loop.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import { AgentTitleTracker } from "./agent-title-tracker.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createStructuredGenerator(result: { title: string } | { error: Error }) {
  const calls: StructuredAgentGenerationWithFallbackOptions<unknown>[] = [];

  async function generateStructured<T>(
    options: StructuredAgentGenerationWithFallbackOptions<T>,
  ): Promise<T> {
    calls.push(options as StructuredAgentGenerationWithFallbackOptions<unknown>);
    if ("error" in result) {
      throw result.error;
    }
    return result as T;
  }

  return { generateStructured, calls };
}

function createFakeAgentManager(input: {
  liveAgentIds?: Set<string>;
  timeline?: AgentTimelineItem[];
  applyGeneratedTitle?: ReturnType<typeof vi.fn>;
}) {
  const liveAgentIds = input.liveAgentIds ?? new Set(["agent-1"]);
  const timeline = input.timeline ?? [{ type: "user_message" as const, text: "Fix the bug" }];
  return {
    getAgent: vi.fn((id: string) => (liveAgentIds.has(id) ? ({ id } as never) : null)),
    getTimeline: vi.fn(() => timeline),
    applyGeneratedTitle: input.applyGeneratedTitle ?? vi.fn(async () => true),
  } as unknown as AgentManager;
}

function createFakeAgentStorage(record: Partial<StoredAgentRecord> | null) {
  return {
    get: vi.fn(async () => record as StoredAgentRecord | null),
  } as Pick<AgentStorage, "get">;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentTitleTracker", () => {
  test("skips generation when title tracking is disabled by config", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({});
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({ metadataGeneration: { titleTracking: { enabled: false } } }),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    expect(structured.calls).toHaveLength(0);
  });

  test("skips generation when the title was manually set", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({});
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title", titleManuallySet: true }),
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    expect(structured.calls).toHaveLength(0);
  });

  test("skips generation when the agent is archived", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({});
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({
        title: "Old title",
        archivedAt: "2026-01-01T00:00:00Z",
      }),
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    expect(structured.calls).toHaveLength(0);
  });

  test("skips generation when there is no live agent", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({ liveAgentIds: new Set() });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    expect(structured.calls).toHaveLength(0);
  });

  test("skips generation when the latest user message is unchanged since the last generation", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({
      timeline: [{ type: "user_message", text: "Same instruction" }],
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(1);

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    // No new user message since the first generation — zero additional calls.
    expect(structured.calls).toHaveLength(1);
  });

  test("debounce collapses two rapid schedules into a single generator call", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({});
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 20,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(structured.calls).toHaveLength(1);
  });

  test("applies the generated title via applyGeneratedTitle on success", async () => {
    const structured = createStructuredGenerator({ title: "Fix the login bug" });
    const applyGeneratedTitle = vi.fn(async () => true);
    const agentManager = createFakeAgentManager({ applyGeneratedTitle });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    expect(applyGeneratedTitle).toHaveBeenCalledWith("agent-1", "Fix the login bug");
  });

  test("swallows and logs a structured generation failure without applying a title", async () => {
    const structured = createStructuredGenerator({ error: new Error("boom") });
    const applyGeneratedTitle = vi.fn(async () => true);
    const agentManager = createFakeAgentManager({ applyGeneratedTitle });
    const logger = createLogger();
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({}),
      logger,
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();

    expect(applyGeneratedTitle).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

async function flushDebounce(): Promise<void> {
  // Debounce timers in these tests use debounceMs: 0 — a couple of
  // macrotask/microtask turns is enough for the scheduled refresh to run.
  await new Promise((resolve) => setTimeout(resolve, 10));
}
