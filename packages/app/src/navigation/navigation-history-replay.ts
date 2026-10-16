import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type {
  NavHistoryEntry,
  NavigationHistoryReplayDeps,
} from "@/stores/navigation-history-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * Concrete deps for `goBack`/`goForward`, kept out of navigation-history-store
 * itself so that store stays a one-directional leaf: it reads nothing from
 * session-store/workspace-layout-store/navigation-active-workspace-store, and
 * this is the only module that wires it to them.
 */
function isEntryValid(entry: NavHistoryEntry): boolean {
  const workspaces = useSessionStore.getState().sessions[entry.serverId]?.workspaces;
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: entry.workspaceId,
  });
  if (!resolvedWorkspaceId) {
    return false;
  }
  if (!entry.target) {
    return true;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: entry.serverId,
    workspaceId: resolvedWorkspaceId,
  });
  if (!workspaceKey) {
    return false;
  }
  const target = entry.target;
  const tabs = useWorkspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey);
  return tabs.some((tab) => workspaceTabTargetsEqual(tab.target, target));
}

function replay(entry: NavHistoryEntry): void {
  navigateToWorkspace({
    serverId: entry.serverId,
    workspaceId: entry.workspaceId,
    target: entry.target,
    fromHistoryReplay: true,
  });
}

export function buildNavigationHistoryReplayDeps(): NavigationHistoryReplayDeps {
  return { isEntryValid, replay };
}
