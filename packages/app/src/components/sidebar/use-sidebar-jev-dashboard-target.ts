import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

export interface SidebarJevDashboardTarget {
  serverId: string;
}

/**
 * Resolves the footer's "JEV dashboard" shortcut: the active host, when it is connected and
 * speaks `server_info.features.jevSavings`. Null covers every case the footer should show no
 * button for at all — no host, a disconnected host, or an older daemon — so the footer never
 * shows a dead JEV button (docs/jev.md, "The JEV dashboard" → "Where it lives").
 */
export function useSidebarJevDashboardTarget(): SidebarJevDashboardTarget | null {
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
  const supported = useHostFeature(activeServerId, "jevSavings");

  if (!activeServerId || !connected || !supported) return null;
  return { serverId: activeServerId };
}
