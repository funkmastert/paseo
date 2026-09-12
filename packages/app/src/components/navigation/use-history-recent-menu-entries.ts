import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { buildNavigationHistoryReplayDeps } from "@/navigation/navigation-history-replay";
import { type NavHistoryEntry, useNavigationHistoryStore } from "@/stores/navigation-history-store";
import { type SessionState, useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import {
  type HistoryRecentTabLabels,
  resolveHistoryRecentEntryLabel,
  selectRecentHistoryEntries,
} from "./history-recent-menu-model";

export interface HistoryRecentMenuItem {
  /** Pass straight to `goBackTo` when the row is selected. */
  depth: number;
  primary: string;
  secondary?: string;
}

function resolveWorkspaceDisplayName(
  entry: NavHistoryEntry,
  sessions: Record<string, SessionState>,
): string | null {
  const workspaces = sessions[entry.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: entry.workspaceId,
  });
  const workspace = workspaceKey ? workspaces?.get(workspaceKey) : undefined;
  return workspace ? (workspace.title ?? workspace.name) : null;
}

function resolveAgentTitle(
  entry: NavHistoryEntry,
  sessions: Record<string, SessionState>,
): string | null {
  if (entry.target?.kind !== "agent") {
    return null;
  }
  const session = sessions[entry.serverId];
  const agent =
    session?.agents.get(entry.target.agentId) ?? session?.agentDetails.get(entry.target.agentId);
  return agent?.title ?? null;
}

/**
 * Assembles the recent-history menu's rows: the pure stack-walking and label-resolution logic in
 * `history-recent-menu-model.ts`, wired to live session state. Shared by the long-press/right-click
 * popover (`history-recent-menu.tsx`) and the command center's "Recent" list contribution, so the
 * two surfaces can't drift on what a row says or where it jumps to.
 */
export function useHistoryRecentMenuEntries(): HistoryRecentMenuItem[] {
  const { t } = useTranslation();
  const backStack = useNavigationHistoryStore((state) => state.backStack);
  const sessions = useSessionStore((state) => state.sessions);

  const labels = useMemo<HistoryRecentTabLabels>(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      terminal: t("workspace.tabs.fallback.terminal"),
      browser: t("workspace.tabs.fallback.browser"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("workspace.tabs.actions.changes"),
      files: t("workspace.tabs.actions.files"),
      pullRequest: t("workspace.tabs.actions.pullRequest"),
      orchestration: t("panels.orchestration.label"),
    }),
    [t],
  );

  return useMemo(() => {
    const { isEntryValid } = buildNavigationHistoryReplayDeps();
    const candidates = selectRecentHistoryEntries(backStack, isEntryValid);
    return candidates.map(({ entry, depth }) => {
      const { primary, secondary } = resolveHistoryRecentEntryLabel({
        entry,
        workspaceDisplayName: resolveWorkspaceDisplayName(entry, sessions),
        agentTitle: resolveAgentTitle(entry, sessions),
        labels,
      });
      return { depth, primary, secondary };
    });
  }, [backStack, labels, sessions]);
}
