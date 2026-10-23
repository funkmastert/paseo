import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import type { TokenUsageRoleTotal } from "./token-usage-model";
import { TOKEN_USAGE_ROLE_LABELS, roleFillStyles } from "./token-usage-role-colors";

function RoleRow({
  entry,
  bordered,
  costSupported,
}: {
  entry: TokenUsageRoleTotal;
  bordered: boolean;
  costSupported: boolean;
}) {
  return (
    <View
      style={[styles.row, bordered ? settingsStyles.rowBorder : null]}
      testID={`tokens-by-role-row-${entry.role}`}
    >
      <View style={styles.labelGroup}>
        <View style={[styles.dot, roleFillStyles[entry.role]]} />
        <Text style={styles.label}>{TOKEN_USAGE_ROLE_LABELS[entry.role]}</Text>
      </View>
      <View style={styles.valueColumn}>
        <Text style={styles.value} testID={`tokens-by-role-value-${entry.role}`}>
          {entry.formattedTotal}
        </Text>
        {costSupported ? (
          <Text style={styles.costValue} testID={`tokens-by-role-cost-${entry.role}`}>
            {entry.formattedCost ?? "—"}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** "Tokens by role" (R8): leader, worker, outside Paseo totals, always all three. */
export function TokensByRoleCard({
  totals,
  costSupported,
}: {
  totals: TokenUsageRoleTotal[];
  costSupported: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("tokenUsage.byRoleTitle")} testID="tokens-by-role-card">
      <View style={settingsStyles.card}>
        {totals.map((entry, index) => (
          <RoleRow
            key={entry.role}
            entry={entry}
            bordered={index > 0}
            costSupported={costSupported}
          />
        ))}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  labelGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  valueColumn: {
    alignItems: "flex-end",
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  costValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
}));
