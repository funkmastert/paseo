import { describe, expect, it } from "vitest";
import type { PushPayload } from "./push/index.js";
import { PluginConnectionMonitor, type PluginConnectivity } from "./plugin-connection-monitor.js";

const SWEEP_MS = 15_000;

function createHarness() {
  let now = 0;
  let connectivity: PluginConnectivity[] = [];
  const pushes: PushPayload[] = [];
  const errors: Array<{ obj: object; msg?: string }> = [];
  const monitor = new PluginConnectionMonitor({
    listConnectivity: () => connectivity,
    pushNotificationSender: {
      send: async (payload) => {
        pushes.push(payload);
      },
    },
    serverId: "srv-1",
    logger: {
      error: (obj, msg) => errors.push({ obj, msg }),
      warn: () => undefined,
    },
    sweepIntervalMs: SWEEP_MS,
    offlineThresholdMs: 60_000,
    now: () => now,
  });
  return {
    pushes,
    errors,
    setConnectivity(next: PluginConnectivity[]) {
      connectivity = next;
    },
    sweep(times = 1) {
      for (let index = 0; index < times; index += 1) {
        monitor.sweep();
        now += SWEEP_MS;
      }
    },
  };
}

const offline = [{ pluginId: "claude-account-pool", connected: false }];
const online = [{ pluginId: "claude-account-pool", connected: true }];

describe("PluginConnectionMonitor", () => {
  it("stays quiet for a drop that recovers inside the threshold", () => {
    const harness = createHarness();
    harness.setConnectivity(offline);
    harness.sweep(4);
    harness.setConnectivity(online);
    harness.sweep(10);

    expect(harness.pushes).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it("logs and pushes once after a minute offline, then re-arms after recovery", async () => {
    const harness = createHarness();
    harness.setConnectivity(offline);
    harness.sweep(5);
    await Promise.resolve();

    expect(harness.pushes).toEqual([
      expect.objectContaining({
        title: "Plugin is offline",
        data: { serverId: "srv-1", pluginId: "claude-account-pool", reason: "plugin_offline" },
      }),
    ]);
    expect(harness.pushes[0]?.body).toContain("for 60s");
    expect(harness.errors).toEqual([
      expect.objectContaining({ obj: { pluginId: "claude-account-pool", offlineForMs: 60_000 } }),
    ]);

    harness.sweep(20);
    expect(harness.pushes).toHaveLength(1);

    harness.setConnectivity(online);
    harness.sweep(5);
    harness.setConnectivity(offline);
    harness.sweep(5);
    await Promise.resolve();
    expect(harness.pushes).toHaveLength(2);
  });

  it("forgets a plugin that is no longer expected to run", () => {
    const harness = createHarness();
    harness.setConnectivity(offline);
    harness.sweep(4);
    harness.setConnectivity([]);
    harness.sweep();
    harness.setConnectivity(offline);
    harness.sweep(4);

    expect(harness.pushes).toEqual([]);
  });
});
