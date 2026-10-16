import { memo, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowUpToLine } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { primaryColorMapping, scrollIndicatorStyles } from "./scroll-indicator-styles";
import { resolveScrollIndicatorFade } from "./scroll-indicator-fade";
import { StickyPromptOverlay } from "./sticky-last-prompt/sticky-prompt-overlay";
import type { StickyLastPromptSource } from "./sticky-last-prompt/model";
import type { UserMessageItem } from "@/types/stream";

export interface TopOverlayProps {
  agentId: string;
  stickyPromptSource: StickyLastPromptSource;
  compact: boolean;
  onJumpToStickyPrompt: () => void;
  selectedPrompt: UserMessageItem | null;
  positionLabel: string | null;
  canStepBack: boolean;
  canStepForward: boolean;
  onStepBack: () => void;
  onStepForward: () => void;
  onJumpToSelected: () => void;
  showJumpToStart: boolean;
  isJumpingToStart: boolean;
  onJumpToStart: () => void;
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

// Mirrors the bottom scroll-to-bottom button, stacked at the top of the viewport instead.
// The sticky last-prompt bar (StickyPromptOverlay) and the button are flow siblings in one
// column, so the button always lands just below whatever height the bar actually renders at
// (0, 1, or 2 lines) without this component ever measuring or guessing that height.
export const TopOverlay = memo(function TopOverlay({
  agentId,
  stickyPromptSource,
  compact,
  onJumpToStickyPrompt,
  selectedPrompt,
  positionLabel,
  canStepBack,
  canStepForward,
  onStepBack,
  onStepForward,
  onJumpToSelected,
  showJumpToStart,
  isJumpingToStart,
  onJumpToStart,
}: TopOverlayProps): ReactNode {
  const { t } = useTranslation();
  const { fadeIn, fadeOut } = resolveScrollIndicatorFade();
  return (
    <View style={styles.column} pointerEvents="box-none" testID="agent-stream-top-overlay">
      <StickyPromptOverlay
        key={agentId}
        source={stickyPromptSource}
        compact={compact}
        onJumpToOriginal={onJumpToStickyPrompt}
        selectedPrompt={selectedPrompt}
        positionLabel={positionLabel}
        canStepBack={canStepBack}
        canStepForward={canStepForward}
        onStepBack={onStepBack}
        onStepForward={onStepForward}
        onJumpToSelected={onJumpToSelected}
      />
      {showJumpToStart && (
        <Animated.View entering={fadeIn} exiting={fadeOut} style={styles.buttonRow}>
          <Pressable
            style={scrollIndicatorStyles.button}
            onPress={onJumpToStart}
            accessibilityRole="button"
            accessibilityLabel={t("agentStream.jumpToStart")}
            testID="jump-to-start-button"
          >
            {isJumpingToStart ? (
              <ThemedLoadingSpinner size="small" uniProps={primaryColorMapping} />
            ) : (
              <ArrowUpToLine size={24} color={scrollIndicatorStyles.icon.color} />
            )}
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  column: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    flexDirection: "column",
    alignItems: "center",
  },
  // Same magnitude as the bottom cluster's own floor inset (resolveBottomOverlayControlOffset),
  // applied once after the sticky bar in flow: 16px from the top edge when the bar isn't
  // rendered, 16px below the bar's bottom edge when it is.
  buttonRow: {
    marginTop: theme.spacing[4],
  },
}));
