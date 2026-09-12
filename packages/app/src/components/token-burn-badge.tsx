import type { ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { TokenBurnTone } from "@/utils/token-burn-tone-model";

/**
 * The one place a `TokenBurnTone` becomes UI: an icon-and-label `StatusBadge` (never color alone
 * — see docs/design.md) with the exact numbers on hover/tap. Rendered only for "warning"/"danger"
 * — there's no "default" badge, matching deriveTokenBurnTones never producing a third tone.
 */
export function TokenBurnBadge({
  tone,
  tokensPerMinute,
  totalTokens,
  testID,
}: {
  tone: TokenBurnTone;
  tokensPerMinute: number;
  totalTokens?: number;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const label =
    tone === "danger"
      ? t("agentList.badges.tokenBurnDanger")
      : t("agentList.badges.tokenBurnWarning");
  const tooltip = t("agentList.tokenBurnTooltip", {
    rate: formatTokenCount(tokensPerMinute),
    total: totalTokens !== undefined ? formatTokenCount(totalTokens) : "—",
  });

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable accessibilityRole="text" testID={testID} hitSlop={4}>
          <StatusBadge label={label} variant={tone === "danger" ? "error" : "warning"} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
