import { useEffect, useMemo, useRef } from "react";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  buildPinnedAgentOptions,
  findPinnedWorkspacesMissingAgents,
  selectPinnedWorkspacesForServer,
  type AskJevAgentOption,
} from "./ask-jev-agent-options";

export interface AskJevPinnedAgents {
  options: AskJevAgentOption[];
  hasPinnedWorkspaces: boolean;
}

/**
 * The agent threads Ask JEV may attach: one per live agent in a pinned chat on the given host,
 * reusing the sidebar's own Pinned projection (`useSidebarModel`) rather than a second notion of
 * "pinned". Requires a `SidebarModelProvider` ancestor.
 */
export function useAskJevPinnedAgents(serverId: string | null): AskJevPinnedAgents {
  const { pinnedGroups } = useSidebarModel();
  const { agents } = useAggregatedAgents();

  const pinnedWorkspaces = useMemo(
    () => selectPinnedWorkspacesForServer(pinnedGroups.pinnedChats, serverId),
    [pinnedGroups.pinnedChats, serverId],
  );

  const missingWorkspaceIds = useMemo(
    () => findPinnedWorkspacesMissingAgents({ pinnedWorkspaces, agents }),
    [pinnedWorkspaces, agents],
  );

  // One best-effort unscoped refresh per distinct gap, so a pinned chat whose workspace was
  // archived by housekeeping still loads — see findPinnedWorkspacesMissingAgents. The key tracks
  // only the IN-FLIGHT request, not every attempt ever made: the ordinary scope:"active" demand
  // refresh can later re-evict this same agent on a full-snapshot resync (a reconnect without a
  // live directory-sync cursor), reproducing the same missing-workspace set, so a gap that was
  // already "fixed" once must still be eligible to retry once the fetch that fixed it settles.
  const pendingKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!serverId || missingWorkspaceIds.length === 0) return;
    const key = `${serverId}:${[...missingWorkspaceIds].sort().join(",")}`;
    if (pendingKeyRef.current === key) return;
    pendingKeyRef.current = key;
    void getHostRuntimeStore()
      .refreshAgentDirectory({ serverId, filter: {} })
      .catch(() => undefined)
      .finally(() => {
        if (pendingKeyRef.current === key) pendingKeyRef.current = null;
      });
  }, [serverId, missingWorkspaceIds]);

  const options = useMemo(
    () => buildPinnedAgentOptions({ pinnedWorkspaces, agents }),
    [pinnedWorkspaces, agents],
  );

  return { options, hasPinnedWorkspaces: pinnedWorkspaces.length > 0 };
}
