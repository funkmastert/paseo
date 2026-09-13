import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import type { MenuTriggerState } from "@/components/ui/menu";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { buildNavigationHistoryReplayDeps } from "@/navigation/navigation-history-replay";
import {
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  useNavigationHistoryStore,
} from "@/stores/navigation-history-store";
import { HistoryRecentMenuContent } from "./history-recent-menu";

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

  const backTriggerStyle = useMemo(
    () =>
      ({ hovered, pressed, open }: MenuTriggerState) =>
        iconButtonChromeStyle({
          size: "large",
          state: { hovered, pressed, open },
          disabled: !backEnabled,
        }),
    [backEnabled],
  );

  return (
    <View style={styles.row}>
      <ContextMenu>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <ContextMenuTrigger
              testID="history-back-button"
              accessibilityRole="button"
              accessibilityLabel={t("settings.shortcuts.help.historyBack")}
              disabled={!backEnabled}
              style={backTriggerStyle}
              onPress={handleBack}
            >
              <ThemedChevronLeft size={glyphSize} strokeWidth={1.5} />
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            testID="history-back-button-tooltip"
            side="bottom"
            align="center"
            offset={8}
          >
            <View style={styles.tooltipRow}>
              <Text style={styles.tooltipText}>{t("settings.shortcuts.help.historyBack")}</Text>
              <Shortcut keys={BACK_SHORTCUT_KEYS} style={styles.shortcut} />
            </View>
          </TooltipContent>
        </Tooltip>
        {/* Long-press (native) / right-click (web+desktop) on the back button above opens this --
            see docs/plans/2026-09-12-001-feat-global-back-history-plan.md's "long-press" surface. */}
        <HistoryRecentMenuContent />
      </ContextMenu>
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
  // Mirrors HeaderToggleButton's own tooltip row -- duplicated here because the back button's
  // trigger has to be a ContextMenuTrigger (for the long-press/right-click menu) rather than a
  // HeaderToggleButton, so it composes Tooltip directly instead of getting the row for free.
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  shortcut: {},
}));
