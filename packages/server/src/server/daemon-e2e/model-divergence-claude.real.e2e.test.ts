import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";

// Real Claude, real API: what the response stream reports is compared with what the agent was
// configured with, end to end through the adapter and AgentManager (docs/model-divergence.md).
// A turn is one word, so this is a few cents. It talks to Anthropic directly, unlike the other
// real Claude suites, which go through OpenRouter and would report OpenRouter's model names, and
// it is gated on the `claude` binary alone. Run it with CLAUDE_CONFIG_DIR pointing at a
// logged-in account.

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-claude-model-divergence-"));
}

describe("daemon E2E (real claude) - model divergence", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isCommandAvailable("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  async function withDaemon(
    run: (input: {
      daemon: TestPaseoDaemon;
      client: DaemonClient;
      cwd: string;
      runTurn: (agentId: string) => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "model-divergence" } });
      await run({
        daemon,
        client,
        cwd,
        runTurn: async (agentId) => {
          await client.sendMessage(agentId, "Reply with exactly: OK");
          const finish = await client.waitForFinish(agentId, 180_000);
          expect(finish.status).toBe("idle");
        },
      });
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  test("an agent configured with claude-opus-5-5 is answered by claude-opus-5-5", async () => {
    await withDaemon(async ({ daemon, client, cwd, runTurn }) => {
      const agent = await client.createAgent({
        provider: "claude",
        cwd,
        model: "claude-opus-5-5",
        title: "divergence-opus-5-5",
      });
      await runTurn(agent.id);

      const state = daemon.daemon.agentManager.getAgent(agent.id)?.modelDivergenceState;
      expect(state?.observedModel).toBe("claude-opus-5-5");
      expect(state?.divergence).toBeUndefined();
    });
  }, 300_000);

  test("an alias is settled through the CLI's own resolution, not flagged", async () => {
    await withDaemon(async ({ daemon, client, cwd, runTurn }) => {
      const agent = await client.createAgent({
        provider: "claude",
        cwd,
        model: "haiku",
        title: "divergence-alias",
      });
      await runTurn(agent.id);

      const state = daemon.daemon.agentManager.getAgent(agent.id)?.modelDivergenceState;
      expect(state?.observedModel).toMatch(/^claude-haiku-/);
      expect(state?.divergence).toBeUndefined();
    });
  }, 300_000);

  test("a session switched behind the manager's back is a finding; the manager's own switch is not", async () => {
    await withDaemon(async ({ daemon, client, cwd, runTurn }) => {
      const manager = daemon.daemon.agentManager;
      const agent = await client.createAgent({
        provider: "claude",
        cwd,
        model: "claude-haiku-4-5",
        title: "divergence-unexplained",
      });
      await runTurn(agent.id);
      expect(manager.getAgent(agent.id)?.modelDivergenceState?.divergence).toBeUndefined();

      // The provider is told to serve another model and the manager's configuration is not
      // touched: what a CLI quietly substituting a model looks like from the daemon's side.
      const live = manager.getAgent(agent.id);
      expect(live?.session).toBeDefined();
      await live?.session?.setModel?.("claude-sonnet-5");
      await runTurn(agent.id);

      const divergence = manager.getAgent(agent.id)?.modelDivergenceState?.divergence;
      expect(divergence).toMatchObject({
        configuredModel: "claude-haiku-4-5",
        observedModel: "claude-sonnet-5",
      });

      // The same switch made through the manager is intentional, and clears the finding.
      await manager.setAgentModel(agent.id, "claude-sonnet-5");
      expect(manager.getAgent(agent.id)?.modelDivergenceState?.divergence).toBeUndefined();
      await runTurn(agent.id);
      expect(manager.getAgent(agent.id)?.modelDivergenceState?.divergence).toBeUndefined();
    });
  }, 400_000);
});
