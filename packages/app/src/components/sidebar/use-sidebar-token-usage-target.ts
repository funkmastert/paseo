import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

export interface SidebarTokenUsageTarget {
  serverId: string;
}

/**
 * Resolves the sidebar's "Tokens" entry target: the active host, when it is connected and speaks
 * `server_info.features.tokenUsage`. Null covers every case the row should render nothing for — no
 * host, a disconnected host, or an older daemon — mirroring `useSidebarJevDashboardTarget`.
 */
export function useSidebarTokenUsageTarget(): SidebarTokenUsageTarget | null {
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
  const supported = useHostFeature(activeServerId, "tokenUsage");

  if (!activeServerId || !connected || !supported) return null;
  return { serverId: activeServerId };
}
