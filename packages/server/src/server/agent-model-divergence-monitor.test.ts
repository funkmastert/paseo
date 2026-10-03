import { describe, expect, test, vi } from "vitest";
import type { ModelDivergenceAlert } from "@getpaseo/protocol/agent-types";
import type { AgentManager, ModelDivergenceMonitorAgentSummary } from "./agent/agent-manager.js";
import type { ModelDivergence } from "./agent/model-divergence.js";
import {
  AgentModelDivergenceMonitor,
  type ModelDivergenceMonitorSettings,
} from "./agent-model-divergence-monitor.js";
import type { PushPayload } from "./push/push-service.js";

const T0 = Date.parse("2026-09-23T12:00:00Z");

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Holds live divergence per agent and records what the monitor puts on the wire. */
function createFakeAgentManager() {
  const divergences = new Map<string, ModelDivergence | undefined>();
  const shown = new Map<string, ModelDivergenceAlert>();
  const internal = new Set<string>();
  const manager = {
    listAgentsForModelDivergenceMonitor: vi.fn((): ModelDivergenceMonitorAgentSummary[] =>
      [...divergences.keys()].map((id) => ({
        id,
        workspaceId: "ws-1",
        internal: internal.has(id),
        title: `Agent ${id}`,
        divergence: divergences.get(id),
        shownAlert: shown.get(id),
      })),
    ),
    setModelDivergenceAlert: vi.fn((id: string, alert: ModelDivergenceAlert) => {
      shown.set(id, alert);
    }),
    clearModelDivergenceAlert: vi.fn((id: string) => {
      shown.delete(id);
    }),
  } as unknown as AgentManager;
  return {
    manager,
    shown,
    set: (id: string, value: ModelDivergence | undefined) => divergences.set(id, value),
    remove: (id: string) => {
      divergences.delete(id);
      shown.delete(id);
    },
    markInternal: (id: string) => internal.add(id),
  };
}

function divergence(overrides: Partial<ModelDivergence> = {}): ModelDivergence {
  return {
    configuredModel: "claude-sonnet-5",
    observedModel: "claude-opus-5",
    firstObservedAt: T0,
    lastObservedAt: T0,
    responses: 1,
    ...overrides,
  };
}

function setup() {
  const fake = createFakeAgentManager();
  const logger = createLogger();
  const sent: PushPayload[] = [];
  const state: { settings: ModelDivergenceMonitorSettings | undefined } = {
    settings: { enabled: true },
  };
  const monitor = new AgentModelDivergenceMonitor({
    agentManager: fake.manager,
    pushNotificationSender: {
      send: vi.fn(async (payload: PushPayload) => void sent.push(payload)),
    },
    serverId: "server-1",
    readSettings: () => state.settings,
    logger,
  });
  return { fake, logger, sent, monitor, state };
}

const PERSISTED = { responses: 5, lastObservedAt: T0 + 5 * 60_000 };

describe("AgentModelDivergenceMonitor", () => {
  test("is off unless enabled: no badge, no log line, no push", async () => {
    const { fake, logger, sent, monitor, state } = setup();
    state.settings = undefined;
    fake.set("a1", divergence(PERSISTED));

    await monitor.tick();

    expect(fake.shown.size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("a first finding shows a badge and one log line, and does not push yet", async () => {
    const { fake, logger, sent, monitor } = setup();
    fake.set("a1", divergence());

    await monitor.tick();

    expect(fake.shown.get("a1")).toMatchObject({
      configuredModel: "claude-sonnet-5",
      observedModel: "claude-opus-5",
      persisted: false,
      responses: 1,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        configuredModel: "claude-sonnet-5",
        observedModel: "claude-opus-5",
      }),
      expect.stringContaining("Model divergence"),
    );
    expect(sent).toEqual([]);
  });

  test("a finding that persists pushes exactly once, and sweeps after it stay quiet", async () => {
    const { fake, logger, sent, monitor } = setup();
    fake.set("a1", divergence());
    await monitor.tick();

    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();
    await monitor.tick();
    fake.set("a1", divergence({ ...PERSISTED, responses: 40 }));
    await monitor.tick();

    expect(fake.shown.get("a1")?.persisted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: "Agent is running a different model",
      data: {
        serverId: "server-1",
        workspaceId: "ws-1",
        agentId: "a1",
        reason: "model_divergence",
      },
    });
    expect(sent[0]?.body).toContain("claude-sonnet-5");
    expect(sent[0]?.body).toContain("claude-opus-5");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("a mismatch that recovers and returns shows again without a second log line or push", async () => {
    const { fake, logger, sent, monitor } = setup();
    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();
    expect(sent).toHaveLength(1);

    fake.set("a1", undefined);
    await monitor.tick();
    expect(fake.shown.has("a1")).toBe(false);

    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();

    expect(fake.shown.has("a1")).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  test("a different mismatch on the same agent is a new finding", async () => {
    const { fake, logger, sent, monitor } = setup();
    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();

    fake.set("a1", divergence({ ...PERSISTED, observedModel: "claude-haiku-4-5" }));
    await monitor.tick();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });

  test("two agents are announced independently", async () => {
    const { fake, sent, monitor } = setup();
    fake.set("a1", divergence(PERSISTED));
    fake.set("a2", divergence(PERSISTED));

    await monitor.tick();

    expect(sent.map((payload) => payload.data.agentId).sort()).toEqual(["a1", "a2"]);
  });

  test("an internal agent is never surfaced", async () => {
    const { fake, logger, sent, monitor } = setup();
    fake.set("hidden", divergence(PERSISTED));
    fake.markInternal("hidden");

    await monitor.tick();

    expect(fake.shown.size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("the thresholds are configurable", async () => {
    const { fake, sent, monitor, state } = setup();
    state.settings = { enabled: true, persistResponses: 2, persistSeconds: 0 };
    fake.set("a1", divergence({ responses: 2 }));

    await monitor.tick();

    expect(sent).toHaveLength(1);
  });

  test("turning it off takes the badge away, and turning it back on reports the finding again", async () => {
    const { fake, logger, sent, monitor, state } = setup();
    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();
    expect(fake.shown.has("a1")).toBe(true);

    state.settings = { enabled: false };
    await monitor.tick();
    expect(fake.shown.has("a1")).toBe(false);

    state.settings = { enabled: true };
    await monitor.tick();
    expect(fake.shown.has("a1")).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });

  test("forgets an agent that is gone, so its id reused later is announced afresh", async () => {
    const { fake, sent, monitor } = setup();
    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();
    fake.remove("a1");
    await monitor.tick();

    fake.set("a1", divergence(PERSISTED));
    await monitor.tick();

    expect(sent).toHaveLength(2);
  });

  test("a failed push does not break the sweep and is not retried every sweep", async () => {
    const fake = createFakeAgentManager();
    const logger = createLogger();
    const send = vi.fn(async () => {
      throw new Error("push provider down");
    });
    const monitor = new AgentModelDivergenceMonitor({
      agentManager: fake.manager,
      pushNotificationSender: { send },
      serverId: "server-1",
      readSettings: () => ({ enabled: true }),
      logger,
    });
    fake.set("a1", divergence(PERSISTED));

    await monitor.tick();
    await monitor.tick();

    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to send model-divergence push notification",
    );
    expect(fake.shown.get("a1")?.persisted).toBe(true);
  });
});
