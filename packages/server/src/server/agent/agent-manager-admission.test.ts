import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { startAgentRun } from "./agent-prompt.js";
import { toAgentPayload } from "./agent-projections.js";
import { ChildAdmissionController, type ChildAdmissionConfig } from "./child-admission.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * A session whose turns stay open until the test ends them, so a child keeps its slot for as
 * long as the test says. Records every prompt a turn was started with.
 */
class HeldTurnSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly startedPrompts: AgentPromptInput[] = [];
  private openTurnId: string | null = null;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(
    readonly config: AgentSessionConfig,
    private readonly onOutOfBand?: () => void,
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startedPrompts.push(prompt);
    const turnId = `turn-${randomUUID()}`;
    this.openTurnId = turnId;
    setTimeout(() => this.push({ type: "turn_started", provider: "codex", turnId }), 0);
    return { turnId };
  }

  finishTurn(): void {
    const turnId = this.openTurnId;
    if (!turnId) throw new Error("no open turn");
    this.openTurnId = null;
    this.push({ type: "turn_completed", provider: "codex", turnId });
  }

  tryHandleOutOfBand(prompt: AgentPromptInput) {
    if (prompt !== "/goal pause") return null;
    return {
      run: async () => {
        this.onOutOfBand?.();
      },
    };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private push(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) cb(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {
    const turnId = this.openTurnId;
    if (!turnId) return;
    this.openTurnId = null;
    this.push({ type: "turn_canceled", provider: "codex", reason: "interrupted", turnId });
  }
  async close(): Promise<void> {}
}

class HeldTurnClient implements AgentClient {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = CAPABILITIES;
  readonly sessions: HeldTurnSession[] = [];
  outOfBandRuns = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new HeldTurnSession(config, () => {
      this.outOfBandRuns += 1;
    });
    this.sessions.push(session);
    return session;
  }
  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return await this.createSession({ provider: "codex", cwd: config?.cwd ?? process.cwd() });
  }
  async fetchCatalog() {
    return {
      models: [{ provider: this.provider, id: "m", label: "M", isDefault: true }],
      modes: [],
    };
  }
}

const logger = createTestLogger();
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("AgentManager child admission", () => {
  let workdir: string;
  let client: HeldTurnClient;
  let manager: AgentManager;
  let admission: ChildAdmissionController;
  let config: ChildAdmissionConfig;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "agent-manager-admission-"));
    client = new HeldTurnClient();
    manager = new AgentManager({ clients: { codex: client }, logger });
    config = { maxConcurrentChildTurns: 1 };
    admission = new ChildAdmissionController({
      readConfig: () => config,
      listAgents: () => manager.listAgentsForAdmission(),
      logger,
    });
    manager.setChildAdmission(admission);
  });

  afterEach(async () => {
    for (const agent of manager.listAgents()) {
      await manager.closeAgent(agent.id).catch(() => undefined);
    }
    rmSync(workdir, { recursive: true, force: true });
  });

  async function create(parentAgentId: string | null) {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
      labels: parentAgentId ? { [PARENT_AGENT_ID_LABEL]: parentAgentId } : {},
    });
    return { id: agent.id, session: client.sessions.at(-1)! };
  }

  async function prompt(agentId: string, text: AgentPromptInput) {
    return await startAgentRun(manager, agentId, text, logger, { replaceRunning: true });
  }

  test("a child past the cap waits in line looking running, and starts when a slot frees", async () => {
    const root = await create(null);
    const first = await create(root.id);
    const second = await create(root.id);

    await prompt(first.id, "first task");
    await flush();
    expect(manager.getAgent(first.id)?.lifecycle).toBe("running");

    await prompt(second.id, "second task");
    await flush();
    const queued = manager.getAgent(second.id)!;
    expect(second.session.startedPrompts).toEqual([]);
    expect(queued.lifecycle).toBe("running");
    expect(toAgentPayload(queued).turnQueued).toEqual({ queuedAt: expect.any(String) });
    // Callers that wait for the start (sendPromptToAgent, create) get an answer, not a timeout.
    await manager.waitForAgentRunStart(second.id);
    // A parent waiting on the queued child keeps waiting.
    let waitSettled = false;
    const waiting = manager.waitForAgentEvent(second.id).then((result) => {
      waitSettled = true;
      return result;
    });
    // The done janitor sees a child with a turn in flight, not an idle one to ask about.
    expect(manager.listAgentsForDoneJanitor().find((a) => a.id === second.id)).toMatchObject({
      lifecycle: "running",
      busy: true,
    });
    // The stall sweep does not mistake the silence for a stall.
    expect(manager.listAgentsForStallSweep().find((a) => a.id === second.id)?.turnQueued).toBe(
      true,
    );
    await flush();
    expect(waitSettled).toBe(false);

    first.session.finishTurn();
    await flush();
    expect(second.session.startedPrompts).toEqual(["second task"]);
    expect(manager.getAgent(second.id)?.turnQueued).toBeUndefined();
    expect(toAgentPayload(manager.getAgent(second.id)!).turnQueued).toBeUndefined();
    expect(waitSettled).toBe(false);

    second.session.finishTurn();
    await expect(waiting).resolves.toMatchObject({ status: "idle" });
  });

  test("a root is never queued, even with the cap full and admission held", async () => {
    const root = await create(null);
    const child = await create(root.id);
    await prompt(child.id, "child task");
    admission.setHold("saturation", true);
    await prompt(root.id, "root task");
    await flush();
    expect(root.session.startedPrompts).toEqual(["root task"]);
  });

  test("steering and replacing a running child's turn never queue it, even at the cap", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const waiting = await create(root.id);
    await prompt(running.id, "task");
    await prompt(waiting.id, "queued task");
    await flush();
    expect(admission.queueLength()).toBe(1);

    // replaceRunning: the running child's turn is replaced in place, keeping its slot.
    await prompt(running.id, "new instructions");
    await flush();
    expect(running.session.startedPrompts).toEqual(["task", "new instructions"]);
    expect(admission.isQueued(running.id)).toBe(false);
    expect(admission.queueLength()).toBe(1);
  });

  test("out-of-band commands run on a queued child without touching the line", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const waiting = await create(root.id);
    await prompt(running.id, "task");
    await prompt(waiting.id, "queued task");
    await flush();
    await expect(prompt(waiting.id, "/goal pause")).resolves.toEqual({
      disposition: "out_of_band",
    });
    await flush();
    expect(client.outOfBandRuns).toBe(1);
    expect(admission.isQueued(waiting.id)).toBe(true);
  });

  test("a second prompt to a queued child joins the held one and keeps its place", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const a = await create(root.id);
    const b = await create(root.id);
    await prompt(running.id, "task");
    await prompt(a.id, "part one");
    await prompt(b.id, "b task");
    await flush();
    await prompt(a.id, "part two");
    await flush();
    expect(admission.queueLength()).toBe(2);

    running.session.finishTurn();
    await flush();
    expect(a.session.startedPrompts).toEqual(["part one\n\npart two"]);
    expect(b.session.startedPrompts).toEqual([]);
  });

  test("cancelling a queued child drops it and settles it as cancelled, without a turn", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const waiting = await create(root.id);
    await prompt(running.id, "task");
    await prompt(waiting.id, "queued task");
    await flush();
    const waited = manager.waitForAgentEvent(waiting.id);

    await expect(manager.cancelAgentRun(waiting.id)).resolves.toEqual({ status: "settled" });
    expect(admission.queueLength()).toBe(0);
    expect(manager.getAgent(waiting.id)?.lifecycle).toBe("idle");
    expect(manager.hasInFlightRun(waiting.id)).toBe(false);
    await expect(waited).resolves.toMatchObject({ status: "idle" });

    running.session.finishTurn();
    await flush();
    expect(waiting.session.startedPrompts).toEqual([]);
    // Prompted again afterwards, it runs normally.
    await prompt(waiting.id, "again");
    await flush();
    expect(waiting.session.startedPrompts).toEqual(["again"]);
  });

  test("closing a queued child drops it from the line", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const waiting = await create(root.id);
    const next = await create(root.id);
    await prompt(running.id, "task");
    await prompt(waiting.id, "queued task");
    await prompt(next.id, "next task");
    await flush();

    await manager.closeAgent(waiting.id);
    expect(admission.isQueued(waiting.id)).toBe(false);
    running.session.finishTurn();
    await flush();
    expect(next.session.startedPrompts).toEqual(["next task"]);
  });

  test("a sub-leader waiting on its own worker does not hold the only slot", async () => {
    const root = await create(null);
    const lead = await create(root.id);
    const worker = await create(lead.id);
    await prompt(lead.id, "lead the work");
    await flush();
    await prompt(worker.id, "do the work");
    await flush();
    expect(worker.session.startedPrompts).toEqual(["do the work"]);
    expect(admission.queueLength()).toBe(0);
  });

  test("a reload keeps a queued child's held prompt and never shows it idle", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const waiting = await create(root.id);
    await prompt(running.id, "task");
    await prompt(waiting.id, "queued task");
    await flush();
    const lifecycles: string[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_state") lifecycles.push(event.agent.lifecycle);
      },
      { agentId: waiting.id, replayState: false },
    );

    await manager.reloadAgentSession(waiting.id);
    await flush();
    expect(lifecycles).not.toContain("idle");
    expect(admission.isQueued(waiting.id)).toBe(true);
    expect(manager.getAgent(waiting.id)?.turnQueued).toBeDefined();

    running.session.finishTurn();
    await flush();
    const reloadedSession = client.sessions.at(-1)!;
    expect(reloadedSession.startedPrompts).toEqual(["queued task"]);
    unsubscribe();
  });

  test("turning admission off releases the line", async () => {
    const root = await create(null);
    const running = await create(root.id);
    const waiting = await create(root.id);
    await prompt(running.id, "task");
    await prompt(waiting.id, "queued task");
    await flush();
    config = { enabled: false };
    admission.pump();
    await flush();
    expect(waiting.session.startedPrompts).toEqual(["queued task"]);
  });
});
