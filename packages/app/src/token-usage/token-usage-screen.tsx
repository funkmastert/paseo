import { useState, type ReactElement } from "react";
import { useIsFocused } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { useActiveHostServerId } from "@/hooks/use-active-host-server-id";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { TokenUsageRange, TokenUsageUnit } from "./token-usage-model";
import { useTokenUsage } from "./use-token-usage";
import {
  resolveTokenUsageAvailability,
  TokenUsageAvailabilityBanner,
  TokenUsageContent,
} from "./token-usage-view";

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

  const serverId = useActiveHostServerId();
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "tokenUsage");
  const availability = resolveTokenUsageAvailability({
    hasHost: serverId !== null,
    connected,
    supported,
  });

  const {
    data: breakdown,
    isLoading,
    error,
    refetch,
  } = useTokenUsage(serverId, range, {
    enabled: availability.kind === "ready",
  });

  return (
    <View style={styles.container}>
      <MenuHeader title="Tokens" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="token-usage-screen"
      >
        <View style={styles.column}>
          <TokenUsageAvailabilityBanner availability={availability} />
          {availability.kind === "ready" ? (
            <TokenUsageContent
              breakdown={breakdown}
              isLoading={isLoading}
              queryError={error}
              onRetry={refetch}
              unit={unit}
              onUnitChange={setUnit}
              range={range}
              onRangeChange={setRange}
            />
          ) : null}
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
