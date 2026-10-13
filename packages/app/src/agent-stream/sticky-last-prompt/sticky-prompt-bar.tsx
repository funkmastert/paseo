import { ArrowUp } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { UserMessageItem } from "@/types/stream";

export interface StickyPromptBarProps {
  prompt: UserMessageItem;
  /** Pinned-grid cells: one line, unobtrusive; tapping the body still opens the full viewer. */
  compact?: boolean;
  onJumpToOriginal: () => void;
}

export function StickyPromptBar({
  prompt,
  compact = false,
  onJumpToOriginal,
}: StickyPromptBarProps) {
  const { t } = useTranslation();
  const [viewerOpen, setViewerOpen] = useState(false);

  const handlePressBody = useCallback(() => {
    setViewerOpen(true);
  }, []);

  const handleCloseViewer = useCallback(() => {
    setViewerOpen(false);
  }, []);

  const handlePressJump = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onJumpToOriginal();
    },
    [onJumpToOriginal],
  );

  const handleJumpFromViewer = useCallback(() => {
    setViewerOpen(false);
    onJumpToOriginal();
  }, [onJumpToOriginal]);

  const bodyPressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.body, pressed && styles.bodyPressed],
    [],
  );

  return (
    <View style={[styles.container, compact && styles.containerCompact]} testID="sticky-prompt-bar">
      <Pressable
        style={bodyPressableStyle}
        onPress={handlePressBody}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.stickyPromptShowFull")}
        testID="sticky-prompt-bar-body"
      >
        <Text style={styles.text} numberOfLines={compact ? 1 : 2}>
          {prompt.text}
        </Text>
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
      <FullPromptViewer
        visible={viewerOpen}
        text={prompt.text}
        onClose={handleCloseViewer}
        onJumpToOriginal={handleJumpFromViewer}
      />
    </View>
  );
}

interface FullPromptViewerProps {
  visible: boolean;
  text: string;
  onClose: () => void;
  onJumpToOriginal: () => void;
}

function FullPromptViewer({
  visible,
  text,
  onClose,
  onJumpToOriginal,
}: FullPromptViewerProps): ReactNode {
  const { t } = useTranslation();

  const headerActions = useMemo(
    () => (
      <Pressable
        onPress={onJumpToOriginal}
        hitSlop={8}
        style={styles.viewerJumpButton}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.stickyPromptJumpToOriginal")}
        testID="sticky-prompt-viewer-jump"
      >
        <ArrowUp size={16} color={styles.icon.color} />
      </Pressable>
    ),
    [onJumpToOriginal, t],
  );

  const header = useMemo<SheetHeader>(
    () => ({ title: t("agentStream.stickyPromptViewerTitle"), actions: headerActions }),
    [headerActions, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="sticky-prompt-viewer"
    >
      <Text selectable style={styles.viewerText} testID="sticky-prompt-viewer-text">
        {text}
      </Text>
    </AdaptiveModalSheet>
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
  bodyPressed: {
    opacity: 0.85,
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  jumpButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 2,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  viewerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  viewerJumpButton: {
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[2],
  },
}));
