import { Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import {
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  buildSpendSparklineModel,
  formatWeightedTokens,
} from "./spend-sparkline-model";
import { useUsageHistory } from "./use-usage-history";

const ThemedPath = withUnistyles(Path);
const ThemedCircle = withUnistyles(Circle);

const lineColorMapping = (theme: Theme) => ({ stroke: theme.colors.foregroundMuted });
const dotColorMapping = (theme: Theme) => ({ fill: theme.colors.foreground });

/**
 * An agent's weighted-token spend over its life, as a line, for the context meter's tooltip. It
 * fetches only while the tooltip is open, and renders nothing when the daemon predates usage
 * history or has no spend recorded for the agent, so the tooltip never grows an error row.
 */
export function AgentSpendSparkline({
  serverId,
  agentId,
  enabled,
}: {
  serverId: string | null | undefined;
  agentId: string | null | undefined;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const { data } = useUsageHistory(serverId, { agentId, enabled: enabled && Boolean(agentId) });
  const model = buildSpendSparklineModel(data?.agent);
  if (model.kind !== "line") return null;

  const summary = t("contextWindow.spendSummary", {
    total: formatWeightedTokens(model.totalWeightedTokens),
    span: formatDuration(model.spanMs),
  });
  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.title}>{t("contextWindow.spendTitle")}</Text>
      <Svg
        width={SPARKLINE_WIDTH}
        height={SPARKLINE_HEIGHT}
        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
        accessibilityRole="image"
        accessibilityLabel={summary}
        testID="agent-spend-sparkline"
      >
        <ThemedPath
          d={model.path}
          fill="none"
          uniProps={lineColorMapping}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <ThemedCircle cx={model.endX} cy={model.endY} r={2} uniProps={dotColorMapping} />
      </Svg>
      <Text style={styles.detail}>{summary}</Text>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
