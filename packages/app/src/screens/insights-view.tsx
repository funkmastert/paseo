import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  buildCompactionInsightsTiles,
  compactionOutcomeLabel,
  compactionOutcomeVariant,
  formatEpisodeContext,
  formatEpisodeCost,
  formatEpisodePayback,
  formatEpisodePromptsCarried,
  formatEpisodeQuietGate,
  formatEpisodeTrigger,
  type CompactionInsightsTile,
} from "@/compactions/compaction-insights-model";
import type {
  CompactionEpisode,
  CompactionEpisodesSummary,
} from "@/compactions/use-compaction-episodes";
import type { CompactionRange } from "@/compactions/use-compaction-episodes";

/**
 * The Insights screen's presentational pieces: no `expo-router`, no host-runtime hooks. A capture
 * (or this screen's browser test) can mount these directly with fixture data -- the same
 * constraint `jev-dashboard-view.tsx` and `token-usage-view.tsx` follow.
 */

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export const INSIGHTS_RANGE_OPTIONS: SegmentedControlOption<CompactionRange>[] = [
  { value: "today", label: "Today", testID: "insights-range-today" },
  { value: "7d", label: "7 days", testID: "insights-range-7d" },
  { value: "all", label: "All", testID: "insights-range-all" },
];

export type InsightsAvailability =
  | { kind: "no-host" }
  | { kind: "connecting" }
  | { kind: "update-host" }
  | { kind: "ready" };

export function resolveInsightsAvailability(input: {
  hasHost: boolean;
  connected: boolean;
  supported: boolean;
}): InsightsAvailability {
  if (!input.hasHost) return { kind: "no-host" };
  if (!input.connected) return { kind: "connecting" };
  if (!input.supported) return { kind: "update-host" };
  return { kind: "ready" };
}

export function InsightsAvailabilityBanner({
  availability,
}: {
  availability: InsightsAvailability;
}) {
  switch (availability.kind) {
    case "no-host":
      return (
        <Alert
          title="No host"
          description="Add a host to see Insights."
          testID="insights-no-host"
        />
      );
    case "connecting":
      return <Alert title="Waiting for the host to connect" testID="insights-connecting" />;
    case "update-host":
      return (
        <Alert
          variant="info"
          title="Update the host for Insights"
          description="This host's daemon is older than Insights. Update it, then come back."
          testID="insights-update-host"
        />
      );
    case "ready":
      return null;
  }
}

export interface InsightsReadyContentProps {
  summary: CompactionEpisodesSummary | undefined;
  isLoadingSummary: boolean;
  episodes: CompactionEpisode[];
  isLoadingEpisodes: boolean;
  isLoadingMoreEpisodes: boolean;
  hasMoreEpisodes: boolean;
  onLoadMoreEpisodes: () => void;
  range: CompactionRange;
  onRangeChange: (range: CompactionRange) => void;
  onOpenJevDashboard: () => void;
  onOpenDecisions: () => void;
  onOpenTokenUsage: () => void;
}

export function InsightsReadyContent({
  summary,
  isLoadingSummary,
  episodes,
  isLoadingEpisodes,
  isLoadingMoreEpisodes,
  hasMoreEpisodes,
  onLoadMoreEpisodes,
  range,
  onRangeChange,
  onOpenJevDashboard,
  onOpenDecisions,
  onOpenTokenUsage,
}: InsightsReadyContentProps) {
  return (
    <View style={styles.readyColumn}>
      <DashboardLinks
        onOpenJevDashboard={onOpenJevDashboard}
        onOpenDecisions={onOpenDecisions}
        onOpenTokenUsage={onOpenTokenUsage}
      />
      <View style={styles.section}>
        <Text style={styles.sectionHeading}>Compactions</Text>
        <SegmentedControl
          size="sm"
          value={range}
          onValueChange={onRangeChange}
          options={INSIGHTS_RANGE_OPTIONS}
          testID="insights-range"
        />
        {isLoadingSummary && !summary ? (
          <View style={styles.loadingRow}>
            <ThemedLoadingSpinner size={14} />
            <Text style={styles.muted}>Loading...</Text>
          </View>
        ) : null}
        {summary ? <TilesRow tiles={buildCompactionInsightsTiles(summary)} /> : null}
        <CompactionEpisodesListView
          episodes={episodes}
          isLoading={isLoadingEpisodes}
          isLoadingMore={isLoadingMoreEpisodes}
          hasMore={hasMoreEpisodes}
          onLoadMore={onLoadMoreEpisodes}
        />
      </View>
    </View>
  );
}

function DashboardLinks({
  onOpenJevDashboard,
  onOpenDecisions,
  onOpenTokenUsage,
}: {
  onOpenJevDashboard: () => void;
  onOpenDecisions: () => void;
  onOpenTokenUsage: () => void;
}) {
  return (
    <View style={styles.card} testID="insights-dashboard-links">
      <DashboardLinkRow label="JEV dashboard" onPress={onOpenJevDashboard} bordered={false} />
      <DashboardLinkRow
        label="Decisions (Settings → Agent roles)"
        onPress={onOpenDecisions}
        bordered
      />
      <DashboardLinkRow label="Token usage" onPress={onOpenTokenUsage} bordered />
    </View>
  );
}

function DashboardLinkRow({
  label,
  onPress,
  bordered,
}: {
  label: string;
  onPress: () => void;
  bordered: boolean;
}) {
  return (
    <Pressable
      style={[styles.linkRow, bordered ? styles.featureRowBorder : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.linkLabel}>{label}</Text>
      <ThemedChevronRight size={16} />
    </Pressable>
  );
}

function TilesRow({ tiles }: { tiles: CompactionInsightsTile[] }) {
  const isCompact = useIsCompactFormFactor();
  return (
    <View style={[styles.tilesRow, isCompact ? styles.tilesRowCompact : null]}>
      {tiles.map((tile) => (
        <View
          key={tile.id}
          style={[styles.tile, isCompact ? styles.tileCompact : null]}
          testID={`insights-tile-${tile.id}`}
        >
          <Text style={styles.tileLabel}>{tile.label}</Text>
          <Text style={styles.tileValue}>{tile.value}</Text>
          <Text style={styles.tileCaption}>{tile.caption}</Text>
        </View>
      ))}
    </View>
  );
}

function CompactionEpisodesListBody({
  episodes,
  isLoading,
}: {
  episodes: CompactionEpisode[];
  isLoading: boolean;
}) {
  if (isLoading && episodes.length === 0) {
    return (
      <View style={styles.loadingRow}>
        <ThemedLoadingSpinner size={14} />
        <Text style={styles.muted}>Loading...</Text>
      </View>
    );
  }
  if (episodes.length === 0) {
    return (
      <Text style={styles.rowHint} testID="insights-compaction-empty">
        No compactions yet
      </Text>
    );
  }
  return (
    <View style={styles.card}>
      {episodes.map((episode, index) => (
        <CompactionEpisodeRow key={episode.id} episode={episode} bordered={index > 0} />
      ))}
    </View>
  );
}

function CompactionEpisodesListView({
  episodes,
  isLoading,
  isLoadingMore,
  hasMore,
  onLoadMore,
}: {
  episodes: CompactionEpisode[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <View testID="insights-compaction-list">
      <CompactionEpisodesListBody episodes={episodes} isLoading={isLoading} />
      {hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={onLoadMore}
          loading={isLoadingMore}
          style={styles.loadMore}
          testID="insights-load-more"
        >
          {isLoadingMore ? "Loading..." : "Load more"}
        </Button>
      ) : null}
    </View>
  );
}

function CompactionEpisodeRow({
  episode,
  bordered,
}: {
  episode: CompactionEpisode;
  bordered: boolean;
}) {
  const quietGateLine = formatEpisodeQuietGate(episode);
  const promptsCarriedLine = formatEpisodePromptsCarried(episode);
  return (
    <View
      style={[styles.eventRow, bordered ? styles.featureRowBorder : null]}
      testID={`insights-compaction-${episode.id}`}
    >
      <View style={styles.eventRowHeader}>
        <Text style={styles.featureLabel}>{episode.agentTitle ?? episode.agentId}</Text>
        <StatusBadge
          label={compactionOutcomeLabel(episode.outcome)}
          variant={compactionOutcomeVariant(episode.outcome)}
        />
      </View>
      <Text style={styles.eventTime}>{new Date(episode.startedAtMs).toLocaleString()}</Text>
      <Text style={styles.featureMeta}>
        {formatEpisodeContext(episode)} · {formatEpisodeTrigger(episode)}
      </Text>
      <Text style={styles.featureMeta}>
        Cost {formatEpisodeCost(episode)} · Payback {formatEpisodePayback(episode)}
      </Text>
      {quietGateLine || promptsCarriedLine ? (
        <Text style={styles.featureMeta}>
          {[quietGateLine, promptsCarriedLine].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  readyColumn: {
    gap: theme.spacing[6],
  },
  section: {
    gap: theme.spacing[3],
  },
  sectionHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginLeft: theme.spacing[1],
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
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[4],
  },
  linkLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  featureRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  tilesRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  tilesRowCompact: {
    flexDirection: "column",
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
  // Stacked, the row's 160 basis would become each tile's height.
  tileCompact: {
    flexBasis: "auto",
  },
  tileLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tileValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
  },
  tileCaption: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  eventRow: {
    padding: theme.spacing[4],
    gap: theme.spacing[1],
  },
  eventRowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eventTime: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  featureLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  featureMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loadMore: {
    alignSelf: "center",
    marginTop: theme.spacing[2],
  },
}));
