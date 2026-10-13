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
 */
export function useBroadcastPinnedTargets(): BroadcastPinnedTargets {
  const { pinnedGroups } = useSidebarModel();
  const daemons = useHosts();
  const serverIds = useMemo(() => daemons.map((daemon) => daemon.serverId), [daemons]);

  const agents = useSessionStore(
    useShallow((state) => {
      const result: BroadcastPinnedAgentCandidate[] = [];
      for (const serverId of serverIds) {
        const session = state.sessions[serverId];
        if (!session) continue;
        for (const agent of session.agents.values()) {
          result.push(agent);
        }
      }
      return result;
    }),
  );

  const targets = useMemo(
    () => selectBroadcastPinnedLeaderTargets({ pinnedChats: pinnedGroups.pinnedChats, agents }),
    [pinnedGroups.pinnedChats, agents],
  );

  return { targets, hasTargets: targets.length > 0 };
}
