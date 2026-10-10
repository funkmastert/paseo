import { useCallback, useMemo, useState, type ReactElement } from "react";
import { FlatList, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
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
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import {
  AccountBudgetStrip,
  DEFAULT_REFETCH_INTERVAL_MS,
} from "@/orchestration/account-budget-strip";
import { countAccountUsage } from "@/orchestration/account-budget-strip-model";
import {
  collectFinishedAgentsAcrossRoots,
  flattenOrchestrationTree,
  resolveOrchestrationRowOpenAction,
  resolveOrchestrationTreeAttention,
  type OrchestrationFlatRow,
} from "@/orchestration/orchestration-panel-model";
import {
  OrchestrationHeaderControls,
  type OrchestrationScopeValue,
} from "@/orchestration/orchestration-header-controls";
import { OrchestrationRow } from "@/orchestration/orchestration-row";
import {
  resolveOrchestrationScope,
  resolveScopedLeaderAgent,
  selectScopedOrchestrationRoots,
} from "@/orchestration/orchestration-scope";
import { useOrchestrationTree } from "@/orchestration/select";
import { useOrchestrationDirectoryDemand } from "@/orchestration/use-orchestration-directory-demand";
import { useOrchestrationFreshness } from "@/orchestration/use-orchestration-freshness";
import { useOrchestrationVisibleRows } from "@/orchestration/use-orchestration-visible-rows";
import { useArchiveFinishedInTree } from "@/orchestration/use-archive-finished-in-tree";
import { useTokenBurnTones } from "@/hooks/use-token-burn-tones";
import type { TokenBurnSibling } from "@/utils/token-burn-tone-model";

const ThemedNetwork = withUnistyles(Network);

/**
 * The leader a host-wide tab came from, so switching scope is a two-way control rather than a
 * door that locks behind you. Tab state survives a same-kind retarget, which is what a scope
 * switch is.
 */
function readLastScopeAgentId(state: JsonValue | undefined): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = (state as Record<string, JsonValue | undefined>).lastScopeAgentId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function useOrchestrationPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "orchestration" }>,
  context: PanelDescriptorContext,
): PanelDescriptor {
  const { t } = useTranslation();
  const roots = useOrchestrationTree({ serverId: context.serverId });
  const scope = useMemo(
    () => resolveOrchestrationScope(target.scopeAgentId),
    [target.scopeAgentId],
  );
  const scopedRoots = useMemo(() => selectScopedOrchestrationRoots(roots, scope), [roots, scope]);
  const leader = resolveScopedLeaderAgent(roots, scope);
  // A scoped tab badges for its own tree only: an unrelated fleet's permission request is not
  // this tab's business, and a mark that is never about what the tab shows stops being read.
  const requiresAttention = resolveOrchestrationTreeAttention(scopedRoots);
  return {
    label: t("panels.orchestration.label"),
    subtitle:
      scope.kind === "all"
        ? t("panels.orchestration.subtitleAll")
        : leader?.title?.trim() || t("panels.orchestration.subtitleLeader"),
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

/**
 * What the panel says when it has no rows to draw. The three cases are different facts: a scoped
 * tree that no longer exists, a fleet the window has emptied, and a host with no agents at all.
 * Reporting the second as "no agents" is how someone concludes their agent vanished.
 */
function OrchestrationEmptyState({
  isScoped,
  hasScopedTree,
  hiddenCount,
}: {
  isScoped: boolean;
  hasScopedTree: boolean;
  hiddenCount: number;
}): ReactElement {
  const { t } = useTranslation();
  let message: string;
  if (isScoped && !hasScopedTree) {
    message = t("panels.orchestration.scopeMissing");
  } else if (hiddenCount > 0) {
    message = t("panels.orchestration.emptyStateFiltered", { count: hiddenCount });
  } else {
    message = t("panels.orchestration.emptyState");
  }
  return (
    <View style={styles.emptyState} testID="orchestration-panel-empty">
      <Text style={styles.emptyStateText}>{message}</Text>
    </View>
  );
}

function OrchestrationPanel(): ReactElement {
  const {
    serverId,
    workspaceId,
    tabId,
    target,
    state,
    openTab,
    retargetCurrentTab,
    setCurrentTabState,
  } = usePaneContext();
  invariant(target.kind === "orchestration", "OrchestrationPanel requires orchestration target");

  // The panel holds the agent-directory subscription itself rather than riding on whichever
  // other screen happens to be mounted — see the hook for why that matters on reconnect.
  useOrchestrationDirectoryDemand(serverId);

  const scope = useMemo(
    () => resolveOrchestrationScope(target.scopeAgentId),
    [target.scopeAgentId],
  );
  const allRoots = useOrchestrationTree({ serverId });
  const roots = useMemo(() => selectScopedOrchestrationRoots(allRoots, scope), [allRoots, scope]);
  const allRows = useMemo(() => flattenOrchestrationTree(roots), [roots]);
  const [isShowingOlder, setIsShowingOlder] = useState(false);
  const { rows, hiddenCount } = useOrchestrationVisibleRows(allRows, {
    showOlder: isShowingOlder,
    alwaysKeepAgentId: target.scopeAgentId ?? null,
  });
  // The strip's indicator is about this tab: its own tree, so a tab scoped to one leader counts
  // that leader (idle or not) and only the workers under it, not the whole host's.
  const accountUsage = useMemo(
    () => countAccountUsage(allRows, { includeIdleLeaders: scope.kind !== "all" }),
    [allRows, scope.kind],
  );

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
    (state_) => state_.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  // One measurement for the whole list rather than a width read per row.
  const { onLayout, isBelow: isNarrow } = useContainerWidthBelow(ACTIVITY_COLUMN_MIN_WIDTH);
  const archiveAgentRow = useArchiveSubagent({ serverId });
  const detachAgentRow = useDetachSubagent({ serverId });

  const rememberedScopeAgentId = target.scopeAgentId ?? readLastScopeAgentId(state);
  const handleScopeChange = useCallback(
    (next: OrchestrationScopeValue) => {
      if (next === "all") {
        if (target.scopeAgentId) {
          // Written before the retarget so the same-kind replacement carries it forward — it is
          // the only record of which tree this tab came from.
          setCurrentTabState({ lastScopeAgentId: target.scopeAgentId });
        }
        retargetCurrentTab({ kind: "orchestration" });
        return;
      }
      if (!rememberedScopeAgentId) return;
      retargetCurrentTab({ kind: "orchestration", scopeAgentId: rememberedScopeAgentId });
    },
    [rememberedScopeAgentId, retargetCurrentTab, setCurrentTabState, target.scopeAgentId],
  );
  const handleToggleOlder = useCallback(() => setIsShowingOlder((previous) => !previous), []);

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
      <View style={styles.header}>
        <OrchestrationStaleNotice serverId={serverId} />
        <AccountBudgetStrip
          serverId={serverId}
          usage={accountUsage}
          refetchIntervalMs={DEFAULT_REFETCH_INTERVAL_MS}
        />
        <OrchestrationHeaderControls
          scope={scope.kind === "all" ? "all" : "leader"}
          canScopeToLeader={Boolean(rememberedScopeAgentId)}
          onScopeChange={handleScopeChange}
          eligibleFinishedCount={archiveFinished.eligibleCount}
          archiveFinishedStatus={archiveFinished.status}
          onArchiveFinished={archiveFinished.archiveFinished}
          hiddenCount={hiddenCount}
          isShowingOlder={isShowingOlder}
          onToggleOlder={handleToggleOlder}
        />
      </View>
      {rows.length === 0 ? (
        <OrchestrationEmptyState
          isScoped={scope.kind === "leader"}
          hasScopedTree={roots.length > 0}
          hiddenCount={hiddenCount}
        />
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
