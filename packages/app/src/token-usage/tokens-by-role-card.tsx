import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import type { TokenUsageRole, TokenUsageRoleTotal } from "./token-usage-model";
import { TOKEN_USAGE_ROLE_LABELS } from "./token-usage-role-colors";

const ROLE_FILL_STYLE_NAMES: Record<TokenUsageRole, "roleLeader" | "roleWorker" | "roleOutside"> = {
  leader: "roleLeader",
  worker: "roleWorker",
  outside: "roleOutside",
};

function RoleRow({ entry, bordered }: { entry: TokenUsageRoleTotal; bordered: boolean }) {
  return (
    <View
      style={[styles.row, bordered ? settingsStyles.rowBorder : null]}
      testID={`tokens-by-role-row-${entry.role}`}
    >
      <View style={styles.labelGroup}>
        <View style={[styles.dot, styles[ROLE_FILL_STYLE_NAMES[entry.role]]]} />
        <Text style={styles.label}>{TOKEN_USAGE_ROLE_LABELS[entry.role]}</Text>
      </View>
      <Text style={styles.value} testID={`tokens-by-role-value-${entry.role}`}>
        {entry.formattedTotal}
      </Text>
    </View>
  );
}

/** "Tokens by role" (R8): leader, worker, outside Paseo totals, always all three. */
export function TokensByRoleCard({ totals }: { totals: TokenUsageRoleTotal[] }) {
  return (
    <View style={settingsStyles.card} testID="tokens-by-role-card">
      {totals.map((entry, index) => (
        <RoleRow key={entry.role} entry={entry} bordered={index > 0} />
      ))}
    </View>
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
  roleLeader: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  roleWorker: {
    backgroundColor: theme.colors.palette.purple[500],
  },
  roleOutside: {
    backgroundColor: theme.colors.palette.green[500],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
}));
