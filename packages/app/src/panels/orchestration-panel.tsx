import { useCallback, useMemo, type ReactElement } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Network } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { Alert } from "@/components/ui/alert";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { useSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import {
  definePanel,
  type PanelDescriptor,
  type PanelDescriptorContext,
} from "@/panels/panel-registry";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useArchiveSubagent, useDetachSubagent } from "@/subagents";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import {
  AccountBudgetStrip,
  DEFAULT_REFETCH_INTERVAL_MS,
} from "@/orchestration/account-budget-strip";
import {
  collectFinishedAgentsAcrossRoots,
  collectOrchestrationProviderIds,
  flattenOrchestrationTree,
  resolveOrchestrationRowOpenAction,
  resolveOrchestrationTreeAttention,
  type OrchestrationFlatRow,
} from "@/orchestration/orchestration-panel-model";
import { OrchestrationRow, ROW_ICON_SIZE } from "@/orchestration/orchestration-row";
import { useOrchestrationTree } from "@/orchestration/select";
import { useOrchestrationDirectoryDemand } from "@/orchestration/use-orchestration-directory-demand";
import { useOrchestrationFreshness } from "@/orchestration/use-orchestration-freshness";
import { useArchiveFinishedInTree } from "@/orchestration/use-archive-finished-in-tree";
import { useTokenBurnTones } from "@/hooks/use-token-burn-tones";
import type { TokenBurnSibling } from "@/utils/token-burn-tone-model";

const ThemedNetwork = withUnistyles(Network);
const ThemedArchive = withUnistyles(Archive);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function useOrchestrationPanelDescriptor(
  _target: Extract<WorkspaceTabTarget, { kind: "orchestration" }>,
  context: PanelDescriptorContext,
): PanelDescriptor {
  const { t } = useTranslation();
  const roots = useOrchestrationTree({ serverId: context.serverId });
  const requiresAttention = resolveOrchestrationTreeAttention(roots);
  return {
    label: t("panels.orchestration.label"),
    subtitle: t("panels.orchestration.subtitle"),
    tooltip: t("panels.orchestration.tooltip"),
    titleState: "ready",
    icon: ThemedNetwork,
    statusBucket: requiresAttention ? "attention" : null,
  };
}

/**
 * Says so when the tree has stopped being updated. Without this the panel is indistinguishable
 * from a live one whose agents happen not to have moved — see resolveOrchestrationFreshness.
 */
function OrchestrationStaleNotice({ serverId }: { serverId: string }): ReactElement | null {
  const { t } = useTranslation();
  const { freshness, liveUntil } = useOrchestrationFreshness(serverId);
  const liveUntilLabel = useCompactTimeAgo(liveUntil);
  if (freshness.kind !== "stale") return null;
  return (
    <Alert
      variant="warning"
      testID="orchestration-stale-notice"
      title={t("panels.orchestration.staleTitle")}
      description={
        liveUntilLabel
          ? t("panels.orchestration.staleLastSynced", { time: liveUntilLabel })
          : t("panels.orchestration.staleNeverSynced")
      }
    />
  );
}

function OrchestrationHeader({
  serverId,
  providerIds,
  eligibleFinishedCount,
  archiveFinishedStatus,
  onArchiveFinished,
}: {
  serverId: string;
  providerIds: string[];
  eligibleFinishedCount: number;
  archiveFinishedStatus: ReturnType<typeof useArchiveFinishedInTree>["status"];
  onArchiveFinished: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isArchiving = archiveFinishedStatus.kind === "archiving";
  const isFailed = archiveFinishedStatus.kind === "failed";
  const showArchiveFinished = eligibleFinishedCount > 0 || isArchiving || isFailed;

  return (
    <View style={styles.header}>
      <OrchestrationStaleNotice serverId={serverId} />
      <AccountBudgetStrip
        serverId={serverId}
        providerIds={providerIds}
        refetchIntervalMs={DEFAULT_REFETCH_INTERVAL_MS}
      />
      {showArchiveFinished ? (
        <Pressable
          testID="orchestration-panel-archive-finished"
          accessibilityRole="button"
          accessibilityLabel={t("subagents.archiveFinishedAction")}
          disabled={isArchiving}
          onPress={onArchiveFinished}
          style={styles.archiveFinishedButton}
        >
          {({ hovered, pressed }) => (
            <>
              <ThemedArchive
                size={ROW_ICON_SIZE}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
              <Text style={styles.archiveFinishedLabel} numberOfLines={1}>
                {t("subagents.archiveFinishedAction")}
              </Text>
              {isArchiving ? (
                <Text
                  style={styles.archiveFinishedTrailing}
                  testID="orchestration-archive-progress"
                >
                  {archiveFinishedStatus.completedCount}/{archiveFinishedStatus.totalCount}
                </Text>
              ) : null}
              {isFailed ? (
                <Text style={styles.archiveFinishedTrailing} testID="orchestration-archive-failed">
                  {t("subagents.archiveFinishedRetry", {
                    failed: archiveFinishedStatus.failedCount,
                    total: archiveFinishedStatus.totalCount,
                  })}
                </Text>
              ) : null}
            </>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function OrchestrationPanel(): ReactElement {
  const { t } = useTranslation();
  const { serverId, workspaceId, tabId, target, openTab } = usePaneContext();
  invariant(target.kind === "orchestration", "OrchestrationPanel requires orchestration target");

  // The panel holds the agent-directory subscription itself rather than riding on whichever
  // other screen happens to be mounted — see the hook for why that matters on reconnect.
  useOrchestrationDirectoryDemand(serverId);

  const roots = useOrchestrationTree({ serverId });
  const rows = useMemo(() => flattenOrchestrationTree(roots), [roots]);
  const providerIds = useMemo(() => collectOrchestrationProviderIds(roots), [roots]);

  // Collection rows never independently subscribe to token-rate data — the list owner derives
  // the keyed tone model once (docs/coding-standards.md). useTokenBurnTones owns the hysteresis
  // ref and re-derives on the minute tick, so a badge expires when its rate goes stale even
  // though a quiet fleet sends no row update to trigger a re-render.
  const tokenBurnSiblings = useMemo<TokenBurnSibling[]>(
    () => rows.map((row) => ({ id: row.agent.id, recentTokenRate: row.agent.recentTokenRate })),
    [rows],
  );
  const tokenBurnTones = useTokenBurnTones(tokenBurnSiblings);
  const finishedAgents = useMemo(() => collectFinishedAgentsAcrossRoots(roots), [roots]);
  const archiveFinished = useArchiveFinishedInTree({ serverId, agents: finishedAgents });

  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  // One measurement for the whole list rather than a width read per row.
  const { onLayout, isBelow: isNarrow } = useContainerWidthBelow(ACTIVITY_COLUMN_MIN_WIDTH);
  const archiveAgentRow = useArchiveSubagent({ serverId });
  const detachAgentRow = useDetachSubagent({ serverId });

  const handleOpenAgent = useCallback(
    (agent: Agent) => {
      const action = resolveOrchestrationRowOpenAction(agent, workspaceId);
      switch (action.kind) {
        case "cross-workspace":
          navigateToAgent({ serverId, agentId: agent.id });
          return;
        case "same-workspace":
          if (canSplit && workspaceKey) {
            openPreferredWorkspaceTarget({
              isCompact,
              workspaceKey,
              target: action.target,
              source: "subagents",
              preferences: openInSidePane,
              parentTabId: tabId,
            });
            return;
          }
          openTab(action.target);
          return;
      }
    },
    [canSplit, isCompact, openInSidePane, openTab, serverId, tabId, workspaceId, workspaceKey],
  );

  const renderRow = useCallback(
    ({ item }: { item: OrchestrationFlatRow }) => (
      <OrchestrationRow
        row={item}
        serverId={serverId}
        canDetach={canDetachSubagents}
        canShowActivity={!isNarrow}
        tokenBurnTone={tokenBurnTones.get(item.agent.id)}
        onPress={handleOpenAgent}
        onArchive={archiveAgentRow}
        onDetach={detachAgentRow}
      />
    ),
    [
      archiveAgentRow,
      canDetachSubagents,
      detachAgentRow,
      isNarrow,
      handleOpenAgent,
      serverId,
      tokenBurnTones,
    ],
  );

  const keyExtractor = useCallback((item: OrchestrationFlatRow) => item.agent.id, []);

  return (
    <View style={styles.container} testID="orchestration-panel" onLayout={onLayout}>
      <OrchestrationHeader
        serverId={serverId}
        providerIds={providerIds}
        eligibleFinishedCount={archiveFinished.eligibleCount}
        archiveFinishedStatus={archiveFinished.status}
        onArchiveFinished={archiveFinished.archiveFinished}
      />
      {rows.length === 0 ? (
        <View style={styles.emptyState} testID="orchestration-panel-empty">
          <Text style={styles.emptyStateText}>{t("panels.orchestration.emptyState")}</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          contentContainerStyle={styles.listContent}
        />
      )}
    </View>
  );
}

/**
 * Below this the row drops its activity column. A title, a state and a time fit in a narrow pane;
 * a fourth flexible column there just truncates everything, including the title.
 */
const ACTIVITY_COLUMN_MIN_WIDTH = 480;

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  header: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  archiveFinishedButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1],
  },
  archiveFinishedLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  archiveFinishedTrailing: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  listContent: {
    paddingVertical: theme.spacing[2],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));

export const orchestrationPanelRegistration = definePanel("orchestration", {
  component: OrchestrationPanel,
  useDescriptor: useOrchestrationPanelDescriptor,
});
