import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import pino from "pino";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentPermissionRequest,
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
  supportsToolInvocations: true,
} as const;

const PERMISSION: AgentPermissionRequest = {
  id: "perm-1",
  provider: "codex",
  kind: "tool",
  name: "Bash",
  title: "Permission required",
  description: "rm -rf build",
  input: { command: "rm -rf build" },
};

/** Opens a turn, then blocks on a permission and never resolves it by itself. */
class BlockingSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private pending: AgentPermissionRequest[] = [];

  constructor(private readonly config: AgentSessionConfig) {}
  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn() {
    const turnId = `turn-${randomUUID()}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: "codex", turnId });
      this.pending = [PERMISSION];
      this.push({ type: "permission_requested", provider: "codex", request: PERMISSION });
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
    return this.pending;
  }
  async respondToPermission(requestId: string) {
    this.pending = [];
    this.push({
      type: "permission_resolved",
      provider: "codex",
      requestId,
      resolution: { behavior: "allow" },
    });
  }
  describePersistence() {
    return { provider: "codex" as const, sessionId: this.id };
  }
  async interrupt() {}
  async close() {}
}

class BlockingClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  async createSession(config: AgentSessionConfig) {
    return new BlockingSession(config);
  }
  async resumeSession() {
    return new BlockingSession({ provider: "codex", cwd: "/tmp" });
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

async function blockOnPermission(options: { delegated: boolean; observed: boolean }) {
  const workdir = mkdtempSync(join(tmpdir(), "delegated-permission-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const broadcasts: Array<{ agentId: string; reason: string }> = [];
  const manager = new AgentManager({
    clients: { codex: new BlockingClient() },
    registry: storage,
    logger,
    onAgentAttention: ({ agentId, reason }) => broadcasts.push({ agentId, reason }),
    idFactory: () => randomUUID(),
  });

  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Worker" },
    undefined,
    {
      workspaceId: "ws-1",
      ...(options.delegated ? { labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } } : {}),
    },
  );
  const release = options.observed ? manager.noteFinishObserver(agent.id) : null;

  void manager.streamAgent(agent.id, "delete the build dir").next();
  await vi.waitFor(() =>
    expect(manager.getAgent(agent.id)?.pendingPermissions.size).toBeGreaterThan(0),
  );

  return { manager, agentId: agent.id, broadcasts, release };
}

describe("a delegated agent blocked on a permission", () => {
  test("reaches a person when nobody is watching it — the hang case", async () => {
    // Its finishes stay silent because its parent has them in-band. A permission is different:
    // the child does not run until somebody answers, and with no observer nobody ever will.
    const { agentId, broadcasts } = await blockOnPermission({ delegated: true, observed: false });

    expect(broadcasts).toEqual([{ agentId, reason: "permission" }]);
  });

  test("stays silent while a caller is being notified, which can answer it", async () => {
    // setupFinishNotification steers the request to the parent, which responds with
    // respond_to_permission. Pushing to a person as well is the duplicate signal #1293 removed.
    const { broadcasts } = await blockOnPermission({ delegated: true, observed: true });

    expect(broadcasts).toEqual([]);
  });

  test("goes quiet again once its observer is released mid-block", async () => {
    // The observer releasing is how "nobody can answer this" becomes true: an archived caller
    // stops its own observer, and so does a finished turn.
    const { manager, agentId, broadcasts, release } = await blockOnPermission({
      delegated: true,
      observed: true,
    });
    expect(broadcasts).toEqual([]);

    release?.();
    expect(manager.hasFinishObserver(agentId)).toBe(false);
  });

  test("a delegated finish is still silent, observer or not", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "delegated-finish-"));
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    const broadcasts: string[] = [];
    const manager = new AgentManager({
      clients: { codex: new BlockingClient() },
      registry: storage,
      logger,
      onAgentAttention: ({ reason }) => broadcasts.push(reason),
      idFactory: () => randomUUID(),
    });
    const agent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Worker" },
      undefined,
      { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" } },
    );

    void manager.streamAgent(agent.id, "delete the build dir").next();
    await vi.waitFor(() =>
      expect(manager.getAgent(agent.id)?.pendingPermissions.size).toBeGreaterThan(0),
    );
    await manager.respondToPermission(agent.id, PERMISSION.id, { behavior: "allow" });

    // Only the permission ever broadcast; nothing about the delegation finishing.
    expect(broadcasts).toEqual(["permission"]);
  });

  test("a top-level agent's permission is unaffected by the observer rule", async () => {
    const { agentId, broadcasts } = await blockOnPermission({ delegated: false, observed: true });

    expect(broadcasts).toEqual([{ agentId, reason: "permission" }]);
  });
});
