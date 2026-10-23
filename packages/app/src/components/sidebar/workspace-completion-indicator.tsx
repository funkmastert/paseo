import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CompletionState } from "@getpaseo/protocol/agent-labels";
import { STATUS_INDICATOR_ALERT_SIZE } from "@/utils/status-indicator-geometry";
import {
  CompletionIndicatorIcon,
  formatCompletionIndicatorAccessibilityLabel,
  getCompletionIndicatorColorMapping,
  getCompletionIndicatorLabelKey,
  getCompletionIndicatorTestIdSuffix,
} from "@/utils/completion-indicator-content";

/**
 * What the sidebar row's leading slot shows once a workspace carries a `paseo.completion`
 * label: a pull-request icon while the PR is open and green, a check once everything (including
 * the merge) is done. Kept in its own module, separate from `sidebar-workspace-row-content.tsx`,
 * so it can be imported and tested without that file's heavy transitive imports (hover card,
 * project icon, meta row).
 */
export function WorkspaceCompletionIndicator({
  completionState,
  completionNote,
}: {
  completionState: CompletionState;
  completionNote: string | null;
}) {
  const { t } = useTranslation();
  const label = t(getCompletionIndicatorLabelKey(completionState));
  const accessibilityLabel = formatCompletionIndicatorAccessibilityLabel(label, completionNote);
  const Icon = CompletionIndicatorIcon[completionState];
  const colorMapping = getCompletionIndicatorColorMapping(completionState);
  const testID = `workspace-status-indicator-${getCompletionIndicatorTestIdSuffix(completionState)}`;

  return (
    <View style={styles.slot} testID={testID} accessibilityLabel={accessibilityLabel}>
      <Tooltip enabledOnDesktop delayDuration={200}>
        <TooltipTrigger asChild>
          <View>
            <Icon size={STATUS_INDICATOR_ALERT_SIZE} uniProps={colorMapping} />
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={6}>
          <Text style={styles.tooltipText}>{accessibilityLabel}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Matches sidebar-workspace-row-content.tsx's workspaceStatusDot slot so the leading icon
  // doesn't shift the row when it swaps between this and the other status indicators.
  slot: {
    position: "relative",
    width: theme.iconSize.md,
    height: 20,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    maxWidth: 240,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
