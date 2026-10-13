import { ArrowUp, ChevronDown, ChevronUp } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { UserMessageItem } from "@/types/stream";

// A true "40% of this panel" requires plumbing a measured container height down
// to every host (including pinned-grid cells). The window height is a close,
// dependency-free stand-in that still caps the expanded panel well short of
// the screen on every form factor.
const EXPANDED_HEIGHT_RATIO = 0.4;

export interface StickyPromptBarProps {
  prompt: UserMessageItem;
  /** Pinned-grid cells: one line, no expand affordance, tap jumps directly. */
  compact?: boolean;
  onJumpToOriginal: () => void;
}

export function StickyPromptBar({
  prompt,
  compact = false,
  onJumpToOriginal,
}: StickyPromptBarProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const expandedMaxHeight = useMemo(
    () => Math.round(windowHeight * EXPANDED_HEIGHT_RATIO),
    [windowHeight],
  );

  const handlePressBody = useCallback(() => {
    if (compact) {
      onJumpToOriginal();
      return;
    }
    setExpanded((current) => !current);
  }, [compact, onJumpToOriginal]);

  const handlePressJump = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onJumpToOriginal();
    },
    [onJumpToOriginal],
  );

  return (
    <View style={[styles.container, compact && styles.containerCompact]} testID="sticky-prompt-bar">
      <Pressable
        style={styles.body}
        onPress={handlePressBody}
        accessibilityRole="button"
        accessibilityLabel={
          compact
            ? prompt.text
            : t(expanded ? "agentStream.stickyPromptCollapse" : "agentStream.stickyPromptExpand")
        }
        testID="sticky-prompt-bar-body"
      >
        {expanded && !compact ? (
          <ScrollView
            style={[styles.expandedScroll, { maxHeight: expandedMaxHeight }]}
            testID="sticky-prompt-bar-expanded"
          >
            <Text style={styles.expandedText}>{prompt.text}</Text>
          </ScrollView>
        ) : (
          <Text style={styles.text} numberOfLines={compact ? 1 : 2}>
            {prompt.text}
          </Text>
        )}
        {!compact ? (
          <View style={styles.chevronSlot}>
            {expanded ? (
              <ChevronUp size={14} color={styles.icon.color} />
            ) : (
              <ChevronDown size={14} color={styles.icon.color} />
            )}
          </View>
        ) : null}
      </Pressable>
      <Pressable
        style={styles.jumpButton}
        onPress={handlePressJump}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.stickyPromptJumpToOriginal")}
        testID="sticky-prompt-bar-jump"
      >
        <ArrowUp size={14} color={styles.icon.color} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 3,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  containerCompact: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  body: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  expandedScroll: {
    flex: 1,
  },
  expandedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  chevronSlot: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 2,
  },
  jumpButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 2,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
}));
