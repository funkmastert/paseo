import { useCallback, useMemo, useState, type ReactElement } from "react";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  buildJevDashboardDayBars,
  buildJevDashboardFeatureRows,
  buildJevDashboardTiles,
  formatOtherBenefit,
  formatTokens,
  formatUsd,
  type JevDashboardDayBar,
  type JevDashboardFeatureRow,
  type JevDashboardTile,
} from "@/jev/jev-dashboard-model";
import type { JevSavingsEvent, JevSavingsRange } from "@/jev/jev-savings-types";
import { useJevDashboardHostStatus } from "@/jev/use-jev-dashboard-host-status";
import { useJevSavingsEvents } from "@/jev/use-jev-savings-events";
import { useJevSavingsSummary } from "@/jev/use-jev-savings-summary";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const RANGE_OPTIONS: SegmentedControlOption<JevSavingsRange>[] = [
  { value: "today", label: "Today", testID: "jev-dashboard-range-today" },
  { value: "7d", label: "7 days", testID: "jev-dashboard-range-7d" },
  { value: "all", label: "All", testID: "jev-dashboard-range-all" },
];

interface JevDashboardTopEntry {
  id: string;
  label: string | null;
  involvements: number;
  liveTokens: number;
  shadowTokens: number;
}

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

function HostField({
  hosts,
  selectedServerId,
  onChange,
}: {
  hosts: { serverId: string; label: string }[];
  selectedServerId: string | null;
  onChange: (serverId: string) => void;
}) {
  const options = useMemo<SelectFieldOption<string>[]>(
    () => hosts.map((host) => ({ id: host.serverId, value: host.serverId, label: host.label })),
    [hosts],
  );
  const selected = hosts.find((host) => host.serverId === selectedServerId);
  const display = useMemo<SelectFieldDisplay>(
    () => ({ label: selected?.label ?? "Select host" }),
    [selected?.label],
  );
  return (
    <SelectField
      label="Host"
      value={selectedServerId ?? ""}
      selectedDisplay={display}
      options={options}
      onChange={onChange}
      placeholder="Select host"
      emptyText="No hosts found"
      searchable={false}
      title="Host"
      size="sm"
      triggerTestID="jev-dashboard-host-trigger"
    />
  );
}

type JevDashboardAvailability =
  | { kind: "no-host" }
  | { kind: "connecting" }
  | { kind: "update-host" }
  | { kind: "not-configured" }
  | { kind: "ready" };

function resolveJevDashboardAvailability(input: {
  hasHost: boolean;
  connected: boolean;
  supportsJev: boolean;
  supportsSavings: boolean;
  keyPresent: boolean | null;
}): JevDashboardAvailability {
  if (!input.hasHost) return { kind: "no-host" };
  if (!input.connected) return { kind: "connecting" };
  if (!input.supportsJev || !input.supportsSavings) return { kind: "update-host" };
  if (input.keyPresent === false) return { kind: "not-configured" };
  return { kind: "ready" };
}

function NotConfiguredBanner({ availability }: { availability: JevDashboardAvailability }) {
  switch (availability.kind) {
    case "no-host":
      return (
        <Alert
          title="No host"
          description="Add a host to see JEV activity."
          testID="jev-dashboard-no-host"
        />
      );
    case "connecting":
      return <Alert title="Waiting for the host to connect" testID="jev-dashboard-connecting" />;
    case "update-host":
      return (
        <Alert
          variant="info"
          title="Update the host for the JEV dashboard"
          description="This host's daemon is older than the JEV dashboard. Update it, then come back."
          testID="jev-dashboard-update-host"
        />
      );
    case "not-configured":
      return (
        <Alert
          variant="warning"
          title="JEV is not configured on this host"
          description="Nothing is sent to JEV until a key is added, but anything the ledger already recorded still shows below."
          testID="jev-dashboard-not-configured"
        />
      );
    case "ready":
      return null;
  }
}

function JevDashboardReadyContent({
  summary,
  isLoading,
  events,
  isLoadingEvents,
  isLoadingMoreEvents,
  hasMoreEvents,
  onLoadMoreEvents,
  range,
  onRangeChange,
  featureFilter,
  onFeatureFilterChange,
  onOpenAgent,
  onOpenWorkspace,
}: {
  summary: ReturnType<typeof useJevSavingsSummary>["data"];
  isLoading: boolean;
  events: JevSavingsEvent[];
  isLoadingEvents: boolean;
  isLoadingMoreEvents: boolean;
  hasMoreEvents: boolean;
  onLoadMoreEvents: () => void;
  range: JevSavingsRange;
  onRangeChange: (range: JevSavingsRange) => void;
  featureFilter: string | undefined;
  onFeatureFilterChange: (feature: string | undefined) => void;
  onOpenAgent: (agentId: string, workspaceId: string | null) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}) {
  return (
    <View style={styles.readyColumn}>
      <SegmentedControl
        size="sm"
        value={range}
        onValueChange={onRangeChange}
        options={RANGE_OPTIONS}
        testID="jev-dashboard-range"
      />
      {isLoading && !summary ? (
        <View style={styles.loadingRow}>
          <ThemedLoadingSpinner size={14} />
          <Text style={styles.muted}>Loading...</Text>
        </View>
      ) : null}
      {summary ? (
        <>
          <TilesRow tiles={buildJevDashboardTiles(summary)} />
          <DayBarsChart bars={buildJevDashboardDayBars(summary.days)} />
          <FeatureTable
            rows={buildJevDashboardFeatureRows(summary)}
            selectedFeature={featureFilter}
            onSelectFeature={onFeatureFilterChange}
          />
          <TopLists
            topAgents={summary.topAgents}
            topWorkspaces={summary.topWorkspaces}
            onOpenAgent={onOpenAgent}
            onOpenWorkspace={onOpenWorkspace}
          />
        </>
      ) : null}
      <RecentEvents
        events={events}
        isLoading={isLoadingEvents}
        isLoadingMore={isLoadingMoreEvents}
        hasMore={hasMoreEvents}
        onLoadMore={onLoadMoreEvents}
        onOpenAgent={onOpenAgent}
      />
    </View>
  );
}

function TilesRow({ tiles }: { tiles: JevDashboardTile[] }) {
  const isCompact = useIsCompactFormFactor();
  return (
    <View style={[styles.tilesRow, isCompact ? styles.tilesRowCompact : null]}>
      {tiles.map((tile) => (
        <View key={tile.id} style={styles.tile} testID={`jev-dashboard-tile-${tile.id}`}>
          <Text style={styles.tileLabel}>{tile.label}</Text>
          <Text style={[styles.tileValue, tile.tone === "shadow" ? styles.tileValueShadow : null]}>
            {formatTokens(tile.tokens ?? 0)}
          </Text>
          {tile.usd !== null ? (
            <Text style={styles.tileSubValue}>{formatUsd(tile.usd)}</Text>
          ) : null}
          <Text style={styles.tileCaption}>{tile.caption}</Text>
        </View>
      ))}
      <Text style={styles.unitCaption}>
        Opus-equivalent tokens: weighted tokens at Opus 5.5 prices
      </Text>
    </View>
  );
}

function DayBarsChart({ bars }: { bars: JevDashboardDayBar[] }) {
  if (bars.length === 0) return null;
  return (
    <View style={styles.daysCard} testID="jev-dashboard-day-bars">
      <View style={styles.daysLegend}>
        <LegendDot tone="live" label="Live" />
        <LegendDot tone="shadow" label="Shadow" />
      </View>
      <View style={styles.daysRow}>
        {bars.map((bar) => (
          <View key={bar.day} style={styles.dayColumn}>
            <View style={styles.dayBarTrack}>
              <View
                style={[
                  styles.dayBarFill,
                  styles.dayBarLive,
                  { height: `${bar.liveFraction * 100}%` },
                ]}
              />
            </View>
            <View style={styles.dayBarTrack}>
              <View
                style={[
                  styles.dayBarFill,
                  styles.dayBarShadow,
                  { height: `${bar.shadowFraction * 100}%` },
                ]}
              />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function LegendDot({ tone, label }: { tone: "live" | "shadow"; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View
        style={[styles.legendDot, tone === "live" ? styles.legendDotLive : styles.legendDotShadow]}
      />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

function FeatureTable({
  rows,
  selectedFeature,
  onSelectFeature,
}: {
  rows: JevDashboardFeatureRow[];
  selectedFeature: string | undefined;
  onSelectFeature: (feature: string | undefined) => void;
}) {
  return (
    <View style={styles.card} testID="jev-dashboard-feature-table">
      {rows.map((row, index) => (
        <FeatureRow
          key={row.feature}
          row={row}
          bordered={index > 0}
          selectedFeature={selectedFeature}
          onSelectFeature={onSelectFeature}
        />
      ))}
    </View>
  );
}

function evidencePrefix(met: boolean | null): string {
  if (met === true) return "Met: ";
  if (met === false) return "Not yet: ";
  return "";
}

function FeatureRow({
  row,
  bordered,
  selectedFeature,
  onSelectFeature,
}: {
  row: JevDashboardFeatureRow;
  bordered: boolean;
  selectedFeature: string | undefined;
  onSelectFeature: (feature: string | undefined) => void;
}) {
  const selected = selectedFeature === row.feature;
  const handlePress = useCallback(
    () => onSelectFeature(selected ? undefined : row.feature),
    [onSelectFeature, row.feature, selected],
  );
  return (
    <Pressable
      style={[
        styles.featureRow,
        bordered ? styles.featureRowBorder : null,
        selected ? styles.featureRowSelected : null,
      ]}
      testID={`jev-dashboard-feature-${row.feature}`}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Filter recent events to ${row.label}`}
    >
      <View style={styles.featureRowHeader}>
        <Text style={styles.featureLabel}>{row.label}</Text>
        <Text style={styles.featureState}>{row.stateLabel}</Text>
      </View>
      <Text style={styles.featureMeta}>
        {row.involvements} involvement{row.involvements === 1 ? "" : "s"}
        {row.notAskedTotal > 0 ? ` · ${row.notAskedTotal} not asked` : ""}
      </Text>
      {row.liveTokens !== null || row.shadowTokens !== null ? (
        <Text style={styles.featureMeta}>
          {row.liveTokens !== null ? `Live ${formatTokens(row.liveTokens)}` : null}
          {row.liveTokens !== null && row.shadowTokens !== null ? " · " : null}
          {row.shadowTokens !== null ? `Would have ${formatTokens(row.shadowTokens)}` : null}
        </Text>
      ) : null}
      {row.otherBenefitText ? <Text style={styles.featureMeta}>{row.otherBenefitText}</Text> : null}
      {row.wrongRatePct !== null ? (
        <Text style={styles.featureMeta}>Wrong rate {row.wrongRatePct.toFixed(1)}%</Text>
      ) : null}
      <Text style={styles.featureMeta}>JEV cost {formatUsd(row.jevUsd)}</Text>
      <Text style={styles.featureEvidence}>
        {evidencePrefix(row.evidenceMet)}
        {row.evidenceObserved}
      </Text>
    </Pressable>
  );
}

function TopLists({
  topAgents,
  topWorkspaces,
  onOpenAgent,
  onOpenWorkspace,
}: {
  topAgents: JevDashboardTopEntry[];
  topWorkspaces: JevDashboardTopEntry[];
  onOpenAgent: (agentId: string, workspaceId: string | null) => void;
  onOpenWorkspace: (workspaceId: string) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const openAgentFromTopList = useCallback(
    (agentId: string) => onOpenAgent(agentId, null),
    [onOpenAgent],
  );
  return (
    <View style={[styles.topListsRow, isCompact ? styles.topListsRowCompact : null]}>
      <TopList
        title="Top agents"
        entries={topAgents}
        testID="jev-dashboard-top-agents"
        onPress={openAgentFromTopList}
      />
      <TopList
        title="Top workspaces"
        entries={topWorkspaces}
        testID="jev-dashboard-top-workspaces"
        onPress={onOpenWorkspace}
      />
    </View>
  );
}

function TopList({
  title,
  entries,
  testID,
  onPress,
}: {
  title: string;
  entries: JevDashboardTopEntry[];
  testID: string;
  onPress: (id: string) => void;
}) {
  return (
    <View style={styles.topListColumn} testID={testID}>
      <Text style={styles.sectionHeading}>{title}</Text>
      <View style={styles.card}>
        {entries.length === 0 ? (
          <Text style={[styles.rowHint, styles.topListEmpty]}>No activity yet</Text>
        ) : (
          entries.map((entry, index) => (
            <TopListRow key={entry.id} entry={entry} bordered={index > 0} onPress={onPress} />
          ))
        )}
      </View>
    </View>
  );
}

function TopListRow({
  entry,
  bordered,
  onPress,
}: {
  entry: JevDashboardTopEntry;
  bordered: boolean;
  onPress: (id: string) => void;
}) {
  const handlePress = useCallback(() => onPress(entry.id), [entry.id, onPress]);
  return (
    <Pressable
      style={[styles.topListRow, bordered ? styles.featureRowBorder : null]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={entry.label ?? entry.id}
    >
      <Text style={styles.topListLabel}>{entry.label ?? entry.id}</Text>
      <Text style={styles.featureMeta}>
        {entry.involvements} · live {formatTokens(entry.liveTokens)} · would have{" "}
        {formatTokens(entry.shadowTokens)}
      </Text>
    </Pressable>
  );
}

function RecentEventsBody({
  events,
  isLoading,
  onOpenAgent,
}: {
  events: JevSavingsEvent[];
  isLoading: boolean;
  onOpenAgent: (agentId: string, workspaceId: string | null) => void;
}) {
  if (isLoading && events.length === 0) {
    return (
      <View style={styles.loadingRow}>
        <ThemedLoadingSpinner size={14} />
        <Text style={styles.muted}>Loading...</Text>
      </View>
    );
  }
  if (events.length === 0) {
    return <Text style={styles.rowHint}>No JEV activity yet</Text>;
  }
  return (
    <View style={styles.card}>
      {events.map((event, index) => (
        <RecentEventRow
          key={event.id}
          event={event}
          bordered={index > 0}
          onOpenAgent={onOpenAgent}
        />
      ))}
    </View>
  );
}

function RecentEvents({
  events,
  isLoading,
  isLoadingMore,
  hasMore,
  onLoadMore,
  onOpenAgent,
}: {
  events: JevSavingsEvent[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpenAgent: (agentId: string, workspaceId: string | null) => void;
}) {
  return (
    <View testID="jev-dashboard-recent-events">
      <Text style={styles.sectionHeading}>Recent</Text>
      <RecentEventsBody events={events} isLoading={isLoading} onOpenAgent={onOpenAgent} />
      {hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={onLoadMore}
          loading={isLoadingMore}
          style={styles.loadMore}
          testID="jev-dashboard-load-more"
        >
          {isLoadingMore ? "Loading..." : "Load more"}
        </Button>
      ) : null}
    </View>
  );
}

function formatEventTokenOrPending(event: JevSavingsEvent): string | null {
  if (event.pending) return "pending";
  if (event.tokensSavedEstimate !== null) return formatTokens(event.tokensSavedEstimate);
  if (event.otherBenefit) return formatOtherBenefit(event.otherBenefit);
  return null;
}

function RecentEventRow({
  event,
  bordered,
  onOpenAgent,
}: {
  event: JevSavingsEvent;
  bordered: boolean;
  onOpenAgent: (agentId: string, workspaceId: string | null) => void;
}) {
  const tokenOrPending = formatEventTokenOrPending(event);
  const agentId = event.agentId;
  const workspaceId = event.workspaceId;
  const handlePress = useCallback(() => {
    if (agentId) onOpenAgent(agentId, workspaceId);
  }, [agentId, onOpenAgent, workspaceId]);
  return (
    <Pressable
      style={[styles.eventRow, bordered ? styles.featureRowBorder : null]}
      onPress={agentId ? handlePress : undefined}
      disabled={!agentId}
      testID={`jev-dashboard-event-${event.id}`}
    >
      <Text style={styles.eventTime}>{new Date(event.at).toLocaleString()}</Text>
      <Text style={styles.featureLabel}>{event.involvement}</Text>
      <Text style={styles.featureMeta}>
        {event.decision.did}
        {event.decision.wouldBe && event.decision.wouldBe !== event.decision.did
          ? ` (would: ${event.decision.wouldBe})`
          : ""}
      </Text>
      <Text style={styles.featureMeta}>
        {event.mode === "shadow" ? "Shadow" : "Live"}
        {tokenOrPending ? ` · ${tokenOrPending}` : ""}
      </Text>
    </Pressable>
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
  readyColumn: {
    gap: theme.spacing[6],
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tilesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  tilesRowCompact: {
    flexDirection: "row",
  },
  tile: {
    flexGrow: 1,
    flexBasis: 160,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  tileLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tileValue: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize["2xl"],
  },
  tileValueShadow: {
    color: theme.colors.statusWarning,
  },
  tileSubValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tileCaption: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  unitCaption: {
    width: "100%",
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  daysCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  daysLegend: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendDotLive: {
    backgroundColor: theme.colors.statusSuccess,
  },
  legendDotShadow: {
    backgroundColor: theme.colors.statusWarning,
  },
  legendLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  daysRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
    height: 96,
  },
  dayColumn: {
    flexDirection: "row",
    flex: 1,
    height: "100%",
    gap: 2,
    alignItems: "flex-end",
  },
  dayBarTrack: {
    flex: 1,
    height: "100%",
    justifyContent: "flex-end",
  },
  dayBarFill: {
    width: "100%",
    minHeight: 2,
    borderRadius: 2,
  },
  dayBarLive: {
    backgroundColor: theme.colors.statusSuccess,
  },
  dayBarShadow: {
    backgroundColor: theme.colors.statusWarning,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  featureRow: {
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  featureRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  featureRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  featureRowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  featureLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  featureState: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  featureMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  featureEvidence: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  sectionHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  topListsRow: {
    flexDirection: "row",
    gap: theme.spacing[4],
  },
  topListsRowCompact: {
    flexDirection: "column",
  },
  topListColumn: {
    flex: 1,
    minWidth: 0,
  },
  topListRow: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  topListLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  topListEmpty: {
    padding: theme.spacing[3],
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  eventRow: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  eventTime: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  loadMore: {
    alignSelf: "center",
    marginTop: theme.spacing[2],
  },
}));
