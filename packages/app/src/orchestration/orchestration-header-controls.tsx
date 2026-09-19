import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ArchiveFinishedStatus } from "@/subagents/archive-finished";
import type { Theme } from "@/styles/theme";
import { ROW_ICON_SIZE } from "./orchestration-row";

const ThemedArchive = withUnistyles(Archive);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type OrchestrationScopeValue = "leader" | "all";

export interface OrchestrationHeaderControlsProps {
  scope: OrchestrationScopeValue;
  /**
   * Whether there is a leader to scope to. False only on a host-wide tab that was never scoped,
   * where a two-way control would offer a destination that does not exist.
   */
  canScopeToLeader: boolean;
  onScopeChange: (scope: OrchestrationScopeValue) => void;
  eligibleFinishedCount: number;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  /** Rows the recency window dropped. Always shown — a filtered list must say it is filtered. */
  hiddenCount: number;
  isShowingOlder: boolean;
  onToggleOlder: () => void;
}

/**
 * The panel's own controls: which slice of the fleet it is showing, and what it is holding back.
 *
 * Separate from the panel shell because the shell's other header content (the budget strip, the
 * stale notice) needs a live host, and these two controls are the whole of what changed about the
 * panel's presentation — the fleet-scale capture renders them beside the rows.
 */
export function OrchestrationHeaderControls({
  scope,
  canScopeToLeader,
  onScopeChange,
  eligibleFinishedCount,
  archiveFinishedStatus,
  onArchiveFinished,
  hiddenCount,
  isShowingOlder,
  onToggleOlder,
}: OrchestrationHeaderControlsProps): ReactElement | null {
  const { t } = useTranslation();
  const isArchiving = archiveFinishedStatus.kind === "archiving";
  const isFailed = archiveFinishedStatus.kind === "failed";
  const showArchiveFinished = eligibleFinishedCount > 0 || isArchiving || isFailed;
  const scopeOptions = useMemo(
    () => [
      {
        value: "leader" as const,
        label: t("panels.orchestration.scopeLeader"),
        testID: "orchestration-scope-leader",
      },
      {
        value: "all" as const,
        label: t("panels.orchestration.scopeAll"),
        testID: "orchestration-scope-all",
      },
    ],
    [t],
  );
  const handleScopeChange = useCallback(
    (value: OrchestrationScopeValue) => onScopeChange(value),
    [onScopeChange],
  );

  if (!canScopeToLeader && !showArchiveFinished && hiddenCount === 0 && !isShowingOlder) {
    return null;
  }

  return (
    <View style={styles.container}>
      {canScopeToLeader ? (
        <SegmentedControl
          size="xs"
          testID="orchestration-scope-control"
          options={scopeOptions}
          value={scope}
          onValueChange={handleScopeChange}
        />
      ) : null}
      {showArchiveFinished || hiddenCount > 0 || isShowingOlder ? (
        <View style={styles.buttonRow}>
          {showArchiveFinished ? (
            <Pressable
              testID="orchestration-panel-archive-finished"
              accessibilityRole="button"
              accessibilityLabel={t("subagents.archiveFinishedAction")}
              disabled={isArchiving}
              onPress={onArchiveFinished}
              style={styles.headerButton}
            >
              {({ hovered, pressed }) => (
                <>
                  <ThemedArchive
                    size={ROW_ICON_SIZE}
                    uniProps={
                      hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                    }
                  />
                  <Text style={styles.headerButtonLabel} numberOfLines={1}>
                    {t("subagents.archiveFinishedAction")}
                  </Text>
                  {archiveFinishedStatus.kind === "archiving" ? (
                    <Text
                      style={styles.headerButtonTrailing}
                      testID="orchestration-archive-progress"
                    >
                      {`${String(archiveFinishedStatus.completedCount)}/${String(archiveFinishedStatus.totalCount)}`}
                    </Text>
                  ) : null}
                  {archiveFinishedStatus.kind === "failed" ? (
                    <Text style={styles.headerButtonTrailing} testID="orchestration-archive-failed">
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
          {hiddenCount > 0 || isShowingOlder ? (
            <Pressable
              testID="orchestration-panel-toggle-older"
              accessibilityRole="button"
              accessibilityLabel={
                isShowingOlder
                  ? t("panels.orchestration.hideOlder")
                  : t("panels.orchestration.showOlder", { count: hiddenCount })
              }
              onPress={onToggleOlder}
              style={styles.headerButton}
            >
              {({ hovered, pressed }) => {
                const Chevron = isShowingOlder ? ThemedChevronUp : ThemedChevronDown;
                return (
                  <>
                    <Chevron
                      size={ROW_ICON_SIZE}
                      uniProps={
                        hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                      }
                    />
                    <Text style={styles.headerButtonLabel} numberOfLines={1}>
                      {isShowingOlder
                        ? t("panels.orchestration.hideOlder")
                        : t("panels.orchestration.showOlder", { count: hiddenCount })}
                    </Text>
                  </>
                );
              }}
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  headerButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  headerButtonLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  headerButtonTrailing: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
