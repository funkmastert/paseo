import { useCallback, useState, type ReactElement } from "react";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { useJevDashboardHostStatus } from "@/jev/use-jev-dashboard-host-status";
import { useJevSavingsEvents } from "@/jev/use-jev-savings-events";
import { useJevSavingsSummary } from "@/jev/use-jev-savings-summary";
import type { JevSavingsRange } from "@/jev/jev-savings-types";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  HostField,
  JevDashboardReadyContent,
  NotConfiguredBanner,
  resolveJevDashboardAvailability,
} from "./jev-dashboard-view";

interface JevDashboardScreenProps {
  initialServerId?: string | null;
  initialAgentId?: string | null;
}

export function JevDashboardScreen({
  initialServerId,
  initialAgentId,
}: JevDashboardScreenProps): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return (
    <JevDashboardScreenContent
      initialServerId={initialServerId ?? null}
      initialAgentId={initialAgentId ?? null}
    />
  );
}

function JevDashboardScreenContent({
  initialServerId,
  initialAgentId,
}: {
  initialServerId: string | null;
  initialAgentId: string | null;
}): ReactElement {
  const hosts = useHosts();
  const activeWorkspace = useActiveWorkspaceSelection();
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    initialServerId ?? activeWorkspace?.serverId ?? hosts[0]?.serverId ?? null,
  );
  const [range, setRange] = useState<JevSavingsRange>("today");
  const [featureFilter, setFeatureFilter] = useState<string | undefined>(undefined);
  const agentFilter = initialAgentId ?? undefined;

  const serverId =
    selectedServerId && hosts.some((host) => host.serverId === selectedServerId)
      ? selectedServerId
      : (hosts[0]?.serverId ?? null);

  const hostStatus = useJevDashboardHostStatus(serverId);
  const summaryQuery = useJevSavingsSummary(serverId, range, { enabled: true });
  const eventsQuery = useJevSavingsEvents(
    serverId,
    { range, feature: featureFilter, agentId: agentFilter },
    { enabled: true },
  );

  const availability = resolveJevDashboardAvailability({
    hasHost: serverId !== null,
    connected: hostStatus.connected,
    supportsJev: hostStatus.supportsJev,
    supportsSavings: hostStatus.supportsSavings,
    keyPresent: hostStatus.status?.keyPresent ?? null,
  });

  const openAgent = useCallback(
    (targetAgentId: string, workspaceId: string | null) => {
      if (!serverId) return;
      router.push(buildHostAgentDetailRoute(serverId, targetAgentId, workspaceId ?? undefined));
    },
    [serverId],
  );
  const openWorkspace = useCallback(
    (workspaceId: string) => {
      if (!serverId) return;
      router.push(buildHostWorkspaceRoute(serverId, workspaceId));
    },
    [serverId],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="JEV dashboard" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="jev-dashboard-screen"
      >
        <View style={styles.column}>
          {hosts.length > 1 ? (
            <HostField hosts={hosts} selectedServerId={serverId} onChange={setSelectedServerId} />
          ) : null}
          <NotConfiguredBanner availability={availability} />
          {availability.kind === "ready" || availability.kind === "not-configured" ? (
            <JevDashboardReadyContent
              summary={summaryQuery.data}
              isLoading={summaryQuery.isLoading}
              events={eventsQuery.events}
              isLoadingEvents={eventsQuery.isLoading}
              isLoadingMoreEvents={eventsQuery.isLoadingMore}
              hasMoreEvents={eventsQuery.hasMore}
              onLoadMoreEvents={eventsQuery.loadMore}
              range={range}
              onRangeChange={setRange}
              featureFilter={featureFilter}
              onFeatureFilterChange={setFeatureFilter}
              onOpenAgent={openAgent}
              onOpenWorkspace={openWorkspace}
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
