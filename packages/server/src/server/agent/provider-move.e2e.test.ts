import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createPaseoDaemon, type PaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentProviderMoveRejection } from "@getpaseo/client/internal/daemon-client";
import { AgentProviderMoveError } from "./provider-move.js";

const PROVIDERS = ["claude", "claude-personal", "claude-backup", "codex"] as const;
type Provider = (typeof PROVIDERS)[number];

interface Harness {
  daemon: PaseoDaemon;
  client: DaemonClient;
  cwd: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const homeRoot = await mkdtemp(path.join(tmpdir(), "paseo-move-home-"));
  const paseoHome = path.join(homeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-move-static-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-move-cwd-"));

  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      daemonVersion: "0.8.0",
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: Object.fromEntries(
        PROVIDERS.map((provider) => [provider, createTestAgentClient(provider)]),
      ),
      providerOverrides: {
        "claude-personal": {
          extends: "claude",
          label: "Claude Personal",
          env: { CLAUDE_CONFIG_DIR: path.join(homeRoot, "personal-config") },
        },
        "claude-backup": {
          extends: "claude",
          label: "Claude Backup",
          env: { CLAUDE_CONFIG_DIR: path.join(homeRoot, "backup-config") },
        },
      },
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    pino({ level: "silent" }),
  );

  await daemon.start();
  const target = daemon.getListenTarget();
  if (!target || target.type !== "tcp") {
    throw new Error("provider move test daemon did not bind a TCP port");
  }
  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "provider-move" } });

  return {
    daemon,
    client,
    cwd,
    close: async () => {
      await client.close();
      await daemon.stop().catch(() => undefined);
      await Promise.all([
        rm(homeRoot, { recursive: true, force: true }),
        rm(staticDir, { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true }),
      ]);
    },
  };
}

function managed(harness: Harness, agentId: string) {
  const agent = harness.daemon.agentManager.getAgent(agentId);
  if (!agent) throw new Error(`agent ${agentId} is not loaded`);
  return agent;
}

async function converse(harness: Harness, agentId: string, reply: string): Promise<void> {
  await harness.client.sendMessage(agentId, `respond with exactly: ${reply}`);
  await expect
    .poll(() => harness.daemon.agentManager.getLastAssistantMessage(agentId), { timeout: 10_000 })
    .toBe(reply);
  await expect.poll(() => managed(harness, agentId).lifecycle, { timeout: 10_000 }).toBe("idle");
}

async function createAgent(harness: Harness, provider: Provider, title: string): Promise<string> {
  const agent = await harness.client.createAgent({
    provider,
    model: provider === "codex" ? "gpt-5.4-mini" : "sonnet",
    modeId: "bypassPermissions",
    cwd: harness.cwd,
    title,
  });
  return agent.id;
}

async function expectRefusal(
  move: Promise<unknown>,
): Promise<AgentProviderMoveError & { code: string }> {
  const error = await move.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AgentProviderMoveError);
  return error as AgentProviderMoveError & { code: string };
}

describe("AgentManager.moveAgentToProvider (e2e)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  }, 30_000);

  afterEach(async () => {
    await harness.close();
  });

  test("re-opens the same session on another account, keeping id, conversation and labels", async () => {
    const agentId = await createAgent(harness, "claude-personal", "Orchestrator");
    await harness.client.updateAgent(agentId, { labels: { crew: "leader" } });
    await converse(harness, agentId, "CONTEXT-MARKER-42");
    const sessionId = managed(harness, agentId).persistence?.sessionId;
    expect(sessionId).toBeTruthy();

    const moved = await harness.daemon.agentManager.moveAgentToProvider(agentId, "claude-backup");

    expect(moved.id).toBe(agentId);
    expect(moved.provider).toBe("claude-backup");
    expect(moved.persistence?.sessionId).toBe(sessionId);
    expect(moved.labels.crew).toBe("leader");
    expect(moved.config).toMatchObject({ model: "sonnet", modeId: "bypassPermissions" });
    expect(await harness.daemon.agentManager.getLastAssistantMessage(agentId)).toBe(
      "CONTEXT-MARKER-42",
    );

    // Both halves of the record decide which account a later load resumes on.
    const record = await harness.daemon.agentStorage.get(agentId);
    expect(record?.provider).toBe("claude-backup");
    expect(record?.persistence?.provider).toBe("claude-backup");
    expect(record?.persistence?.sessionId).toBe(sessionId);

    await converse(harness, agentId, "STILL-THE-SAME-AGENT");
  }, 60_000);

  test("clears the failure the old account produced so it cannot condemn the new one", async () => {
    const agentId = await createAgent(harness, "claude-personal", "Capped");
    await converse(harness, agentId, "WORKING");
    await harness.client.sendMessage(agentId, "emit a turn failure: You've hit your limit");
    await expect.poll(() => managed(harness, agentId).lastError, { timeout: 10_000 }).toBeTruthy();

    const moved = await harness.daemon.agentManager.moveAgentToProvider(agentId, "claude-backup");

    expect(moved.lastError).toBeUndefined();
    expect((await harness.daemon.agentStorage.get(agentId))?.lastError).toBeUndefined();
  }, 60_000);

  test("refuses a cross-family move rather than opening an unreadable session", async () => {
    const agentId = await createAgent(harness, "claude-personal", "Claude work");
    await converse(harness, agentId, "READY");

    const refusal = await expectRefusal(
      harness.daemon.agentManager.moveAgentToProvider(agentId, "codex"),
    );

    expect(refusal.code).toBe("incompatible_provider");
    expect(managed(harness, agentId).provider).toBe("claude-personal");
  }, 60_000);

  test("refuses an unregistered provider and keeps the agent where it is", async () => {
    const agentId = await createAgent(harness, "claude-personal", "Claude work");
    await converse(harness, agentId, "READY");

    const refusal = await expectRefusal(
      harness.daemon.agentManager.moveAgentToProvider(agentId, "claude-nope"),
    );

    expect(refusal.code).toBe("unknown_provider");
    expect(managed(harness, agentId).provider).toBe("claude-personal");
  }, 60_000);

  test("refuses while a turn is in flight", async () => {
    const agent = await harness.client.createAgent({
      provider: "claude-personal",
      model: "sonnet",
      modeId: "default",
      cwd: harness.cwd,
      title: "Busy",
    });
    const agentId = agent.id;
    // An ask-mode permission holds the turn open for as long as the test needs it.
    await harness.client.sendMessage(
      agentId,
      'create a file named "blocked.txt" with the content "ok"',
    );
    await expect
      .poll(() => harness.daemon.agentManager.getPendingPermissions(agentId).length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    const refusal = await expectRefusal(
      harness.daemon.agentManager.moveAgentToProvider(agentId, "claude-backup"),
    );

    expect(refusal.code).toBe("agent_busy");
    expect(managed(harness, agentId).provider).toBe("claude-personal");
  }, 60_000);

  test("advertises the capability and moves over the daemon RPC", async () => {
    expect(harness.client.getLastServerInfoMessage()?.features?.agentProviderMove).toBe(true);
    const agentId = await createAgent(harness, "claude-personal", "Remote control");
    await converse(harness, agentId, "RPC-MARKER");

    await harness.client.moveAgentToProvider(agentId, "claude-backup");

    expect(managed(harness, agentId).provider).toBe("claude-backup");
    expect(await harness.daemon.agentManager.getLastAssistantMessage(agentId)).toBe("RPC-MARKER");
  }, 60_000);

  test("reports a refusal over the RPC with a code the caller can branch on", async () => {
    const agentId = await createAgent(harness, "claude-personal", "Claude work");
    await converse(harness, agentId, "READY");

    const rejection = await harness.client.moveAgentToProvider(agentId, "codex").then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(AgentProviderMoveRejection);
    expect((rejection as AgentProviderMoveRejection).code).toBe("incompatible_provider");
    expect(managed(harness, agentId).provider).toBe("claude-personal");
  }, 60_000);

  test("refuses a target that already holds another agent on the same session", async () => {
    const agentId = await createAgent(harness, "claude-personal", "Original");
    await converse(harness, agentId, "READY");
    const sessionId = managed(harness, agentId).persistence?.sessionId;
    if (!sessionId) throw new Error("agent has no session to duplicate");

    const twin = await harness.client.importAgent({
      providerId: "claude-backup",
      providerHandleId: sessionId,
      cwd: harness.cwd,
    });

    const refusal = await expectRefusal(
      harness.daemon.agentManager.moveAgentToProvider(agentId, "claude-backup"),
    );

    expect(refusal.code).toBe("session_conflict");
    expect(refusal.message).toContain(twin.id);
  }, 60_000);
});
