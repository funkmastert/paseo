import { ExternalLink } from "lucide-react-native";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AgentIdChip } from "@/components/agent-id-chip";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { pickPinnedWorkspaceAgentId } from "@/pinned-grid/resolve-pinned-agent";
import { PinnedGridStatusDot } from "@/pinned-grid/pinned-grid-status-dot";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { Theme } from "@/styles/theme";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const NO_AGENTS: never[] = [];

interface PinnedGridCellProps {
  workspace: SidebarWorkspaceEntry;
  focused: boolean;
  /** A touch anywhere in the cell makes it the focused one. */
  onFocus: (workspaceKey: string) => void;
}

/**
 * One pinned chat, mounted as the same agent panel a workspace tab renders: it streams, shows
 * its own status, and takes input through its own composer. Nothing about the chat is copied.
 */
export const PinnedGridCell = memo(function PinnedGridCell({
  workspace,
  focused,
  onFocus,
}: PinnedGridCellProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const { serverId, workspaceId, workspaceKey } = workspace;
  const label = resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource });

  const agentId = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      pickPinnedWorkspaceAgentId({
        agents: state.sessions[serverId]?.agents?.values() ?? NO_AGENTS,
        workspaceId,
      }),
    Object.is,
  );

  // The workspace screen tells the timeline sync which agents are on screen so their streams stay
  // live. A cell is on screen for as long as it is mounted, so it reports its own chat under a
  // source id of its own, and the workspace screen's report for the same host is left alone.
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  useEffect(() => {
    if (!agentId) {
      return;
    }
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, agentId)
      .catch(() => undefined);
  }, [agentId, serverId]);
  useLayoutEffect(() => {
    if (!viewedTimelineSync) {
      return;
    }
    const sourceId = `pinned-grid:${workspaceKey}`;
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, agentId ? [agentId] : []);
    return () => viewedTimelineSync.replaceVisibleAgentIds(sourceId, []);
  }, [agentId, viewedTimelineSync, workspaceKey]);

  const agentsHydrated = useSessionStore((state) => state.sessions[serverId]?.hasHydratedAgents);

  const openInWorkspace = useCallback(
    (target?: WorkspaceTabTarget) => {
      navigateToWorkspace({ serverId, workspaceId, target });
    },
    [serverId, workspaceId],
  );
  const handleOpenWorkspace = useCallback(() => {
    openInWorkspace(agentId ? { kind: "agent", agentId } : undefined);
  }, [agentId, openInWorkspace]);
  const handleOpenTarget = useCallback(
    (target: WorkspaceTabTarget) => openInWorkspace(target),
    [openInWorkspace],
  );
  const handleFocus = useCallback(() => onFocus(workspaceKey), [onFocus, workspaceKey]);
  const handleCaptureResponder = useCallback(() => {
    // Observes the touch without claiming it, so the transcript and composer still receive it.
    onFocus(workspaceKey);
    return false;
  }, [onFocus, workspaceKey]);

  const content = useMemo(() => {
    if (!agentId) {
      return null;
    }
    const target: WorkspaceTabTarget = { kind: "agent", agentId };
    const tabId = buildDeterministicWorkspaceTabId(target);
    const tab: WorkspaceTabDescriptor = { key: tabId, tabId, kind: "agent", target };
    return buildWorkspacePaneContentModel({
      tab,
      normalizedServerId: serverId,
      normalizedWorkspaceId: workspaceId,
      host: "main",
      // The grid has no tab strip or layout of its own. Anything a chat asks the workspace to open
      // — a file, a diff, a side pane — opens in the workspace itself, and leaves the grid.
      onOpenTab: handleOpenTarget,
      onOpenPreferredTarget: handleOpenTarget,
      onCloseCurrentTab: noop,
      onRetargetCurrentTab: noop,
      onSetCurrentTabState: noop,
      onOpenWorkspaceFile: handleOpenWorkspace,
      onOpenImportSheet: noop,
    });
  }, [agentId, handleOpenTarget, handleOpenWorkspace, serverId, workspaceId]);

  return (
    <View
      style={styles.cell}
      onStartShouldSetResponderCapture={handleCaptureResponder}
      testID={`pinned-grid-cell-${workspaceKey}`}
    >
      <View style={[styles.header, focused && styles.headerFocused]}>
        <PinnedGridStatusDot bucket={workspace.statusBucket} />
        <View style={styles.titleColumn}>
          <Text style={styles.title} numberOfLines={1}>
            {label}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {workspace.projectName}
          </Text>
          {agentId ? (
            <AgentIdChip agentId={agentId} testID={`agent-id-chip-${workspaceKey}`} />
          ) : null}
        </View>
        <ToolbarButton
          compact={isCompact}
          label={t("pinnedGrid.openWorkspace")}
          onPress={handleOpenWorkspace}
          testID={`pinned-grid-open-${workspaceKey}`}
        >
          <ThemedExternalLink
            size={paneContentToolbarIconSize(isCompact)}
            strokeWidth={1.5}
            uniProps={mutedIconColorMapping}
          />
        </ToolbarButton>
      </View>
      <View style={styles.body}>
        {content ? (
          <WorkspacePaneContent
            content={content}
            isWorkspaceFocused
            isPaneFocused={focused}
            onFocusPane={handleFocus}
          />
        ) : (
          <View style={styles.empty}>
            {agentsHydrated ? (
              <Text style={styles.emptyText}>{t("pinnedGrid.noChat")}</Text>
            ) : (
              <ThemedLoadingSpinner size="small" uniProps={spinnerColorMapping} />
            )}
          </View>
        )}
      </View>
    </View>
  );
});

function noop() {}

const styles = StyleSheet.create((theme) => ({
  cell: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  header: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerFocused: {
    backgroundColor: theme.colors.surface1,
  },
  titleColumn: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  subtitle: {
    flexShrink: 2,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
