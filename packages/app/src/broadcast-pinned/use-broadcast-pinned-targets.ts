import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  selectBroadcastPinnedLeaderTargets,
  type BroadcastPinnedAgentCandidate,
  type BroadcastPinnedTarget,
} from "./broadcast-pinned-targets";

export interface BroadcastPinnedTargets {
  targets: BroadcastPinnedTarget[];
  hasTargets: boolean;
}

/**
 * Every pinned leader agent across every connected host, reusing the sidebar's own Pinned
 * projection (`useSidebarModel`) rather than a second notion of "pinned". Requires a
 * `SidebarModelProvider` ancestor.
 *
 * The store selector only reads the per-server `agents` Map references (O(hosts) via
 * `useShallow`) — it never walks agent contents, so it stays cheap on every session-store tick,
 * including streaming ticks, per docs/coding-standards.md's hot-selector rule. `setAgents`
 * replaces that Map wholesale on any agent change and keeps the old reference otherwise, so a
 * Map reference is exactly the "did this server's agents change" signal. The actual per-agent
 * scan happens once, in the `useMemo` below, only when a watched Map reference changes.
 */
export function useBroadcastPinnedTargets(): BroadcastPinnedTargets {
  const { pinnedGroups } = useSidebarModel();
  const daemons = useHosts();
  const serverIds = useMemo(() => daemons.map((daemon) => daemon.serverId), [daemons]);

  const agentMaps = useSessionStore(
    useShallow((state) => serverIds.map((serverId) => state.sessions[serverId]?.agents)),
  );

  const agents = useMemo(() => {
    const result: BroadcastPinnedAgentCandidate[] = [];
    for (const agentsById of agentMaps) {
      if (!agentsById) continue;
      for (const agent of agentsById.values()) {
        result.push(agent);
      }
    }
    return result;
  }, [agentMaps]);

  const targets = useMemo(
    () => selectBroadcastPinnedLeaderTargets({ pinnedChats: pinnedGroups.pinnedChats, agents }),
    [pinnedGroups.pinnedChats, agents],
  );

  return { targets, hasTargets: targets.length > 0 };
}
