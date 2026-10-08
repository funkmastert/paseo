import { useMemo, useState, type ReactElement } from "react";
import { useIsFocused } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";
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

/** The active host this screen scopes to — no picker, same resolution as the sidebar target. */
function useTokenUsageActiveServerId(): string | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId,
        hosts,
        orderedHosts,
      }),
    [localServerId, hosts, orderedHosts],
  );
}

function TokenUsageScreenContent(): ReactElement {
  const [unit, setUnit] = useState<TokenUsageUnit>("weighted");
  const [range, setRange] = useState<TokenUsageRange>("7d");

  const serverId = useTokenUsageActiveServerId();
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "tokenUsage");
  const availability = resolveTokenUsageAvailability({
    hasHost: serverId !== null,
    connected,
    supported,
  });

  const { data: breakdown, isLoading } = useTokenUsage(serverId, range, {
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
