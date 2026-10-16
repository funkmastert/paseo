import { expect, it } from "vitest";
import { buildPluginOfflineNotificationPayload } from "./plugin-connection-notification.js";

it("names the plugin, how long it has been offline, and the recovery command", () => {
  expect(
    buildPluginOfflineNotificationPayload({
      serverId: "srv-1",
      pluginId: "claude-account-pool",
      offlineForMs: 75_000,
    }),
  ).toEqual({
    title: "Plugin is offline",
    body: "claude-account-pool has been unable to reach the daemon for 75s. Anything it handles is being skipped; run `paseo plugin reload claude-account-pool`.",
    data: {
      serverId: "srv-1",
      pluginId: "claude-account-pool",
      reason: "plugin_offline",
    },
  });
});
