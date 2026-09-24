import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, RotateCcw } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { RestartRecoveryEntry } from "@getpaseo/protocol/restart-recovery/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { useRestartRecovery } from "./use-restart-recovery";

const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type OpenState = "pending" | "resuming" | "failed";
const OPEN_STATES = new Set<string>(["pending", "resuming", "failed"]);

function isOpenState(state: string): state is OpenState {
  return OPEN_STATES.has(state);
}

function EntryRow({ entry }: { entry: RestartRecoveryEntry }) {
  const { t } = useTranslation();
  let state: string = entry.state;
  if (entry.readiness === "not_restorable") {
    state = t("restartRecovery.notRestorable");
  } else if (isOpenState(entry.state)) {
    state = t(`restartRecovery.state.${entry.state}`);
  }
  const reason =
    entry.detail ??
    entry.checks.find((check) => check.status === "red" || check.status === "yellow")?.detail;
  return (
    <View style={styles.row} testID={`restart-recovery-row-${entry.agentId}`}>
      <Text style={styles.rowName} numberOfLines={1}>
        {"  ".repeat(entry.depth)}
        {entry.title ?? entry.agentId.slice(0, 8)}
      </Text>
      <Text style={styles.rowStatus} numberOfLines={2}>
        {state}
        {reason ? ` · ${reason}` : ""}
      </Text>
    </View>
  );
}

/**
 * Agents the last daemon stop cut off mid-turn (docs/restart-recovery.md), mounted beside the
 * device and MCP strips. Renders nothing unless the host has recovery on and something is still
 * waiting on a decision. Resume all resumes leaders first; Dismiss leaves them closed for good.
 */
export function RestartRecoveryStrip() {
  const { t } = useTranslation();
  const { model, resumeAll, dismissAll, busy, error } = useRestartRecovery();
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);

  if (!model) return null;

  return (
    <View style={styles.container} testID="restart-recovery-strip">
      <Pressable
        onPress={handleToggle}
        style={styles.summaryRow}
        accessibilityRole="button"
        accessibilityLabel={t(expanded ? "restartRecovery.collapse" : "restartRecovery.expand")}
        testID="restart-recovery-summary-toggle"
      >
        <ThemedRotateCcw size={14} uniProps={foregroundMutedColorMapping} />
        <View style={styles.dot} />
        <Text style={styles.summaryText} numberOfLines={1}>
          {t("restartRecovery.summary", { count: model.open.length })}
        </Text>
        {expanded ? (
          <ThemedChevronUp size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.rowList} testID="restart-recovery-rows">
          {model.open.map((entry) => (
            <EntryRow key={entry.agentId} entry={entry} />
          ))}
          {error ? <Text style={styles.error}>{t("restartRecovery.error", { error })}</Text> : null}
          <View style={styles.actions}>
            <Button
              size="sm"
              variant="default"
              onPress={resumeAll}
              loading={busy}
              disabled={model.resumableCount === 0}
              testID="restart-recovery-resume-all"
            >
              {t("restartRecovery.resumeAll")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={dismissAll}
              disabled={busy}
              testID="restart-recovery-dismiss-all"
            >
              {t("restartRecovery.dismissAll")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing[1],
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  summaryText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  rowList: {
    paddingBottom: theme.spacing[1],
  },
  row: {
    gap: 1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  rowName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  rowStatus: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
}));
