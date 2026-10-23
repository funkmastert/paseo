import { useMemo } from "react";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

/**
 * Resolves "the active host" for a surface with no host picker of its own: the connected local
 * daemon, else the first connected host. Shared by every feature that scopes to one host this way
 * (mcp-status, device-status, restart-recovery, token-usage) so they can't pick different hosts
 * if the active-host rule ever changes.
 */
export function useActiveHostServerId(): string | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId,
        hosts,
        orderedHosts,
      }),
    [localServerId, hosts, orderedHosts],
  );
}
