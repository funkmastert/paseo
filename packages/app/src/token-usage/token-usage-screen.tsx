import { useMemo, useState, type ReactElement } from "react";
import { useIsFocused } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { buildTokenUsageFixture } from "./token-usage-fixtures";
import type { TokenUsageRange, TokenUsageUnit } from "./token-usage-model";
import { TokenUsageContent } from "./token-usage-view";

export function TokenUsageScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <TokenUsageScreenContent />;
}

function TokenUsageScreenContent(): ReactElement {
  const [unit, setUnit] = useState<TokenUsageUnit>("weighted");
  const [range, setRange] = useState<TokenUsageRange>("7d");

  // COMPAT(tokenUsage): fixture data, matching the props `use-token-usage.ts` (U5) will provide
  // once U3's `usage.tokens.get_breakdown` RPC lands. Only this line changes in U5.
  const breakdown = useMemo(() => buildTokenUsageFixture(range), [range]);

  return (
    <View style={styles.container}>
      <MenuHeader title="Tokens" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="token-usage-screen"
      >
        <View style={styles.column}>
          <TokenUsageContent
            breakdown={breakdown}
            unit={unit}
            onUnitChange={setUnit}
            range={range}
            onRangeChange={setRange}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[12],
  },
  column: {
    width: "100%",
    maxWidth: 960,
    alignSelf: "center",
    gap: theme.spacing[6],
  },
}));
