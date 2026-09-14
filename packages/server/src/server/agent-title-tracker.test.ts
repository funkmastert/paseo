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
  lastActivitySummary?: string;
  listAgents?: ReturnType<typeof vi.fn>;
}) {
  const liveAgentIds = input.liveAgentIds ?? new Set(["agent-1"]);
  const timeline = input.timeline ?? [{ type: "user_message" as const, text: "Fix the bug" }];
  return {
    getAgent: vi.fn((id: string) =>
      liveAgentIds.has(id)
        ? ({ id, lastActivitySummary: input.lastActivitySummary } as never)
        : null,
    ),
    getTimeline: vi.fn(() => timeline),
    applyGeneratedTitle: input.applyGeneratedTitle ?? vi.fn(async () => true),
    listAgents: input.listAgents ?? vi.fn(() => []),
  } as unknown as AgentManager;
}

function managedAgentSummary(overrides: {
  id?: string;
  cwd?: string;
  lifecycle?: "initializing" | "idle" | "running" | "error" | "closed";
  internal?: boolean;
}) {
  return {
    id: "agent-1",
    cwd: "/tmp/repo",
    lifecycle: "idle" as const,
    internal: false,
    ...overrides,
  };
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

  test("evicts the dedup entry once the agent is archived, so a later un-archival re-triggers generation for the same message", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({});
    let record: Partial<StoredAgentRecord> | null = { title: "Old title" };
    const agentStorage = {
      get: vi.fn(async () => record as StoredAgentRecord | null),
    } as Pick<AgentStorage, "get">;
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage,
      readDaemonConfig: () => ({}),
      logger: createLogger(),
      debounceMs: 0,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(1);

    // Agent gets archived — refresh() bails out on the archived check. The
    // dedup entry for it should be evicted here, not left behind forever.
    record = { title: "Old title", archivedAt: "2026-01-01T00:00:00Z" };
    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(1);

    // Agent is un-archived with the exact same latest user message. If the
    // entry was evicted, this is indistinguishable from a fresh agent and
    // generation runs again; if it leaked, the stale fingerprint still
    // matches and generation stays skipped.
    record = { title: "Old title" };
    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(2);
  });

  test("evicts the dedup entry once the agent disappears from the live registry", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    const liveAgentIds = new Set(["agent-1"]);
    const agentManager = createFakeAgentManager({ liveAgentIds });
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

    // Agent goes away — scheduleRefresh() should notice and drop the dedup
    // entry rather than leave it keyed to a dead agent id forever.
    liveAgentIds.delete("agent-1");
    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(1);

    // Same agent id becomes live again (e.g. id reuse is impossible in
    // practice, but this isolates the eviction from every other guard) with
    // the exact same latest user message as before.
    liveAgentIds.add("agent-1");
    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(2);
  });

  test("bounds the stored per-agent dedup fingerprint regardless of message length", async () => {
    const hugeMessage = "x".repeat(10_000);
    const structured = createStructuredGenerator({ title: "New title" });
    const agentManager = createFakeAgentManager({
      timeline: [{ type: "user_message", text: hugeMessage }],
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

    const stored = (
      tracker as unknown as { lastGeneratedFromByAgentId: Map<string, string> }
    ).lastGeneratedFromByAgentId.get("agent-1");
    expect(stored).toBeDefined();
    expect(stored!.length).toBeLessThanOrEqual(500);
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

  test("refreshes only after the interval elapses, and not again while activity is unchanged", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const timeline: AgentTimelineItem[] = [{ type: "user_message", text: "Fix the bug" }];
    const agentManager = createFakeAgentManager({
      timeline,
      listAgents: vi.fn(() => [managedAgentSummary({})]),
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    // First tick just anchors the interval for a newly-seen agent.
    await tracker.tick();
    expect(structured.calls).toHaveLength(0);

    // 5 minutes later — interval hasn't elapsed yet.
    nowMs += 5 * 60_000;
    await tracker.tick();
    expect(structured.calls).toHaveLength(0);

    // 10 minutes after the anchor — interval elapsed, and this is the
    // first-ever generation for this agent, so it counts as "changed".
    nowMs += 5 * 60_000;
    await tracker.tick();
    expect(structured.calls).toHaveLength(1);

    // Another 10 minutes pass, but nothing about the agent's activity
    // changed — no second LLM call.
    nowMs += 10 * 60_000;
    await tracker.tick();
    expect(structured.calls).toHaveLength(1);

    // Activity changes and the interval has elapsed again — refreshes.
    timeline.push({ type: "user_message", text: "Now fix the other bug" });
    nowMs += 10 * 60_000;
    await tracker.tick();
    expect(structured.calls).toHaveLength(2);
  });

  test("never calls the LLM when nothing about the agent's activity has changed", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const agentManager = createFakeAgentManager({
      listAgents: vi.fn(() => [managedAgentSummary({})]),
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    await tracker.tick();
    nowMs += 10 * 60_000;
    await tracker.tick();
    expect(structured.calls).toHaveLength(1);

    for (let i = 0; i < 5; i += 1) {
      nowMs += 10 * 60_000;
      await tracker.tick();
    }
    expect(structured.calls).toHaveLength(1);
  });

  test("leaves a manually-set title untouched even once the interval elapses", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const agentManager = createFakeAgentManager({
      listAgents: vi.fn(() => [managedAgentSummary({})]),
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title", titleManuallySet: true }),
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    await tracker.tick();
    nowMs += 10 * 60_000;
    await tracker.tick();

    expect(structured.calls).toHaveLength(0);
  });

  test("skips internal agents and archived agents", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const agentManager = createFakeAgentManager({
      listAgents: vi.fn(() => [
        managedAgentSummary({ id: "internal-1", internal: true }),
        managedAgentSummary({ id: "archived-1" }),
      ]),
    });
    const records: Record<string, Partial<StoredAgentRecord> | null> = {
      "internal-1": { title: "Internal" },
      "archived-1": { title: "Archived", archivedAt: "2026-01-01T00:00:00Z" },
    };
    const agentStorage = {
      get: vi.fn(async (id: string) => records[id] as StoredAgentRecord | null),
    } as Pick<AgentStorage, "get">;
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage,
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    await tracker.tick();
    nowMs += 10 * 60_000;
    await tracker.tick();

    expect(structured.calls).toHaveLength(0);
  });

  test("skips agents that are neither running nor idle", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const agentManager = createFakeAgentManager({
      listAgents: vi.fn(() => [managedAgentSummary({ lifecycle: "initializing" })]),
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    await tracker.tick();
    nowMs += 10 * 60_000;
    await tracker.tick();

    expect(structured.calls).toHaveLength(0);
  });

  test("includes a recent-activity digest built from the timeline tail and lastActivitySummary in the prompt", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Fix the bug" },
      {
        type: "tool_call",
        callId: "call-1",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { path: "a.ts" } },
      } as unknown as AgentTimelineItem,
    ];
    const agentManager = createFakeAgentManager({
      timeline,
      lastActivitySummary: "[Read] a.ts",
      listAgents: vi.fn(() => [managedAgentSummary({})]),
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    await tracker.tick();
    nowMs += 10 * 60_000;
    await tracker.tick();

    expect(structured.calls).toHaveLength(1);
    const prompt = structured.calls[0]?.prompt as string;
    expect(prompt).toContain("<recent-activity>");
    expect(prompt).toContain("[Read] a.ts");
    expect(prompt).toContain("<current-title>");
    expect(prompt).toContain("<newest-user-instruction>");
  });

  test("the turn-finished debounce path and the periodic sweep share one fingerprint dedup", async () => {
    const structured = createStructuredGenerator({ title: "New title" });
    let nowMs = 0;
    const timeline: AgentTimelineItem[] = [{ type: "user_message", text: "Fix the bug" }];
    const agentManager = createFakeAgentManager({
      timeline,
      listAgents: vi.fn(() => [managedAgentSummary({})]),
    });
    const tracker = new AgentTitleTracker({
      agentManager,
      agentStorage: createFakeAgentStorage({ title: "Old title" }),
      readDaemonConfig: () => ({
        metadataGeneration: { titleTracking: { refreshIntervalMinutes: 10 } },
      }),
      logger: createLogger(),
      debounceMs: 0,
      now: () => nowMs,
      deps: { generateStructuredAgentResponseWithFallback: structured.generateStructured },
    });

    // The turn-finished path generates first.
    tracker.scheduleRefresh({ agentId: "agent-1", cwd: "/tmp/repo" });
    await flushDebounce();
    expect(structured.calls).toHaveLength(1);

    // The sweep sees the same unchanged agent shortly after — no new call,
    // and its own interval anchor comes from the turn-finished refresh.
    await tracker.tick();
    nowMs += 10 * 60_000;
    await tracker.tick();
    expect(structured.calls).toHaveLength(1);
  });
});

async function flushDebounce(): Promise<void> {
  // Debounce timers in these tests use debounceMs: 0 — a couple of
  // macrotask/microtask turns is enough for the scheduled refresh to run.
  await new Promise((resolve) => setTimeout(resolve, 10));
}
