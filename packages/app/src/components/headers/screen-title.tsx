import { useMemo, type ReactNode } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface ScreenTitleProps {
  children: ReactNode;
  numberOfLines?: number;
  testID?: string;
  style?: StyleProp<TextStyle>;
  /**
   * Makes the title itself the tap target (click-to-edit, e.g. the workspace header's inline
   * rename). `Text.onPress` is a native RN capability, not a `<Pressable>` wrapping `<Text>`
   * (docs/design.md §14 forbids that shape) — no separate wrapper, no extra hit-testing layer.
   */
  onPress?: () => void;
  accessibilityLabel?: string;
}

/**
 * Canonical screen title for use inside `ScreenHeader`. One typography, one
 * color, responsive weight. Leading icons are siblings (HeaderToggleButton,
 * HeaderIconBadge) — never nested inside this component.
 */
export function ScreenTitle({
  children,
  numberOfLines = 1,
  testID,
  style,
  onPress,
  accessibilityLabel,
}: ScreenTitleProps) {
  const combinedStyle = useMemo(() => [styles.text, style], [style]);
  return (
    <Text
      style={combinedStyle}
      numberOfLines={numberOfLines}
      testID={testID}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
}));
