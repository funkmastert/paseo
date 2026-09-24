import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import pino from "pino";

import { AgentManager } from "./agent-manager.js";
import { UNRESPONSIVE_CANCEL_ERROR } from "./turn-cancel.js";
import { AgentStorage } from "./agent-storage.js";
import { planAccountFailoverSweep } from "./account-failover-detector.js";
import { publishAgentStream } from "../plugins/lifecycle/index.js";
import type { PluginLifecycle } from "../plugins/lifecycle/index.js";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const logger = pino({ level: "silent" });

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * A session that opens a turn and then stops answering: `interrupt()` resolves, but no terminal
 * event ever arrives. That is what an account whose CLI has died looks like from the daemon, and
 * it is the path `cancelAgentRun` force-cancels after its timeout.
 */
class UnresponsiveSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly config: AgentSessionConfig) {}
  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn() {
    const turnId = `turn-${randomUUID()}`;
    setTimeout(() => this.push({ type: "turn_started", provider: "codex", turnId }), 0);
    return { turnId };
  }
  subscribe(cb: (event: AgentStreamEvent) => void) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
  private push(event: AgentStreamEvent) {
    for (const cb of this.subscribers) cb(event);
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: "codex" as const, sessionId: this.id, model: this.config.model ?? null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode() {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission() {}
  describePersistence() {
    return { provider: "codex" as const, sessionId: this.id };
  }
  // Acknowledges the interrupt and then never settles the turn — the force-cancel path.
  async interrupt() {}
  async close() {}
}

class UnresponsiveClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  async createSession(config: AgentSessionConfig) {
    return new UnresponsiveSession(config);
  }
  async resumeSession() {
    return new UnresponsiveSession({ provider: "codex", cwd: "/tmp" });
  }
  async fetchCatalog() {
    return {
      models: [{ provider: "codex" as const, id: "m", label: "m", isDefault: true }],
      modes: [],
    };
  }
  async isAvailable() {
    return true;
  }
}

async function cancelAnUnresponsiveTurn() {
  const workdir = mkdtempSync(join(tmpdir(), "unresponsive-cancel-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new UnresponsiveClient() },
    registry: storage,
    logger,
    // Short enough that the force-cancel path runs inside the test.
    rescueTimeouts: { interruptSessionMs: 40 },
    idFactory: () => randomUUID(),
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Stuck on a dead account" },
    undefined,
    { workspaceId: undefined, labels: {} },
  );
  void manager.streamAgent(agent.id, "do the work").next();
  await vi.waitFor(() => expect(manager.getAgent(agent.id)?.lifecycle).toBe("running"));
  await manager.cancelAgentRun(agent.id, "user");
  return { manager, storage, agentId: agent.id };
}

describe("an unresponsive session's cancel reaches the layers that route around dead accounts", () => {
  test("the failover detector sees a failure instead of a clean finish", async () => {
    const { manager, agentId } = await cancelAnUnresponsiveTurn();

    const summary = manager.getAccountFailoverSummary(agentId);
    expect(summary?.lastError).toBe(UNRESPONSIVE_CANCEL_ERROR);
    // Lifecycle is deliberately untouched — this is not reclassified as an error state.
    expect(manager.getAgent(agentId)?.lifecycle).toBe("idle");
    // And it is still not a "finish".
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(false);
  });

  test("a limit-shaped provider reason on a capped account makes it a migration candidate", () => {
    // The detector's own contract, driven with the summary shape the manager now produces for
    // an agent whose account died: a limit-shaped lastError on a pool provider is what makes it
    // a candidate. Proves the string reaches the decision, not just the field.
    const summary: AccountFailoverAgentSummary = {
      id: "stuck-1",
      provider: "claude-personal",
      cwd: "/tmp/work",
      workspaceId: "ws-1",
      internal: false,
      lifecycle: "idle",
      lastError: "Not logged in · Please run /login · your session limit resets 3:10pm",
      title: "Stuck",
      busy: false,
      pendingPermissionCount: 0,
      lastActivityAt: null,
      timelineSeq: 7,
      lastTimelineAt: null,
      labels: {},
      sessionId: "session-1",
      model: "claude-opus-5",
      modeId: "bypassPermissions",
      thinkingOptionId: "max",
    };

    const plan = planAccountFailoverSweep({
      poolProviderIds: new Set(["claude", "claude-personal", "claude-backup"]),
      agents: [summary],
      usage: [],
      previousSightings: new Map(),
      previousProviderSightings: new Map(),
      nowMs: 1_000_000,
      reactiveSignalTtlMs: 60 * 60 * 1000,
      migrateSubagents: true,
    });

    expect([...plan.deadProviderIds]).toEqual(["claude-personal"]);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(["stuck-1"]);
  });

  test("the plugin turn outcome is `failed`, which is the only branch the pool classifier reads", () => {
    // index.server.ts calls health.reportTurnFailure only for outcome.kind === "failed"; a
    // `canceled` outcome reaches nothing, which is how a dead account kept taking work.
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const lifecycle = {
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    } as unknown as PluginLifecycle;
    const agent = {
      id: "a1",
      workspaceId: null,
      parentAgentId: null,
      provider: "claude-personal",
      cwd: "/tmp",
      title: null,
      labels: {},
    };

    publishAgentStream(
      lifecycle,
      agent,
      { type: "turn_canceled", provider: "codex", reason: "unresponsive", turnId: "t1" },
      [],
    );
    publishAgentStream(
      lifecycle,
      agent,
      { type: "turn_canceled", provider: "codex", reason: "interrupted", turnId: "t2" },
      [],
    );

    expect(emitted.map((entry) => entry.payload)).toEqual([
      expect.objectContaining({
        outcome: { kind: "failed", error: { message: UNRESPONSIVE_CANCEL_ERROR } },
      }),
      // A person pressing stop is still a cancel, and must not cap their account.
      expect.objectContaining({ outcome: { kind: "canceled", reason: "interrupted" } }),
    ]);
  });
});
