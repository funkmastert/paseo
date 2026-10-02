import { useEffect, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { announceAgentMove } from "@/stores/agent-move-notice-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { heldAgentLookup } from "@/utils/agent-migration";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { movedAgentTabStepsEqual, planMovedAgentTabs } from "@/workspace-tabs/moved-agent-tabs";

/**
 * Tabs on a handle account failover retired show its live end instead (docs/account-failover.md).
 * The note is raised for the focused tab only: that is the one the user is looking at.
 */
export function useFollowMovedAgentTabs(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
  routeFocused: boolean;
  layoutHydrated: boolean;
  tabs: readonly WorkspaceTab[];
  focusedTabId: string | null;
}): void {
  const { serverId, workspaceId, workspaceKey, tabs, focusedTabId } = input;
  const enabled = input.routeFocused && input.layoutHydrated;
  const steps = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      planMovedAgentTabs({
        tabs,
        workspaceId,
        lookup: heldAgentLookup(state.sessions[serverId]),
      }),
    movedAgentTabStepsEqual,
  );
  const followMovedAgent = useWorkspaceLayoutStore((state) => state.followMovedAgent);
  const closeTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const notedStrandedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !workspaceKey) {
      return;
    }
    for (const step of steps) {
      const focused = step.tabId === focusedTabId;
      if (step.kind === "retarget") {
        followMovedAgent(workspaceKey, step.fromAgentId, step.toAgentId);
        if (focused) {
          announceAgentMove({ serverId, agentId: step.toAgentId });
        }
      } else if (step.kind === "navigate") {
        // Only the tab in view leaves the workspace; a background one waits until it is chosen.
        if (focused) {
          closeTab(workspaceKey, step.tabId);
          navigateToAgent({ serverId, agentId: step.fromAgentId });
        }
      } else if (focused && !notedStrandedRef.current.has(step.fromAgentId)) {
        notedStrandedRef.current.add(step.fromAgentId);
        announceAgentMove({ serverId, agentId: step.movedToAgentId });
      }
    }
  }, [closeTab, enabled, focusedTabId, followMovedAgent, serverId, steps, workspaceKey]);
}
