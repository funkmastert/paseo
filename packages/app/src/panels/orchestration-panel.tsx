import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { FlatList, Pressable, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Network, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { getProviderIcon } from "@/components/provider-icons";
import { RowActionButton } from "@/components/row-action-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { TokenBurnBadge } from "@/components/token-burn-badge";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
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
import { getStatusDotColor } from "@/utils/status-dot-color";
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
import { useOrchestrationTree } from "@/orchestration/select";
import { useArchiveFinishedInTree } from "@/orchestration/use-archive-finished-in-tree";
import {
  deriveTokenBurnTones,
  type TokenBurnSibling,
  type TokenBurnTone,
} from "@/utils/token-burn-tone-model";

const ThemedNetwork = withUnistyles(Network);
const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Resolves the row's provider icon dynamically (per agent), themed the same way as
 * account-budget-strip.tsx's AccountUsageIcon — `getProviderIcon` returns a different component
 * per provider/server, so it can't be a module-scope `withUnistyles` wrapper by itself. */
function OrchestrationRowProviderIcon({
  provider,
  serverId,
  size,
  color = "",
}: {
  provider: string;
  serverId: string;
  size: number;
  color?: string;
}) {
  const Icon = getProviderIcon(provider, serverId);
  return <Icon size={size} color={color} />;
}
const ThemedOrchestrationRowProviderIcon = withUnistyles(OrchestrationRowProviderIcon);

/** Indent step per generation, capped — see docs/design.md §12; deep fan-outs stay legible. */
const INDENT_PER_LEVEL = 16;
const MAX_INDENT_LEVELS = 4;
const ROW_ICON_SIZE = 14;

// Plain react-native StyleSheet, not Unistyles: these widths are static (not theme-dependent), and
// a raw per-row inline `{ width }` object would each hash into its own persisted web CSS class —
// see docs/unistyles.md "Dynamic Pixel Styles On Web". A fixed, small set of depth styles avoids
// that entirely.
const INDENT_STYLES = RNStyleSheet.create({
  depth0: { width: 0 },
  depth1: { width: INDENT_PER_LEVEL },
  depth2: { width: INDENT_PER_LEVEL * 2 },
  depth3: { width: INDENT_PER_LEVEL * 3 },
  depth4: { width: INDENT_PER_LEVEL * 4 },
});
const INDENT_STYLE_LIST = [
  INDENT_STYLES.depth0,
  INDENT_STYLES.depth1,
  INDENT_STYLES.depth2,
  INDENT_STYLES.depth3,
  INDENT_STYLES.depth4,
];

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

interface OrchestrationRowProps {
  row: OrchestrationFlatRow;
  serverId: string;
  canDetach: boolean;
  tokenBurnTone?: TokenBurnTone;
  onPress: (agent: Agent) => void;
  onArchive: (agentId: string) => void;
  onDetach: (agentId: string) => void;
}

function OrchestrationRow({
  row,
  serverId,
  canDetach,
  tokenBurnTone,
  onPress,
  onArchive,
  onDetach,
}: OrchestrationRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { agent } = row;
  const relativeTime = useCompactTimeAgo(agent.updatedAt);
  const indentStyle = INDENT_STYLE_LIST[Math.min(row.depth, MAX_INDENT_LEVELS)];
  const displayTitle = agent.title?.trim() || t("agentList.fallbackTitle");
  const actionsAlwaysVisible = isNative || isCompact;

  // Hover on a plain View, press on a separate inner Pressable — per docs/hover.md. The row
  // reveals nested action Pressables (archive/detach) on hover; tracking hover on the Pressable
  // itself would fight those inner Pressables for hover state (Failure Mode 1 in that doc).
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => onPress(agent), [agent, onPress]);
  const handleArchive = useCallback(() => onArchive(agent.id), [agent.id, onArchive]);
  const handleDetach = useCallback(() => onDetach(agent.id), [agent.id, onDetach]);

  const actionsVisible = actionsAlwaysVisible || isHovered;
  // Depth 0 is a tree root — nothing to detach it from — so the action never renders there even
  // when the feature is enabled.
  const showDetach = canDetach && row.depth > 0;

  return (
    <View onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
      <Pressable
        testID={`orchestration-row-${agent.id}`}
        accessibilityRole="button"
        accessibilityLabel={displayTitle}
        onPress={handlePress}
        style={styles.row}
      >
        <View style={indentStyle} />
        <AgentStatusDot
          status={agent.status}
          requiresAttention={agent.requiresAttention}
          attentionReason={agent.attentionReason}
          pendingPermissionCount={agent.pendingPermissions.length}
        />
        {row.descendantRequiresAttention ? (
          <View
            style={styles.rollupDot}
            testID={`orchestration-rollup-${agent.id}`}
            accessibilityLabel={t("agentList.badges.attention")}
          />
        ) : null}
        <ThemedOrchestrationRowProviderIcon
          provider={agent.provider}
          serverId={serverId}
          size={ROW_ICON_SIZE}
          uniProps={foregroundMutedColorMapping}
        />
        <Text style={styles.title} numberOfLines={1}>
          {displayTitle}
        </Text>
        {agent.requiresAttention ? (
          <StatusBadge label={t("agentList.badges.attention")} variant="error" />
        ) : null}
        {tokenBurnTone ? (
          <TokenBurnBadge
            tone={tokenBurnTone}
            tokensPerMinute={agent.recentTokenRate?.tokensPerMinute ?? 0}
            totalTokens={agent.totalTokens}
            testID={`orchestration-token-burn-${agent.id}`}
          />
        ) : null}
        {agent.lastActivitySummary ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {agent.lastActivitySummary}
          </Text>
        ) : null}
        {agent.model ? (
          <Text style={styles.model} numberOfLines={1}>
            {agent.model}
          </Text>
        ) : null}
        <Text style={styles.time} numberOfLines={1}>
          {relativeTime}
        </Text>
        <View
          style={actionsVisible ? styles.actionsVisible : styles.actionsHidden}
          pointerEvents={actionsVisible ? "auto" : "none"}
        >
          {showDetach ? (
            <RowActionButton
              accessibilityLabel={t("subagents.detachAction", { label: displayTitle })}
              testID={`orchestration-detach-${agent.id}`}
              tooltipLabel={t("subagents.detachTooltip")}
              visible={actionsVisible}
              onPress={handleDetach}
            >
              {(active) => (
                <ThemedUnlink
                  size={ROW_ICON_SIZE}
                  uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </RowActionButton>
          ) : null}
          <RowActionButton
            accessibilityLabel={t("subagents.archiveAction", { label: displayTitle })}
            testID={`orchestration-archive-${agent.id}`}
            tooltipLabel={t("subagents.archiveTooltip")}
            visible={actionsVisible}
            onPress={handleArchive}
          >
            {(active) => (
              <ThemedArchive
                size={ROW_ICON_SIZE}
                uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            )}
          </RowActionButton>
        </View>
      </Pressable>
    </View>
  );
}

function OrchestrationPanel(): ReactElement {
  const { t } = useTranslation();
  const { serverId, workspaceId, tabId, target, openTab } = usePaneContext();
  invariant(target.kind === "orchestration", "OrchestrationPanel requires orchestration target");

  const roots = useOrchestrationTree({ serverId });
  const rows = useMemo(() => flattenOrchestrationTree(roots), [roots]);
  const providerIds = useMemo(() => collectOrchestrationProviderIds(roots), [roots]);

  // Collection rows never independently subscribe to token-rate data — the list owner derives
  // the keyed tone model once per render (docs/coding-standards.md). previousTonesRef persists
  // across renders so deriveTokenBurnTones can apply enter/exit hysteresis.
  const previousTokenBurnTonesRef = useRef<ReadonlyMap<string, TokenBurnTone>>(new Map());
  const tokenBurnTones = useMemo(() => {
    const siblings: TokenBurnSibling[] = rows.map((row) => ({
      id: row.agent.id,
      recentTokenRate: row.agent.recentTokenRate,
    }));
    const next = deriveTokenBurnTones(siblings, previousTokenBurnTonesRef.current, Date.now());
    previousTokenBurnTonesRef.current = next;
    return next;
  }, [rows]);
  const finishedAgents = useMemo(() => collectFinishedAgentsAcrossRoots(roots), [roots]);
  const archiveFinished = useArchiveFinishedInTree({ serverId, agents: finishedAgents });

  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
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
      handleOpenAgent,
      serverId,
      tokenBurnTones,
    ],
  );

  const keyExtractor = useCallback((item: OrchestrationFlatRow) => item.agent.id, []);

  return (
    <View style={styles.container} testID="orchestration-panel">
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

const styles = StyleSheet.create((theme) => {
  const attentionDotColor =
    getStatusDotColor({ theme, bucket: "attention" }) ?? theme.colors.statusDotSuccess;
  return {
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
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      minHeight: 36,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
    },
    rollupDot: {
      width: 5,
      height: 5,
      borderRadius: theme.borderRadius.full,
      backgroundColor: attentionDotColor,
      opacity: 0.55,
    },
    title: {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: "auto",
      minWidth: 0,
      fontSize: theme.fontSize.base,
      color: theme.colors.foreground,
    },
    subtitle: {
      flexShrink: 2,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    model: {
      flexShrink: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    time: {
      flexShrink: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    actionsVisible: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      opacity: 1,
    },
    actionsHidden: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      opacity: 0,
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
  };
});

export const orchestrationPanelRegistration = definePanel("orchestration", {
  component: OrchestrationPanel,
  useDescriptor: useOrchestrationPanelDescriptor,
});
