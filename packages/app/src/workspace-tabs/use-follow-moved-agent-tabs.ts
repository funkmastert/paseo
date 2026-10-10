import { useEffect, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { announceAgentMove } from "@/stores/agent-move-notice-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { heldAgentLookup } from "@/utils/agent-migration";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import {
  decideMovedAgentTabActions,
  movedAgentTabStepsEqual,
  planMovedAgentTabs,
} from "@/workspace-tabs/moved-agent-tabs";

/**
 * Tabs on a handle account failover retired show its live end instead (docs/account-failover.md).
 * The decisions live in `decideMovedAgentTabActions`; this hook only carries them out.
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
  const { serverId, workspaceId, workspaceKey, routeFocused, layoutHydrated, tabs, focusedTabId } =
    input;
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
  const moveDraft = useDraftStore((state) => state.moveDraft);
  const notedStrandedRef = useRef(new Set<string>());

  useEffect(() => {
    const actions = decideMovedAgentTabActions({
      steps,
      routeFocused,
      layoutHydrated,
      workspaceKey,
      focusedTabId,
      notedStrandedAgentIds: notedStrandedRef.current,
    });
    for (const action of actions) {
      switch (action.kind) {
        case "moveDraft":
          moveDraft({
            fromKey: buildDraftStoreKey({ serverId, agentId: action.fromAgentId }),
            toKey: buildDraftStoreKey({ serverId, agentId: action.toAgentId }),
          });
          break;
        case "follow":
          followMovedAgent(action.workspaceKey, action.fromAgentId, action.toAgentId);
          break;
        case "closeTab":
          closeTab(action.workspaceKey, action.tabId);
          break;
        case "navigateToAgent":
          navigateToAgent({ serverId, agentId: action.agentId });
          break;
        case "announce":
          announceAgentMove({ serverId, agentId: action.agentId });
          break;
        case "noteStranded":
          notedStrandedRef.current.add(action.agentId);
          break;
      }
    }
  }, [
    closeTab,
    focusedTabId,
    followMovedAgent,
    layoutHydrated,
    moveDraft,
    routeFocused,
    serverId,
    steps,
    workspaceKey,
  ]);
}
