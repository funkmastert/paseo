import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Network } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerPillStyles } from "@/composer/pill-styles";
import { findOrchestrationNode } from "@/orchestration/orchestration-panel-model";
import { findOrchestrationRootAgentId } from "@/orchestration/orchestration-scope";
import { useOrchestrationTree } from "@/orchestration/select";
import type { Theme } from "@/styles/theme";
import { getStatusDotColor } from "@/utils/status-dot-color";

const ThemedNetwork = withUnistyles(Network);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The composer track-bar entry point into the orchestration panel. Callers gate visibility on the
 * agent being part of a tree at all; this component draws the pill, its rollup dot, and resolves
 * the scope the tab opens with.
 *
 * It resolves the root here rather than in the panel because it already holds the tree for the
 * rollup dot: one subscription answers both, and the tab target then names the leader, so opening
 * from a leader and from any of its subagents lands on the same tab instead of one per member.
 */
export function OrchestrationTrackPill({
  serverId,
  agentId,
  onPress,
}: {
  serverId: string;
  agentId: string;
  /** Receives the tree's root — the leader the opened tab scopes to. */
  onPress: (scopeAgentId: string) => void;
}) {
  const { t } = useTranslation();
  const orchestrationRoots = useOrchestrationTree({ serverId });
  const orchestrationNode = useMemo(
    () => findOrchestrationNode(orchestrationRoots, agentId),
    [agentId, orchestrationRoots],
  );
  const requiresAttention = orchestrationNode?.requiresAttentionInSubtree ?? false;
  // Falls back to this agent when the tree has not arrived yet: a scope naming an agent the panel
  // cannot place is still this agent's own tree once it does.
  const scopeAgentId = findOrchestrationRootAgentId(orchestrationRoots, agentId) ?? agentId;
  const handlePress = useCallback(() => onPress(scopeAgentId), [onPress, scopeAgentId]);
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
          onPress={handlePress}
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

const styles = StyleSheet.create((theme) => {
  const attentionDotColor =
    getStatusDotColor({ theme, bucket: "attention" }) ?? theme.colors.statusDotSuccess;
  return {
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
      backgroundColor: attentionDotColor,
    },
    tooltipText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
  };
});
