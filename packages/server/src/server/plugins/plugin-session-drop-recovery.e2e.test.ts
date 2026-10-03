import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { PluginSessionSocket } from "./session-socket.js";

// The production lease is 45s swept every 10s. Shrink both so a real sweep runs
// between the plugin's 10s pings (LIVENESS_HEARTBEAT_INTERVAL_MS runs inside the
// forked plugin process, which this mock cannot reach).
const { LEASE_MS, CHECK_INTERVAL_MS, seenSockets } = vi.hoisted(() => ({
  LEASE_MS: 2_000,
  CHECK_INTERVAL_MS: 200,
  seenSockets: new Set<object>(),
}));

vi.mock("../websocket/physical-socket.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../websocket/physical-socket.js")>();
  class ShortApplicationSocketLease<
    TSocket extends object,
  > extends actual.ApplicationSocketLease<TSocket> {
    constructor(clock?: () => number) {
      // Generous stall window: this test is about sweeps that run on time.
      super(clock, { leaseMs: LEASE_MS, stallMs: LEASE_MS });
    }
    // Every inbound frame passes through renew(), which lets a test reach the
    // daemon's real plugin session socket.
    override renew(socket: TSocket): void {
      seenSockets.add(socket);
      super.renew(socket);
    }
  }
  return {
    ...actual,
    ApplicationSocketLease: ShortApplicationSocketLease,
    APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS: CHECK_INTERVAL_MS,
  };
});

const PLUGIN_ID = "session-drop";
const roots: string[] = [];

afterEach(async () => {
  seenSockets.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  client: DaemonClient;
  createWorkspace(): Promise<unknown>;
  pluginLogMessages(): Promise<string[]>;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-session-drop-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-session-drop-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const create = defineRpc({
  name: "create",
  input: z.object({ path: z.string() }),
  output: z.object({ workspaceId: z.string() }),
});

export default function contribute(server: PluginServerContext) {
  server.handle(create, async ({ path }, { paseo }) => {
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path },
      title: "Plugin workspace",
    });
    return { workspaceId: workspace.id };
  });
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon({ agentClients: createTestAgentClients() });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  await client.connect();
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
    id: PLUGIN_ID,
    status: "running",
  });
  return {
    client,
    createWorkspace: () =>
      client.invokePluginRpc(PLUGIN_ID, "create", { path: workspaceDirectory }),
    pluginLogMessages: async () =>
      (await client.getPluginLogs(PLUGIN_ID)).map((entry) => entry.message),
    close: async () => {
      await client.close().catch(() => undefined);
      await daemon.close();
    },
  };
}

// The observer client is leased too; frequent requests keep renewing it.
async function holdObserverOpen(harness: Harness, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await harness.client.listPlugins();
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }
}

const workspaceResult = { workspaceId: expect.stringMatching(/^wks_/) };

test("an application-lease sweep never evicts a live plugin's daemon session", async () => {
  const harness = await startHarness();
  try {
    await expect(harness.createWorkspace()).resolves.toEqual(workspaceResult);

    // The plugin pings at ~10s and not again until ~20s. Before the fix its
    // first ping claimed a lease that expired ~2s later, closing its session
    // while the machine and the plugin were both awake.
    await holdObserverOpen(harness, 14_000);

    const messages = await harness.pluginLogMessages();
    expect(messages.filter((message) => message === "[paseo] Plugin ready")).toHaveLength(1);
    expect(messages).not.toContain("[paseo] Stopping plugin");
    await expect(harness.createWorkspace()).resolves.toEqual(workspaceResult);
  } finally {
    await harness.close();
  }
}, 40_000);

test("a plugin whose daemon session closes under a live process is restarted with a working Paseo API", async () => {
  const harness = await startHarness();
  try {
    await expect(harness.createWorkspace()).resolves.toEqual(workspaceResult);
    const sessionSocket = [...seenSockets].find(
      (socket): socket is PluginSessionSocket => socket instanceof PluginSessionSocket,
    );
    if (!sessionSocket) throw new Error("Plugin session socket was never seen by the daemon");
    expect(sessionSocket.readyState).toBe(1);

    // Same call the daemon makes when it drops a physical socket (closePhysicalSocket).
    sessionSocket.close();

    await expect
      .poll(
        async () =>
          (await harness.pluginLogMessages()).filter(
            (message) => message === "[paseo] Plugin ready",
          ).length,
        { timeout: 20_000, interval: CHECK_INTERVAL_MS },
      )
      .toBe(2);
    await expect
      .poll(
        async () =>
          (await harness.client.listPlugins()).find((plugin) => plugin.id === PLUGIN_ID)?.status,
        { timeout: 5_000, interval: CHECK_INTERVAL_MS },
      )
      .toBe("running");
    await expect(harness.createWorkspace()).resolves.toEqual(workspaceResult);
  } finally {
    await harness.close();
  }
}, 40_000);
