import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useInstalledPlugin } from "@/plugins/registry";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

const AGENT_MODEL_POLICY_PLUGIN_ID = "claude-account-pool";
const AGENT_MODEL_POLICY_SCREEN_ID = "agent-model-policy";

export interface SidebarAgentRolesTarget {
  serverId: string;
  pluginId: string;
  screenId: string;
  icon: string;
}

/**
 * Resolves the footer's "Agent roles" shortcut: the active host's
 * claude-account-pool Agent Model Policy screen, when that host has the
 * plugin installed and speaks the pluginSettings feature. Null covers every
 * case the footer should fall back to the Help menu instead — no host, a
 * disconnected host, an older daemon, or a host without the plugin.
 */
export function useSidebarAgentRolesTarget(): SidebarAgentRolesTarget | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  const activeServerId = useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId,
        hosts,
        orderedHosts,
      }),
    [localServerId, hosts, orderedHosts],
  );
  const connected = useHostRuntimeIsConnected(activeServerId ?? "");
  const supported = useHostFeature(activeServerId, "pluginSettings");
  const plugin = useInstalledPlugin(activeServerId ?? "", AGENT_MODEL_POLICY_PLUGIN_ID);
  const screen = plugin?.settingsScreens.find((item) => item.id === AGENT_MODEL_POLICY_SCREEN_ID);

  if (!activeServerId || !connected || !supported || !screen) return null;
  return {
    serverId: activeServerId,
    pluginId: AGENT_MODEL_POLICY_PLUGIN_ID,
    screenId: AGENT_MODEL_POLICY_SCREEN_ID,
    icon: screen.icon,
  };
}
