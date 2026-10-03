import { existsSync } from "node:fs";
import { finding, type DoctorCheck } from "./context.js";
import type { DoctorFinding } from "@getpaseo/protocol/doctor/rpc-schemas";

/**
 * A plugin that fails to load does not stop the daemon, so nothing announces it. The account-pool
 * plugin failed with `Invalid URL` and routing, tool restrictions and role enforcement were all
 * silently off until someone read the plugin log.
 */
export const pluginCheck: DoctorCheck = {
  id: "plugin.status",
  category: "plugins",
  timeoutMs: 5_000,
  async run(ctx) {
    const configured = configuredPlugins(ctx.rawConfig);
    const pluginsEnabled = ctx.rawConfig?.["pluginsEnabled"];
    const out: DoctorFinding[] = [];
    if (configured.length > 0 && pluginsEnabled === false) {
      out.push(
        finding(
          "plugin.status",
          "plugins",
          "fail",
          "Plugins are switched off but some are configured",
          {
            detail: `config.json has pluginsEnabled: false and configures ${configured.join(", ")}.`,
            why: "None of them load, so anything they enforce (routing, tool restrictions) is off.",
            fix: 'Set "pluginsEnabled": true in config.json, then `paseo daemon reload`.',
          },
        ),
      );
    }
    const plugins = ctx.facts.plugins;
    if (plugins === null) {
      out.push(
        finding("plugin.status", "plugins", "skip", "Plugin state was not available", {
          detail: "The daemon did not report its plugin list.",
        }),
      );
      return out;
    }
    for (const id of configured) {
      if (!plugins.some((plugin) => plugin.id === id)) {
        out.push(
          finding(
            "plugin.status",
            "plugins",
            "fail",
            `${id}: configured but not loaded by the daemon`,
            {
              detail: "The daemon's plugin list does not contain this id.",
              why: "It was added to config.json after the daemon started, or the daemon rejected it.",
              fix: "paseo daemon reload   # picks up new plugin config without a restart",
            },
          ),
        );
      }
    }
    for (const plugin of plugins) {
      const title = `${plugin.id}: ${plugin.status}`;
      if (!plugin.enabled || plugin.status === "disabled") {
        out.push(finding("plugin.status", "plugins", "ok", `${title} (disabled on purpose)`));
      } else if (plugin.status === "failed") {
        const tail = ctx.facts.pluginLogs?.(plugin.id).slice(-3).join(" | ");
        out.push(
          finding("plugin.status", "plugins", "fail", `${plugin.id}: failed to load`, {
            detail: [plugin.error, tail && `log tail: ${tail}`].filter(Boolean).join("\n"),
            why: "Everything this plugin enforces is off until it loads. Nothing else reports it.",
            fix: `paseo plugin logs ${plugin.id}   # then fix the cause and: paseo plugin reload ${plugin.id}`,
          }),
        );
      } else if (!existsSync(plugin.path)) {
        out.push(
          finding(
            "plugin.status",
            "plugins",
            "fail",
            `${plugin.id}: running from a path that no longer exists`,
            {
              detail: plugin.path,
              why: "The plugin is loaded in memory; the next restart cannot load it.",
              fix: `Restore ${plugin.path}, or point config.json plugins.${plugin.id}.path at the current checkout.`,
            },
          ),
        );
      } else {
        out.push(finding("plugin.status", "plugins", "ok", `${title}`));
      }
    }
    return out;
  },
};

function configuredPlugins(config: Record<string, unknown> | null): string[] {
  const plugins = config?.["plugins"];
  if (typeof plugins !== "object" || plugins === null) return [];
  return Object.entries(plugins as Record<string, unknown>)
    .filter(([, value]) => {
      if (typeof value !== "object" || value === null) return true;
      return (value as Record<string, unknown>)["enabled"] !== false;
    })
    .map(([key]) => key);
}
