import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { TOKEN_USAGE_ROLE_ORDER, type TokenUsageModelBar } from "./token-usage-model";
import { TOKEN_USAGE_ROLE_LABELS, roleFillStyles } from "./token-usage-role-colors";

// A sliver stays visible for a non-zero segment, without pretending it's bigger than it is.
const MIN_SEGMENT_FRACTION = 0.006;

function Legend() {
  return (
    <View style={styles.legend} testID="tokens-by-model-legend">
      {TOKEN_USAGE_ROLE_ORDER.map((role) => (
        <View key={role} style={styles.legendItem}>
          <View style={[styles.legendDot, roleFillStyles[role]]} />
          <Text style={styles.legendLabel}>{TOKEN_USAGE_ROLE_LABELS[role]}</Text>
        </View>
      ))}
    </View>
  );
}

function ModelBarTrack({ bar }: { bar: TokenUsageModelBar }) {
  return (
    <View style={styles.track} testID={`tokens-by-model-bar-${bar.id}`}>
      <View style={[styles.filled, { width: `${Math.max(bar.share, 0) * 100}%` }]}>
        {bar.segments
          .filter((segment) => segment.total > 0)
          .map((segment) => (
            <View
              key={segment.role}
              style={[
                styles.segment,
                roleFillStyles[segment.role],
                { flexGrow: Math.max(segment.fraction, MIN_SEGMENT_FRACTION), flexBasis: 0 },
              ]}
            />
          ))}
      </View>
    </View>
  );
}

function ModelRow({ bar, bordered }: { bar: TokenUsageModelBar; bordered: boolean }) {
  return (
    <View
      style={[styles.row, bordered ? settingsStyles.rowBorder : null]}
      testID={`tokens-by-model-row-${bar.id}`}
    >
      <Text
        style={bar.isUnattributed ? styles.labelMuted : styles.label}
        numberOfLines={1}
        testID={`tokens-by-model-label-${bar.id}`}
      >
        {bar.label}
      </Text>
      <View style={styles.trackWrap}>
        <ModelBarTrack bar={bar} />
      </View>
      <Text style={styles.value} testID={`tokens-by-model-value-${bar.id}`}>
        {bar.formattedTotal}
      </Text>
    </View>
  );
}

/**
 * "Tokens by model" (R7): one bar per provider/model, largest first, each bar split into role
 * segments. Pure in its props — `buildTokenUsageModelBars` does the sorting and fraction math, this
 * only renders it.
 */
export function TokensByModelCard({ bars }: { bars: TokenUsageModelBar[] }) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("tokenUsage.byModelTitle")} testID="tokens-by-model-card">
      <Legend />
      <View style={settingsStyles.card}>
        {bars.map((bar, index) => (
          <ModelRow key={bar.id} bar={bar} bordered={index > 0} />
        ))}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  legendLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  label: {
    width: 180,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  labelMuted: {
    width: 180,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  trackWrap: {
    flex: 1,
  },
  track: {
    height: 8,
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  filled: {
    flexDirection: "row",
    height: "100%",
    gap: 1,
  },
  segment: {
    height: "100%",
  },
  value: {
    minWidth: 56,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
}));
