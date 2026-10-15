import { ArrowUp, ChevronLeft, ChevronRight, Maximize2 } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { UserMessageItem } from "@/types/stream";

export interface StickyPromptBarProps {
  prompt: UserMessageItem;
  /** Pinned-grid cells: one line, unobtrusive; the navigator controls stay present. */
  compact?: boolean;
  /** "3/7"-style label for the selected prompt among the navigable ones. Null when there's
   * only one prompt to navigate (nothing to count). */
  positionLabel: string | null;
  canStepBack: boolean;
  canStepForward: boolean;
  onStepBack: () => void;
  onStepForward: () => void;
  /** Tapping the bar body jumps to the selected prompt's row -- the full-prompt viewer moved
   * behind the expand icon below. */
  onJumpToSelected: () => void;
  onJumpToOriginal: () => void;
  /** The full-prompt viewer lives above this bar (view.tsx's StickyPromptOverlay) so it survives
   * the bar itself hiding; this just asks the overlay to open it. */
  onOpenViewer: () => void;
}

export function StickyPromptBar({
  prompt,
  compact = false,
  positionLabel,
  canStepBack,
  canStepForward,
  onStepBack,
  onStepForward,
  onJumpToSelected,
  onJumpToOriginal,
  onOpenViewer,
}: StickyPromptBarProps) {
  const { t } = useTranslation();

  const handlePressJump = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onJumpToOriginal();
    },
    [onJumpToOriginal],
  );

  const handlePressExpand = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onOpenViewer();
    },
    [onOpenViewer],
  );

  const bodyPressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.body, pressed && styles.bodyPressed],
    [],
  );

  const stepBackAccessibilityState = useMemo(() => ({ disabled: !canStepBack }), [canStepBack]);
  const stepForwardAccessibilityState = useMemo(
    () => ({ disabled: !canStepForward }),
    [canStepForward],
  );

  return (
    <View style={[styles.container, compact && styles.containerCompact]} testID="sticky-prompt-bar">
      <View style={styles.navigator} testID="sticky-prompt-bar-navigator">
        <Pressable
          style={styles.iconButton}
          onPress={onStepBack}
          disabled={!canStepBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={stepBackAccessibilityState}
          accessibilityLabel={t("agentStream.stickyPromptStepBack")}
          testID="sticky-prompt-bar-step-back"
        >
          <ChevronLeft
            size={14}
            color={canStepBack ? styles.icon.color : styles.iconDisabled.color}
          />
        </Pressable>
        {positionLabel ? (
          <Text style={styles.positionLabel} testID="sticky-prompt-bar-position">
            {positionLabel}
          </Text>
        ) : null}
        <Pressable
          style={styles.iconButton}
          onPress={onStepForward}
          disabled={!canStepForward}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={stepForwardAccessibilityState}
          accessibilityLabel={t("agentStream.stickyPromptStepForward")}
          testID="sticky-prompt-bar-step-forward"
        >
          <ChevronRight
            size={14}
            color={canStepForward ? styles.icon.color : styles.iconDisabled.color}
          />
        </Pressable>
      </View>
      <Pressable
        style={bodyPressableStyle}
        onPress={onJumpToSelected}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.stickyPromptJumpToSelected")}
        testID="sticky-prompt-bar-body"
      >
        <Text style={styles.text} numberOfLines={compact ? 1 : 2}>
          {prompt.text}
        </Text>
      </Pressable>
      <Pressable
        style={styles.iconButton}
        onPress={handlePressExpand}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("agentStream.stickyPromptShowFull")}
        testID="sticky-prompt-bar-expand"
      >
        <Maximize2 size={14} color={styles.icon.color} />
      </Pressable>
      <Pressable
        style={styles.iconButton}
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

export interface FullPromptViewerProps {
  visible: boolean;
  text: string;
  onClose: () => void;
  onJumpToOriginal: () => void;
  /** Fires once AdaptiveModalSheet's own close transition has actually finished, on every
   * platform — the sequencing point for "jump to message" so the scroll never races the sheet's
   * exit animation (web fade, native bottom-sheet slide-down). */
  onDismiss: () => void;
}

export function FullPromptViewer({
  visible,
  text,
  onClose,
  onJumpToOriginal,
  onDismiss,
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
      onDismiss={onDismiss}
      testID="sticky-prompt-viewer"
    >
      <Text selectable style={styles.viewerText} testID="sticky-prompt-viewer-text">
        {text}
      </Text>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Flows in its parent's column rather than self-positioning: the caller (TopOverlay) stacks
  // this before the jump-to-start button in flex flow, so the button lands below this bar's
  // real rendered height (0, 1, or 2 lines) without either side measuring or guessing it.
  container: {
    width: "100%",
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
  navigator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  positionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 28,
    textAlign: "center",
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
  iconButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 2,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  iconDisabled: {
    color: theme.colors.border,
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
