import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { createPaseoDaemon, type PaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";

// This suite proves the claude-account-pool routing plugin's acceptance examples
// end-to-end against a real in-process daemon with the real plugin installed. The
// plugin lives outside this repo (see docs/plans/2026-09-10-001-feat-claude-account-pool-routing-plan.md,
// unit U8); fork CI checkouts won't have it, so the whole suite skips cleanly when
// the directory is absent.
const PLUGIN_ID = "claude-account-pool";
const PLUGIN_DIR =
  process.env.ACCOUNT_POOL_PLUGIN_DIR ?? "/Users/tylerthackray/paseo-plugins/claude-account-pool";
const pluginAvailable = existsSync(PLUGIN_DIR);

// FRICTION: the plugin's pool cache and provider-id cache (server/pool.ts,
// server/router.ts) start fail-open/empty and only refresh on a hardcoded 60s
// setInterval tick or an explicit forceRefresh() call. index.server.ts never calls
// forceRefresh() on startup, and no RPC exposes one, so there is no way for an
// external harness to warm the cache faster than a real interval tick. Every test
// below eats one ~62s wait for this reason -- see the final report for the
// live-smoke implication (a freshly restarted daemon will fail-open route for up to
// a minute before the pool engages).
const POOL_CACHE_WARM_UP_MS = 62_000;

const MODEL = "custom-model-x";
const LIMIT_TEXT = "emit a turn failure: You've hit your limit for this account. Try again soon.";

interface PoolHarness {
  daemon: PaseoDaemon;
  client: DaemonClient;
  directory: string;
  leaderMessages: string[];
  close: () => Promise<void>;
}

async function createPoolHarness(): Promise<PoolHarness> {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-pool-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-pool-static-"));
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-pool-cwd-"));

  const leaderMessages: string[] = [];

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
      pluginsEnabled: true,
      agentClients: {
        "claude-leader": createTestAgentClient("claude-leader", {
          onStartTurn: (prompt) => {
            leaderMessages.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
          },
        }),
        "claude-w1": createTestAgentClient("claude-w1"),
        "claude-w2": createTestAgentClient("claude-w2"),
        "claude-w3": createTestAgentClient("claude-w3"),
      },
      providerOverrides: {
        "claude-leader": {
          extends: "claude",
          label: "Claude Leader",
          env: { CLAUDE_CONFIG_DIR: path.join(paseoHomeRoot, "leader-config") },
        },
        "claude-w1": {
          extends: "claude",
          label: "Claude Worker 1",
          env: { CLAUDE_CONFIG_DIR: path.join(paseoHomeRoot, "w1-config") },
        },
        "claude-w2": {
          extends: "claude",
          label: "Claude Worker 2",
          env: { CLAUDE_CONFIG_DIR: path.join(paseoHomeRoot, "w2-config") },
        },
        "claude-w3": {
          extends: "claude",
          label: "Claude Worker 3",
          env: { CLAUDE_CONFIG_DIR: path.join(paseoHomeRoot, "w3-config") },
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
    throw new Error("account pool test daemon did not bind a TCP port");
  }

  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "account-pool" } });

  return {
    daemon,
    client,
    directory,
    leaderMessages,
    close: async () => {
      await client.close();
      await daemon.stop().catch(() => undefined);
      await Promise.all([
        rm(paseoHomeRoot, { recursive: true, force: true }),
        rm(staticDir, { recursive: true, force: true }),
        rm(directory, { recursive: true, force: true }),
      ]);
    },
  };
}

// Mirrors the derived-provider shape already registered via providerOverrides at
// daemon startup: the mutable config store (what config.get()/patch() expose,
// and what the plugin's loadPool() reads) is a separate surface from
// providerOverrides, so a custom provider id needs extends+label here too or
// the merged config fails MutableDaemonConfigPatchSchema/ProviderOverrideSchema
// validation on save.
async function configurePool(client: DaemonClient): Promise<void> {
  await client.patchDaemonConfig({
    providers: {
      "claude-leader": {
        extends: "claude",
        label: "Claude Leader",
        params: { accountPool: { role: "leader", priority: 1 } },
      },
      "claude-w1": {
        extends: "claude",
        label: "Claude Worker 1",
        params: { accountPool: { role: "worker", priority: 1 } },
      },
      "claude-w2": {
        extends: "claude",
        label: "Claude Worker 2",
        params: { accountPool: { role: "worker", priority: 2 } },
      },
      "claude-w3": {
        extends: "claude",
        label: "Claude Worker 3",
        params: { accountPool: { role: "worker", priority: 3 } },
      },
    },
  });
}

async function createProbe(
  harness: PoolHarness,
  parentId: string,
  title: string,
): Promise<{ id: string; provider: string | undefined }> {
  const agent = await harness.client.createAgent({
    provider: "claude-leader",
    model: MODEL,
    cwd: harness.directory,
    title,
    callerAgentId: parentId,
  });
  return {
    id: agent.id,
    provider: harness.daemon.agentManager.getAgent(agent.id)?.config.provider,
  };
}

describe.skipIf(!pluginAvailable)("account pool routing plugin (e2e)", () => {
  test("routes agent-initiated creates across the worker chain and falls back to the leader once the pool is dry", async () => {
    const harness = await createPoolHarness();
    try {
      await configurePool(harness.client);
      await harness.client.installDirectoryPlugin(PLUGIN_DIR, PLUGIN_ID);

      // R4: a human-created (no callerAgentId) leader agent is never rewritten.
      const parent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Leader",
      });
      expect(harness.daemon.agentManager.getAgent(parent.id)?.config.provider).toBe(
        "claude-leader",
      );

      await new Promise((resolve) => setTimeout(resolve, POOL_CACHE_WARM_UP_MS));

      // AE1 (R2): an agent-initiated create lands on the top-priority healthy
      // worker, preserving the caller's model choice.
      const childA = await harness.client.createAgent({
        provider: "claude-leader",
        model: MODEL,
        cwd: harness.directory,
        title: "Child A",
        callerAgentId: parent.id,
      });
      expect(harness.daemon.agentManager.getAgent(childA.id)?.config).toMatchObject({
        provider: "claude-w1",
        model: MODEL,
      });

      // AE2 (R3): a create whose caller is itself a routed worker is routed the
      // same way (recursive routing).
      const grandchild = await harness.client.createAgent({
        provider: "claude-leader",
        model: MODEL,
        cwd: harness.directory,
        title: "Grandchild of Child A",
        callerAgentId: childA.id,
      });
      expect(harness.daemon.agentManager.getAgent(grandchild.id)?.config.provider).toBe(
        "claude-w1",
      );

      // A second child lands on w1 too, while it's still healthy, so the
      // upcoming cap notification (AE5) has two children to name.
      const childA2 = await harness.client.createAgent({
        provider: "claude-leader",
        model: MODEL,
        cwd: harness.directory,
        title: "Child A2",
        callerAgentId: parent.id,
      });
      expect(harness.daemon.agentManager.getAgent(childA2.id)?.config.provider).toBe("claude-w1");

      // Cap w1 via a limit-shaped reactive turn failure.
      await harness.client.sendMessage(childA.id, LIMIT_TEXT);
      await expect
        .poll(() => harness.daemon.agentManager.getAgent(childA.id)?.lastError, { timeout: 5_000 })
        .toBeTruthy();

      // AE3 (R6): the next spawn advances to the next healthy worker, w2, with
      // no leader involvement.
      let childBId = "";
      await expect
        .poll(
          async () => {
            const probe = await createProbe(harness, parent.id, `Probe-w2-${Date.now()}`);
            childBId = probe.id;
            return probe.provider;
          },
          { timeout: 15_000, interval: 500 },
        )
        .toBe("claude-w2");

      // Cap w2, then confirm the chain advances again to w3.
      await harness.client.sendMessage(childBId, LIMIT_TEXT);
      await expect
        .poll(() => harness.daemon.agentManager.getAgent(childBId)?.lastError, { timeout: 5_000 })
        .toBeTruthy();

      let childCId = "";
      await expect
        .poll(
          async () => {
            const probe = await createProbe(harness, parent.id, `Probe-w3-${Date.now()}`);
            childCId = probe.id;
            return probe.provider;
          },
          { timeout: 15_000, interval: 500 },
        )
        .toBe("claude-w3");

      // Cap w3: every worker is now capped.
      await harness.client.sendMessage(childCId, LIMIT_TEXT);
      await expect
        .poll(() => harness.daemon.agentManager.getAgent(childCId)?.lastError, { timeout: 5_000 })
        .toBeTruthy();

      // AE4 (R7): with every worker capped, spawns fall back to the leader's own
      // account.
      await expect
        .poll(
          async () => {
            const probe = await createProbe(harness, parent.id, `Probe-dry-${Date.now()}`);
            return probe.provider;
          },
          { timeout: 15_000, interval: 500 },
        )
        .toBe("claude-leader");

      // AE4 (R10): a burst of further spawns while the pool stays dry produces
      // no additional notifications -- exactly one for the whole episode.
      const burst = await Promise.all(
        [0, 1, 2].map((index) => createProbe(harness, parent.id, `Burst-${index}`)),
      );
      for (const probe of burst) {
        expect(probe.provider).toBe("claude-leader");
      }

      const countPoolDryMessages = () =>
        harness.leaderMessages.filter((message) => message.includes("every worker is capped"))
          .length;
      await expect.poll(countPoolDryMessages, { timeout: 5_000 }).toBe(1);

      // AE5 (R9) is exercised by a separate, deliberately skipped scenario below
      // -- see the comment there for why it cannot pass against the current
      // fork state, independent of anything in this test file.
    } finally {
      await harness.close();
    }
  }, 180_000);

  // AE5 (R9): "given three children are mid-task on account B when B caps, the
  // leader receives one message naming account B, the reset time, and those
  // children" -- the task brief asks for two children instead of three; either
  // way this cannot pass against the current fork.
  //
  // Root cause, verified by reading the code rather than guessing from a timeout:
  // notify.ts's resolveRootLeader/groupAffectedChildrenByLeader (server/notify.ts:71-114)
  // walk a `parentAgentId` field on each `paseo.agents.list()` row to find a
  // capped worker's creator. That field does not exist anywhere in this fork's
  // wire protocol: AgentSnapshotPayloadSchema (packages/protocol/src/messages.ts:854-883)
  // has no `parentAgentId` key, and toAgentPayload (packages/server/src/server/agent/agent-projections.ts:100-160)
  // never sets one -- it only forwards `labels`, which carries a *different* key
  // (`PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id"`, packages/protocol/src/agent-labels.ts:1)
  // that notify.ts never reads. So resolveRootLeader(rows, childRow.id) always
  // returns childRow itself (no parent found), groupAffectedChildrenByLeader's
  // `leader.id === row.id` guard then skips every row, and processCapped finds
  // zero groups to notify -- the R9 cap notification can never fire, for any
  // multi-hop case, regardless of what this test does.
  //
  // This is a plugin/fork integration gap, not a test-harness limitation, so no
  // amount of e2e cleverness here fixes it. It's covered today only by the
  // plugin's notify.test.ts, which fakes the agent directory with parentAgentId
  // already present and so never exercises the real wire shape. Flagging this
  // for the live smoke and for whoever picks up the next plugin patch: either
  // the fork needs a fifth patch exposing `parentAgentId` on
  // AgentSnapshotPayload/AgentListItemPayload (derived from the
  // `paseo.parent-agent-id` label, mirroring callerAgentId), or notify.ts needs
  // to read the label directly.
  test.skip("AE5: the leader receives one message naming a capped worker and its affected children", () => {
    // Intentionally empty -- see the comment above for why this is skipped.
  });

  test("fails open when accountPool params are absent from every provider entry", async () => {
    const harness = await createPoolHarness();
    try {
      // Deliberately skip configurePool(): pluginsEnabled is on, but no
      // provider entry carries params.accountPool, so the pool never loads.
      await harness.client.installDirectoryPlugin(PLUGIN_DIR, PLUGIN_ID);

      const parent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Leader",
      });

      const child = await harness.client.createAgent({
        provider: "claude-leader",
        model: MODEL,
        cwd: harness.directory,
        title: "Child",
        callerAgentId: parent.id,
      });

      expect(harness.daemon.agentManager.getAgent(child.id)?.config).toMatchObject({
        provider: "claude-leader",
        model: MODEL,
      });
    } finally {
      await harness.close();
    }
  }, 30_000);

  test("routing keeps working after a client-initiated plugin reload", async () => {
    const harness = await createPoolHarness();
    try {
      await configurePool(harness.client);
      await harness.client.installDirectoryPlugin(PLUGIN_DIR, PLUGIN_ID);

      const parent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Leader",
      });

      await new Promise((resolve) => setTimeout(resolve, POOL_CACHE_WARM_UP_MS));

      const before = await createProbe(harness, parent.id, "Before reload");
      expect(before.provider).toBe("claude-w1");

      await harness.client.reloadPlugin(PLUGIN_ID);

      // A reload constructs a fresh plugin module instance with a fresh,
      // not-yet-constructed pool cache: ensureStarted() only builds the cache
      // (still cold, per the warm-up comment at the top of this file) the
      // first time a hook fires post-reload. Fire one now so the interval
      // timer actually starts before we wait it out, or the wait below is
      // spent before the cache even exists.
      await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Post-reload cache kick",
      });
      await new Promise((resolve) => setTimeout(resolve, POOL_CACHE_WARM_UP_MS));

      const after = await createProbe(harness, parent.id, "After reload");
      expect(after.provider).toBe("claude-w1");
    } finally {
      await harness.close();
    }
  }, 220_000);
});
