import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

export interface SidebarTokenUsageTarget {
  serverId: string;
}

/**
 * COMPAT(tokenUsage): `server_info.features.tokenUsage` lands with the server/protocol unit of
 * this plan (KTD-6), in a different worktree. Until that key exists on `DaemonServerInfo`, read
 * the raw features payload instead of widening `HostFeatureName` from here. Swap this for
 * `useHostFeature(serverId, "tokenUsage")` once it lands — nothing else in this file changes.
 */
function supportsTokenUsage(features: Record<string, unknown> | null | undefined): boolean {
  return features?.tokenUsage === true;
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
  const supported = useSessionStore((state) =>
    supportsTokenUsage(
      state.sessions[activeServerId ?? ""]?.serverInfo?.features as
        | Record<string, unknown>
        | null
        | undefined,
    ),
  );

  if (!activeServerId || !connected || !supported) return null;
  return { serverId: activeServerId };
}
