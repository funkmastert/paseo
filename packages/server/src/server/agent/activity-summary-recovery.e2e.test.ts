import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPaseoDaemon, type PaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

/**
 * What the agent panel's subtitle shows after the daemon restarts. `lastActivitySummary` is
 * computed live from each timeline item and never persisted, so before this it came back blank
 * for every agent — 49 of 53 rows on one measured fleet — and stayed blank until the agent's
 * next tool call. Recovery replays the provider transcript on load, which was already happening.
 */
interface Harness {
  daemon: PaseoDaemon;
  client: DaemonClient;
  paseoHome: string;
  staticDir: string;
  cwd: string;
}

async function startDaemon(paths: {
  paseoHome: string;
  staticDir: string;
}): Promise<{ daemon: PaseoDaemon; client: DaemonClient }> {
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome: paths.paseoHome,
      daemonVersion: "0.8.0",
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir: paths.staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paths.paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    pino({ level: "silent" }),
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  if (!target || target.type !== "tcp") {
    throw new Error("activity-summary test daemon did not bind a TCP port");
  }
  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.8.0" });
  await client.connect();
  await client.fetchAgents({ subscribe: { subscriptionId: "activity-summary" } });
  return { daemon, client };
}

describe("activity summary across a daemon restart (e2e)", () => {
  let harness: Harness;

  beforeEach(async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "paseo-activity-home-"));
    const paseoHome = path.join(homeRoot, ".paseo");
    await mkdir(paseoHome, { recursive: true });
    const staticDir = await mkdtemp(path.join(tmpdir(), "paseo-activity-static-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-activity-cwd-"));
    const started = await startDaemon({ paseoHome, staticDir });
    harness = { ...started, paseoHome, staticDir, cwd };
  }, 30_000);

  afterEach(async () => {
    await harness.client.close();
    await harness.daemon.stop().catch(() => undefined);
    await Promise.all([
      rm(harness.paseoHome, { recursive: true, force: true }),
      rm(harness.staticDir, { recursive: true, force: true }),
      rm(harness.cwd, { recursive: true, force: true }),
    ]);
  });

  test("an agent that ran a tool still says what it was doing after a restart", async () => {
    const agent = await harness.client.createAgent({
      provider: "claude",
      model: "sonnet",
      modeId: "bypassPermissions",
      cwd: harness.cwd,
      title: "Reads a file",
    });
    await harness.client.sendMessage(agent.id, "read /etc/hosts");
    // Settle the turn first: the summary moves as items arrive, and the value worth comparing
    // is the one the panel would actually have been showing when the daemon went down.
    await expect
      .poll(() => harness.daemon.agentManager.getAgent(agent.id)?.lifecycle, { timeout: 10_000 })
      .toBe("idle");
    const liveSummary = harness.daemon.agentManager.getAgent(agent.id)?.lastActivitySummary;
    expect(liveSummary).toBeTruthy();

    // Restart the daemon against the same PASEO_HOME, the way picking up a staged bundle does.
    await harness.client.close();
    await harness.daemon.stop();
    const restarted = await startDaemon({
      paseoHome: harness.paseoHome,
      staticDir: harness.staticDir,
    });
    harness = { ...harness, ...restarted };

    // Nothing is loaded until something asks for it, exactly as in production. Opening the
    // agent is what loads it, and opening it is when the panel wants a subtitle.
    expect(harness.daemon.agentManager.getAgent(agent.id)).toBeNull();
    await harness.client.fetchAgentTimeline(agent.id);

    await expect
      .poll(() => harness.daemon.agentManager.getAgent(agent.id)?.lastActivitySummary, {
        timeout: 10_000,
      })
      .toBe(liveSummary);
  }, 60_000);

  test("an agent whose transcript holds nothing summarizable recovers nothing", async () => {
    const agent = await harness.client.createAgent({
      provider: "claude",
      model: "sonnet",
      modeId: "bypassPermissions",
      cwd: harness.cwd,
      title: "Only talks",
    });
    await harness.client.sendMessage(agent.id, "respond with exactly: HELLO");
    await expect
      .poll(() => harness.daemon.agentManager.getLastAssistantMessage(agent.id), {
        timeout: 10_000,
      })
      .toBe("HELLO");

    await harness.client.close();
    await harness.daemon.stop();
    const restarted = await startDaemon({
      paseoHome: harness.paseoHome,
      staticDir: harness.staticDir,
    });
    harness = { ...harness, ...restarted };
    await harness.client.fetchAgentTimeline(agent.id);
    await expect
      .poll(() => harness.daemon.agentManager.getAgent(agent.id) !== null, { timeout: 10_000 })
      .toBe(true);

    // Prose only: the provider transcript replays assistant text, which the live path never
    // derives a subtitle from either. Recovery invents nothing, and the panel says so rather
    // than implying the agent did nothing — see the app-side copy.
    const recovered = harness.daemon.agentManager.getAgent(agent.id)?.lastActivitySummary;
    expect(recovered).toBeUndefined();
  }, 60_000);
});
