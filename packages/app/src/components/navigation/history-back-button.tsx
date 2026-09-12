import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { iconButtonChromeGlyphSize } from "@/components/ui/icon-button-chrome";
import { buildNavigationHistoryReplayDeps } from "@/navigation/navigation-history-replay";
import {
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  useNavigationHistoryStore,
} from "@/stores/navigation-history-store";

// "mod" resolves to Cmd on mac and Ctrl elsewhere (see format-shortcut.ts),
// matching the Cmd+Shift+[ / Ctrl+Shift+[ bindings in keyboard-shortcuts.ts.
const BACK_SHORTCUT_KEYS = ["mod", "shift", "["];
const FORWARD_SHORTCUT_KEYS = ["mod", "shift", "]"];

const ThemedChevronLeft = withUnistyles(ChevronLeft, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

/**
 * Back/forward chevron pair for the workspace-scoped navigation history --
 * see docs/plans/2026-09-12-001-feat-global-back-history-plan.md. Reused
 * wherever the workspace header wants it; disabled state tracks the history
 * store directly so it stays in sync with the keyboard shortcuts.
 */
export function HistoryBackButton() {
  const { t } = useTranslation();
  const backEnabled = useNavigationHistoryStore(canGoBack);
  const forwardEnabled = useNavigationHistoryStore(canGoForward);

  const handleBack = useCallback(() => {
    goBack(buildNavigationHistoryReplayDeps());
  }, []);
  const handleForward = useCallback(() => {
    goForward(buildNavigationHistoryReplayDeps());
  }, []);

  const glyphSize = iconButtonChromeGlyphSize("large");

  return (
    <View style={styles.row}>
      <HeaderToggleButton
        onPress={handleBack}
        disabled={!backEnabled}
        tooltipLabel={t("settings.shortcuts.help.historyBack")}
        tooltipKeys={BACK_SHORTCUT_KEYS}
        tooltipSide="bottom"
        testID="history-back-button"
        accessibilityRole="button"
        accessibilityLabel={t("settings.shortcuts.help.historyBack")}
      >
        <ThemedChevronLeft size={glyphSize} strokeWidth={1.5} />
      </HeaderToggleButton>
      <HeaderToggleButton
        onPress={handleForward}
        disabled={!forwardEnabled}
        tooltipLabel={t("settings.shortcuts.help.historyForward")}
        tooltipKeys={FORWARD_SHORTCUT_KEYS}
        tooltipSide="bottom"
        testID="history-forward-button"
        accessibilityRole="button"
        accessibilityLabel={t("settings.shortcuts.help.historyForward")}
      >
        <ThemedChevronRight size={glyphSize} strokeWidth={1.5} />
      </HeaderToggleButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
