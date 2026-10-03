import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import pino from "pino";

import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  DEFAULT_REACTIVE_SIGNAL_TTL_MS,
  isLimitShapedError,
  planAccountFailoverSweep,
} from "./account-failover-detector.js";
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
 * A turn that starts and then produces nothing: what a session looks like while its account sits
 * at the weekly cap and the CLI waits. An interrupt settles it the ordinary way, with a plain
 * `interrupted` cancel, which on its own clears `lastError` and leaves failover nothing to read.
 */
class SilentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private turnId: string | null = null;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly config: AgentSessionConfig) {}
  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn() {
    const turnId = `turn-${randomUUID()}`;
    this.turnId = turnId;
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
  async interrupt() {
    const turnId = this.turnId ?? undefined;
    setTimeout(
      () => this.push({ type: "turn_canceled", provider: "codex", reason: "interrupted", turnId }),
      0,
    );
  }
  async close() {}
}

class SilentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  async createSession(config: AgentSessionConfig) {
    return new SilentSession(config);
  }
  async resumeSession() {
    return new SilentSession({ provider: "codex", cwd: "/tmp" });
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

async function startAStalledTurn() {
  const workdir = mkdtempSync(join(tmpdir(), "account-capped-cancel-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new SilentClient() },
    registry: storage,
    logger,
    idFactory: () => randomUUID(),
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Stalled on a capped account" },
    undefined,
    { workspaceId: undefined, labels: {} },
  );
  void manager.streamAgent(agent.id, "do the work").next();
  await vi.waitFor(() => expect(manager.getAgent(agent.id)?.lifecycle).toBe("running"));
  return { manager, agentId: agent.id };
}

describe("an account-capped cancel hands a stalled turn to account failover", () => {
  test("a plain cancel of the same turn leaves failover nothing to read", async () => {
    const { manager, agentId } = await startAStalledTurn();
    await manager.cancelAgentRun(agentId, "user");
    expect(manager.getAccountFailoverSummary(agentId)?.lastError).toBeUndefined();
  });

  test("leaves a limit-shaped lastError naming the account, dated now, and failover selects it", async () => {
    const { manager, agentId } = await startAStalledTurn();
    const cancelledAtMs = Date.now();

    const result = await manager.cancelAgentRun(agentId, "account-capped");

    expect(result.status).toBe("settled");
    const summary = manager.getAccountFailoverSummary(agentId);
    expect(summary?.lifecycle).toBe("idle");
    expect(summary?.lastError).toContain("codex");
    expect(isLimitShapedError(summary?.lastError)).toBe(true);
    // The failure is dated by the newest timeline row. Without a row of its own, a turn stuck
    // for 20 hours would date its failure 20 hours back, past the reactive TTL.
    expect(Date.parse(summary?.lastTimelineAt ?? "")).toBeGreaterThanOrEqual(cancelledAtMs);
    // A cancel is not a finish.
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(false);

    const plan = planAccountFailoverSweep({
      poolProviderIds: new Set(["codex"]),
      agents: summary ? [summary] : [],
      // No usage reading at all: the lastError alone has to carry the handoff.
      usage: null,
      previousSightings: new Map(),
      previousProviderSightings: new Map(),
      nowMs: Date.now(),
      reactiveSignalTtlMs: DEFAULT_REACTIVE_SIGNAL_TTL_MS,
      migrateSubagents: true,
    });
    expect([...plan.deadProviderIds]).toEqual(["codex"]);
    expect(plan.candidates.map((candidate) => candidate.id)).toEqual([agentId]);
  });
});
