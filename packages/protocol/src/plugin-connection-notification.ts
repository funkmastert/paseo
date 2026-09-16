/**
 * Push payload for a plugin that has stayed offline — not running, or running without its
 * daemon session — past the daemon's alert threshold. `data.reason` is untyped JSON on the
 * wire, like the resource-monitor and MCP gateway reasons, so old apps open the server.
 */
export interface PluginConnectionNotificationPayload {
  title: string;
  body: string;
  data: {
    [key: string]: unknown;
    serverId: string;
    pluginId: string;
    reason: "plugin_offline";
  };
}

interface BuildPluginOfflineNotificationPayloadInput {
  serverId: string;
  pluginId: string;
  offlineForMs: number;
}

export function buildPluginOfflineNotificationPayload(
  input: BuildPluginOfflineNotificationPayloadInput,
): PluginConnectionNotificationPayload {
  const seconds = Math.round(input.offlineForMs / 1000);
  return {
    title: "Plugin is offline",
    body: `${input.pluginId} has been unable to reach the daemon for ${seconds}s. Anything it handles is being skipped; run \`paseo plugin reload ${input.pluginId}\`.`,
    data: {
      serverId: input.serverId,
      pluginId: input.pluginId,
      reason: "plugin_offline",
    },
  };
}
