import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { beforeAll, describe, expect, test } from "vitest";
import { createPaseoDaemon, type PaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";

// This suite proves the claude-account-pool plugin's role-model-policy engine
// (Phase 1: docs/plans/2026-09-12-004-feat-agent-model-policy-plan.md) end-to-end
// against a real in-process daemon with the real plugin installed, exercising
// both role hooks registered in one contribute(): the role router (rewrites
// config.model/config.provider) running before the unmodified account router
// (rewrites config.provider to a pool member). The plugin lives outside this
// repo (see account-pool-routing.local.e2e.test.ts for the sibling suite this
// mirrors). It is a local-only e2e suite (see docs/testing.md): it requires
// the plugin checked out on disk, so it never runs in CI.
const PLUGIN_ID = "claude-account-pool";
const PLUGIN_DIR =
  process.env.ACCOUNT_POOL_PLUGIN_DIR ??
  path.join(homedir(), "paseo-plugins", "claude-account-pool");
const pluginAvailable = existsSync(PLUGIN_DIR);

const AGENT_TYPE_LABEL = "paseo.agent-type";
const SONNET_WEEKLY_CAP_TEXT =
  "emit a turn failure: hit your limit — weekly sonnet cap reached, resets at 3am";

// The fake claude agent client's fetchCatalog() (test-utils/fake-agent-client.ts)
// returns exactly these two model ids for provider "claude" — the family id
// role policy model refs use, distinct from the pool-worker entry ids
// (claude-leader/claude-w1/...) that only rewrite config.provider.
const REVIEWER_MODELS_POLICY = {
  schemaVersion: 1,
  roles: [
    { id: "worker", name: "worker", standard: true, aliases: [], models: [] },
    {
      id: "reviewer",
      name: "reviewer",
      standard: true,
      aliases: [],
      models: ["claude/sonnet", "claude/haiku"],
    },
    { id: "advisor", name: "advisor", standard: true, aliases: [], models: [] },
  ],
  agentTypeMappings: {
    worker: "worker",
    scout: "worker",
    researcher: "worker",
    delegate: "worker",
    reviewer: "reviewer",
    "ce-code-reviewer": "reviewer",
    oracle: "advisor",
    advisor: "advisor",
  },
  revision: "e2e-1",
};

interface RoleHarness {
  daemon: PaseoDaemon;
  client: DaemonClient;
  directory: string;
  close: () => Promise<void>;
}

async function createRoleHarness(): Promise<RoleHarness> {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-role-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-role-static-"));
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-role-cwd-"));

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
        // The base "claude" provider is what the role policy's model refs
        // resolve against (family ids, never pool-worker entry ids) — see
        // shared/role-policy-schema.ts's rolePolicyFamilies().
        claude: createTestAgentClient("claude"),
        "claude-leader": createTestAgentClient("claude-leader"),
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
    throw new Error("agent-model-policy test daemon did not bind a TCP port");
  }

  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "agent-model-policy" } });

  return {
    daemon,
    client,
    directory,
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

async function configureReviewerPolicy(client: DaemonClient): Promise<void> {
  // `agentModelPolicy` is a top-level daemon config passthrough key
  // (shared/role-policy-schema.ts), not nested under `providers` — see plan
  // §2.4. MutableDaemonConfigPatchSchema is `.passthrough()` at the top
  // level, so this survives validation even though it isn't declared on the
  // schema; daemon-config-store.ts forwards it structurally (see the fork
  // patch this task added there).
  await client.patchDaemonConfig({ agentModelPolicy: REVIEWER_MODELS_POLICY });
}

async function createProbe(
  harness: RoleHarness,
  parentId: string,
  overrides: { title?: string; labels?: Record<string, string>; initialPrompt?: string } = {},
): Promise<{ id: string; provider: string | undefined; model: string | undefined }> {
  const agent = await harness.client.createAgent({
    provider: "claude-leader",
    model: "placeholder-model",
    cwd: harness.directory,
    title: overrides.title ?? `Probe-${Date.now()}`,
    callerAgentId: parentId,
    labels: overrides.labels,
    initialPrompt: overrides.initialPrompt,
  });
  const stored = harness.daemon.agentManager.getAgent(agent.id)?.config;
  return { id: agent.id, provider: stored?.provider, model: stored?.model };
}

// Polls with throwaway reviewer-labeled probes until both the pool cache and
// the role-policy/model-catalog caches have warmed (all four force-refresh on
// the same first-hook-dispatch microtask chain in index.server.ts).
async function awaitRoleWarm(harness: RoleHarness, warmParentId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const probe = await createProbe(harness, warmParentId, {
          labels: { [AGENT_TYPE_LABEL]: "ce-code-reviewer" },
        });
        return probe.model;
      },
      { timeout: 20_000, interval: 500 },
    )
    .toBe("sonnet");
}

async function capAccountForSonnet(harness: RoleHarness, providerId: string): Promise<void> {
  const probe = await harness.client.createAgent({
    provider: providerId,
    model: "sonnet",
    cwd: harness.directory,
    title: `cap-${providerId}`,
  });
  await harness.client.sendMessage(probe.id, SONNET_WEEKLY_CAP_TEXT);
  await expect
    .poll(() => harness.daemon.agentManager.getAgent(probe.id)?.lastError, { timeout: 5_000 })
    .toBeTruthy();
}

describe("agent model policy routing plugin (e2e)", () => {
  beforeAll(() => {
    if (!pluginAvailable) {
      throw new Error(
        `claude-account-pool plugin not found at ${PLUGIN_DIR}. This is a local-only e2e suite that ` +
          "requires the plugin checked out on disk — set ACCOUNT_POOL_PLUGIN_DIR to its location, or " +
          "check it out at the default path.",
      );
    }
  });

  test("mapped agent-type label routes to the role's top model on a healthy pool worker", async () => {
    const harness = await createRoleHarness();
    try {
      await configurePool(harness.client);
      await configureReviewerPolicy(harness.client);
      await harness.client.installDirectoryPlugin(PLUGIN_DIR, PLUGIN_ID);

      const warmParent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Warm leader",
      });
      await awaitRoleWarm(harness, warmParent.id);

      const parent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Leader",
      });

      // Tier 1: labels[paseo.agent-type] = "ce-code-reviewer" is an exact
      // agentTypeMappings key -> reviewer -> reviewer.models[0] = "claude/sonnet".
      const reviewed = await createProbe(harness, parent.id, {
        labels: { [AGENT_TYPE_LABEL]: "ce-code-reviewer" },
      });
      expect(reviewed.model).toBe("sonnet");
      // The account router (unmodified, running second) still picked an
      // actual pool worker for that model — the role hook never touched provider.
      expect(["claude-w1", "claude-w2", "claude-w3"]).toContain(reviewed.provider);

      // Tier 3: no label at all, but the title contains a "review" seed word.
      const classified = await createProbe(harness, parent.id, { title: "Please review this PR" });
      expect(classified.model).toBe("sonnet");
      expect(["claude-w1", "claude-w2", "claude-w3"]).toContain(classified.provider);
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("a pool-wide model-specific cap advances role selection to the next configured model", async () => {
    const harness = await createRoleHarness();
    try {
      await configurePool(harness.client);
      await configureReviewerPolicy(harness.client);
      await harness.client.installDirectoryPlugin(PLUGIN_DIR, PLUGIN_ID);

      const warmParent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Warm leader",
      });
      await awaitRoleWarm(harness, warmParent.id);

      // Cap "sonnet" specifically (a weekly per-model window) on every pool
      // member. Each is otherwise untouched, so the role stays eligible for
      // sonnet nowhere but haiku everywhere.
      for (const providerId of ["claude-w1", "claude-w2", "claude-w3", "claude-leader"]) {
        await capAccountForSonnet(harness, providerId);
      }

      const parent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Leader",
      });
      const probe = await createProbe(harness, parent.id, {
        labels: { [AGENT_TYPE_LABEL]: "ce-code-reviewer" },
      });

      expect(probe.model).toBe("haiku"); // sonnet is universally capped; haiku is untouched
    } finally {
      await harness.close();
    }
  }, 120_000);

  test("an unconfigured policy is a byte-identical pass-through for the requested model", async () => {
    const harness = await createRoleHarness();
    try {
      await configurePool(harness.client);
      // Deliberately configure the pool but not agentModelPolicy: DEFAULT_POLICY
      // (every role unconfigured) applies, so the role hook never touches the request.
      await harness.client.installDirectoryPlugin(PLUGIN_DIR, PLUGIN_ID);

      const parent = await harness.client.createAgent({
        provider: "claude-leader",
        model: "leader-model",
        cwd: harness.directory,
        title: "Leader",
      });

      // Warm the account pool alone (the existing sibling suite's helper
      // shape) so this assertion isn't confused with a cold-start fail-open.
      await expect
        .poll(
          async () => {
            const probe = await createProbe(harness, parent.id, {});
            return probe.provider;
          },
          { timeout: 20_000, interval: 500 },
        )
        .not.toBe("claude-leader");

      const probe = await createProbe(harness, parent.id, {
        labels: { [AGENT_TYPE_LABEL]: "ce-code-reviewer" },
      });
      // No agentModelPolicy configured -> reviewer.models is empty -> UNCONFIGURED
      // -> the caller's original model request survives untouched.
      expect(probe.model).toBe("placeholder-model");
    } finally {
      await harness.close();
    }
  }, 60_000);
});
