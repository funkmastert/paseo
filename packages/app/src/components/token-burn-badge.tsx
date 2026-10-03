import { useMemo, type ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { Theme } from "@/styles/theme";
import type { TokenBurnTone } from "@/utils/token-burn-tone-model";

const ThemedGauge = withUnistyles(Gauge);

const LEADING_ICON_SIZE = 12;

const warningIconColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerIconColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

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
  const leadingIcon = useMemo(
    () => (
      <ThemedGauge
        size={LEADING_ICON_SIZE}
        uniProps={tone === "danger" ? dangerIconColorMapping : warningIconColorMapping}
      />
    ),
    [tone],
  );

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable accessibilityRole="text" testID={testID} hitSlop={4}>
          <StatusBadge
            label={label}
            variant={tone === "danger" ? "error" : "warning"}
            leading={leadingIcon}
          />
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
