import { useActiveHostServerId } from "@/hooks/use-active-host-server-id";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface SidebarInsightsTarget {
  serverId: string;
}

/**
 * Resolves the sidebar's "Insights" entry target: the active host, when it is connected and
 * speaks `server_info.features.compactionLedger`. Null covers every case the row should render
 * nothing for -- no host, a disconnected host, or an older daemon -- mirroring
 * `useSidebarTokenUsageTarget`.
 */
export function useSidebarInsightsTarget(): SidebarInsightsTarget | null {
  const activeServerId = useActiveHostServerId();
  const connected = useHostRuntimeIsConnected(activeServerId ?? "");
  const supported = useHostFeature(activeServerId, "compactionLedger");

  if (!activeServerId || !connected || !supported) return null;
  return { serverId: activeServerId };
}
