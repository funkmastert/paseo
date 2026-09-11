import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerPillStyles } from "@/composer/pill-styles";
import type { Theme } from "@/styles/theme";

const ThemedNetwork = withUnistyles(Network);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The composer track-bar entry point into the orchestration panel. Visible whenever the current
 * agent has children — callers gate that, this component only draws the pill and its rollup dot.
 */
export function OrchestrationTrackPill({
  requiresAttention,
  onPress,
}: {
  requiresAttention: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );
  const label = t("panels.orchestration.label");

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          testID="composer-orchestration-pill"
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={onPress}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          style={bodyStyle}
        >
          <View style={styles.iconWrap}>
            <ThemedNetwork
              size={14}
              uniProps={isHovered ? foregroundColorMapping : foregroundMutedColorMapping}
            />
            {requiresAttention ? (
              <View style={styles.attentionDot} testID="composer-orchestration-pill-attention" />
            ) : null}
          </View>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("panels.orchestration.tooltip")}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconWrap: {
    position: "relative",
  },
  attentionDot: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDotSuccess,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
