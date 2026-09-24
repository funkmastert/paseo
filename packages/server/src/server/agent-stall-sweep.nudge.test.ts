import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import pino from "pino";

import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent/agent-sdk-types.js";
import { AgentStallSweep, nudgeStalledAgent } from "./agent-stall-sweep.js";
import type { RemediationObservation } from "./remediation/contract.js";
import { UNAVAILABLE_WORKTREE_SNAPSHOTTER } from "./remediation/contract.js";

const logger = pino({ level: "silent" });
const MINUTE = 60_000;

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * The first turn starts and then says nothing, like a session whose account hit its cap and was
 * re-authed later. Every later turn answers and completes, like the same session once the account
 * is healthy again.
 */
class StuckOnceSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  private turnId: string | null = null;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly config: AgentSessionConfig) {}
  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(prompt: AgentPromptInput) {
    const turnId = `turn-${randomUUID()}`;
    this.turnId = turnId;
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const stuck = this.prompts.length === 1;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: "codex", turnId });
      if (stuck) return;
      this.push({
        type: "timeline",
        provider: "codex",
        turnId,
        item: { type: "assistant_message", text: "Resuming the migration." },
      });
      this.push({ type: "turn_completed", provider: "codex", turnId });
    }, 0);
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

class StuckOnceClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions: StuckOnceSession[] = [];
  async createSession(config: AgentSessionConfig) {
    const session = new StuckOnceSession(config);
    this.sessions.push(session);
    return session;
  }
  async resumeSession() {
    return this.createSession({ provider: "codex", cwd: "/tmp" });
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

describe("a real agent stuck mid-turn", () => {
  test("is nudged once through the production send path and resumes", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "stall-nudge-"));
    const agentStorage = new AgentStorage(join(workdir, "agents"), logger);
    const client = new StuckOnceClient();
    const agentManager = new AgentManager({
      clients: { codex: client },
      registry: agentStorage,
      logger,
      idFactory: () => randomUUID(),
    });
    const agent = await agentManager.createAgent(
      { provider: "codex", cwd: workdir, title: "Stuck mid-migration" },
      undefined,
      { workspaceId: undefined, labels: {} },
    );
    void agentManager.streamAgent(agent.id, "run the migration").next();
    await vi.waitFor(() => expect(agentManager.getAgent(agent.id)?.lifecycle).toBe("running"));

    // The sweep's clock runs an hour ahead, so the real agent's activity reads as long past.
    let nowMs = Date.now() + 60 * MINUTE;
    const observations: RemediationObservation[] = [];
    const sweep = new AgentStallSweep({
      dependencies: {
        listAgents: () => agentManager.listAgentsForStallSweep(),
        // A live daemon always has processes; this agent has none of its own, which is idle.
        sampleProcesses: async () => [
          { pid: 1, ppid: 0, uid: 0, rssKb: 1, cpuPercent: 0, etime: "1:00", command: "init" },
        ],
        getProviderHealth: async () => ({ askable: true }),
        snapshotter: UNAVAILABLE_WORKTREE_SNAPSHOTTER,
        nudgeAgent: (nudge) => nudgeStalledAgent({ agentManager, agentStorage, logger }, nudge),
        handOffToFailover: async () => ({ kind: "failed", error: "not expected" }),
      },
      sink: { observe: async (observation) => void observations.push(observation) },
      readRemediationConfig: () => undefined,
      logger,
      now: () => nowMs,
    });

    for (let sweepIndex = 0; sweepIndex < 3; sweepIndex += 1) {
      await sweep.tick();
      nowMs += 5 * MINUTE;
    }

    const session = client.sessions[0];
    await vi.waitFor(() => expect(agentManager.getAgent(agent.id)?.lifecycle).toBe("idle"));
    expect(session?.prompts).toHaveLength(2);
    expect(session?.prompts[1]).toMatch(/^<paseo-system>\n/);
    expect(session?.prompts[1]).toContain("Resume from where you left off");
    expect(observations.at(-1)).toMatchObject({ active: true, remedy: "live" });

    // It finished the resumed turn, so the next sweep closes the episode and never nudges again.
    await sweep.tick();
    expect(observations.at(-1)).toMatchObject({ active: false });
    expect(session?.prompts).toHaveLength(2);
  });
});
