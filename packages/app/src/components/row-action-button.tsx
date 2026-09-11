import type { ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A hover/press-aware row action icon: Tooltip + Pressable, with the icon itself supplied via a
 * render prop so each caller can theme it (icon swap, active color) without re-declaring the
 * wrapper. Shared by the subagents track and the orchestration panel row.
 */
export function RowActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  visible,
  onPress,
  children,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  visible: boolean;
  onPress: () => void;
  children: (active: boolean) => ReactElement;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
        >
          {({ hovered, pressed }) => children(hovered || pressed)}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
