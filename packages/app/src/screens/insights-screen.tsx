import { useCallback, useState, type ReactElement } from "react";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { useActiveHostServerId } from "@/hooks/use-active-host-server-id";
import {
  useCompactionEpisodesList,
  useCompactionEpisodesSummary,
  type CompactionRange,
} from "@/compactions/use-compaction-episodes";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  buildJevDashboardRoute,
  buildSettingsRoute,
  buildTokenUsageRoute,
} from "@/utils/host-routes";
import {
  InsightsAvailabilityBanner,
  InsightsReadyContent,
  resolveInsightsAvailability,
} from "./insights-view";

export function InsightsScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <InsightsScreenContent />;
}

function InsightsScreenContent(): ReactElement {
  const [range, setRange] = useState<CompactionRange>("today");

  const serverId = useActiveHostServerId();
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "compactionLedger");
  const availability = resolveInsightsAvailability({
    hasHost: serverId !== null,
    connected,
    supported,
  });

  const summaryQuery = useCompactionEpisodesSummary(serverId, range, undefined, {
    enabled: availability.kind === "ready",
  });
  const episodesQuery = useCompactionEpisodesList(
    serverId,
    { range },
    { enabled: availability.kind === "ready" },
  );

  const openJevDashboard = useCallback(
    () => router.push(buildJevDashboardRoute(serverId ?? undefined)),
    [serverId],
  );
  const openDecisions = useCallback(() => router.push(buildSettingsRoute()), []);
  const openTokenUsage = useCallback(() => router.push(buildTokenUsageRoute()), []);

  return (
    <View style={styles.container}>
      <MenuHeader title="Insights" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="insights-screen"
      >
        <View style={styles.column}>
          <InsightsAvailabilityBanner availability={availability} />
          {availability.kind === "ready" ? (
            <InsightsReadyContent
              summary={summaryQuery.data}
              isLoadingSummary={summaryQuery.isLoading}
              episodes={episodesQuery.episodes}
              isLoadingEpisodes={episodesQuery.isLoading}
              isLoadingMoreEpisodes={episodesQuery.isLoadingMore}
              hasMoreEpisodes={episodesQuery.hasMore}
              onLoadMoreEpisodes={episodesQuery.loadMore}
              range={range}
              onRangeChange={setRange}
              onOpenJevDashboard={openJevDashboard}
              onOpenDecisions={openDecisions}
              onOpenTokenUsage={openTokenUsage}
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
