import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { FloatingScrollView } from "@/components/ui/floating";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { ContextUsageBreakdownSection } from "@/context-usage/context-usage-breakdown-section";
import {
  resolveContextMeterThresholds,
  resolveContextMeterTone,
  type ContextMeterTone,
} from "@/context-usage/context-meter-model";
import type { Theme } from "@/styles/theme";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { AgentSpendSparkline } from "@/usage-history/agent-spend-sparkline";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { formatTokenCount } from "./context-window-meter.utils";

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  /** The agent this meter describes; its weighted-token spend history draws in the tooltip. */
  agentId?: string | null;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

const ThemedCircle = withUnistyles(Circle);

const trackStrokeMapping = (theme: Theme) => ({ stroke: theme.colors.surface3 });
const PROGRESS_STROKE_MAPPINGS: Record<ContextMeterTone, (theme: Theme) => { stroke: string }> = {
  neutral: (theme) => ({ stroke: theme.colors.foregroundMuted }),
  amber: (theme) => ({ stroke: theme.colors.palette.amber[500] }),
  red: (theme) => ({ stroke: theme.colors.destructive }),
};

// The tooltip's own width. A breakdown row needs room for a label and two figures, and a scroll
// view has no intrinsic width to shrink-wrap to, so the content states one that fits a phone.
const TOOLTIP_MAX_WIDTH = 320;
const TOOLTIP_SCREEN_MARGIN = 32;
const TOOLTIP_MAX_HEIGHT_RATIO = 0.7;

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  showPercentage = false,
  serverId,
  agentId,
  provider,
  pending = false,
  glyphSize,
}: ContextWindowMeterProps) {
  const { t } = useTranslation();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const daemonConfig = useDaemonConfig(serverId ?? null).config;
  const thresholds = useMemo(
    () => resolveContextMeterThresholds(daemonConfig?.contextMeter),
    [daemonConfig?.contextMeter],
  );
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen },
  );
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen) {
        void refreshProviderUsage().catch(() => {});
      }
    },
    [refreshProviderUsage],
  );

  const geometry = getMeterGeometry(showPercentage, glyphSize);
  const tooltipWidth = Math.min(TOOLTIP_MAX_WIDTH, windowWidth - TOOLTIP_SCREEN_MARGIN);
  const tooltipScrollStyle = useMemo(
    () => ({ maxHeight: windowHeight * TOOLTIP_MAX_HEIGHT_RATIO }),
    [windowHeight],
  );

  // No usage yet: reserve the footprint with a track-only ring while a session is
  // active so the real ring fades in without shifting siblings. Render nothing when
  // no usage is expected.
  if (percentage === null || maxTokens === null || usedTokens === null) {
    if (!pending) {
      return null;
    }
    return (
      <View style={geometry.containerStyle}>
        <Svg
          width={geometry.svgSize}
          height={geometry.svgSize}
          viewBox={`0 0 ${geometry.svgSize} ${geometry.svgSize}`}
          style={styles.svg}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <ThemedCircle
            cx={geometry.center}
            cy={geometry.center}
            r={geometry.radius}
            fill="none"
            uniProps={trackStrokeMapping}
            strokeWidth={geometry.strokeWidth}
          />
        </Svg>
        {showPercentage ? <View style={styles.skeletonLabel} /> : null}
      </View>
    );
  }

  const clampedPercentage = clampPercentage(percentage);
  const roundedPercentage = Math.round(percentage);
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const tone = resolveContextMeterTone({ usedTokens, maxTokens }, thresholds);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;

  return (
    <Tooltip
      open={isTooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      delayDuration={0}
      enabledOnDesktop
      enabledOnMobile
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="image"
          accessibilityLabel={t("contextWindow.accessibility", {
            percentage: roundedPercentage,
          })}
        >
          <Svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <ThemedCircle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              uniProps={trackStrokeMapping}
              strokeWidth={strokeWidth}
            />
            <ThemedCircle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              uniProps={PROGRESS_STROKE_MAPPINGS[tone]}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </Svg>
          {showPercentage ? (
            <Text style={styles.percentageLabel}>{`${roundedPercentage}%`}</Text>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8} maxWidth={TOOLTIP_MAX_WIDTH} interactive>
        <FloatingScrollView style={tooltipScrollStyle} showsVerticalScrollIndicator={false}>
          <View style={[styles.tooltipContent, { width: tooltipWidth }]}>
            <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
            <Text style={styles.tooltipText}>
              {t("contextWindow.used", { percentage: roundedPercentage })}
            </Text>
            <Text style={styles.tooltipDetail}>
              {t("contextWindow.tokens", {
                used: formatTokenCount(usedTokens),
                max: formatTokenCount(maxTokens),
              })}
            </Text>
            {formattedSessionCost ? (
              <Text style={styles.tooltipDetail}>
                {t("contextWindow.sessionCost", { cost: formattedSessionCost })}
              </Text>
            ) : null}
            <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
            <ContextUsageBreakdownSection
              serverId={serverId}
              agentId={agentId}
              enabled={isTooltipOpen}
              usedTokens={usedTokens}
              tone={tone}
              thresholds={thresholds}
            />
            <AgentSpendSparkline serverId={serverId} agentId={agentId} enabled={isTooltipOpen} />
          </View>
        </FloatingScrollView>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  skeletonLabel: {
    width: 22,
    height: theme.fontSize.base,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tooltipContent: {
    gap: theme.spacing[1.5],
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
