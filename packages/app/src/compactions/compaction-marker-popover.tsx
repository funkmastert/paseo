import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingScrollView } from "@/components/ui/floating";
import {
  compactionOutcomeLabel,
  formatCompactionTokens,
  formatEpisodePayback,
} from "./compaction-insights-model";
import type { CompactionEpisode } from "./use-compaction-episodes";

const MARKER_POPOVER_MAX_HEIGHT = 320;

function formatStepCost(costWeightedTokens: number | null): string {
  return costWeightedTokens === null ? "not measured" : formatCompactionTokens(costWeightedTokens);
}

function formatStepDuration(startedAtMs: number, endedAtMs: number | null): string {
  if (endedAtMs === null) return new Date(startedAtMs).toLocaleTimeString();
  const seconds = Math.round((endedAtMs - startedAtMs) / 1000);
  return `${new Date(startedAtMs).toLocaleTimeString()} · ${seconds}s`;
}

/**
 * The timeline compaction marker's detail popover, opened by hover (desktop) or a tap (phone) --
 * the same `Tooltip` pattern `JevMarkerChip` uses. Shown only once a `CompactionItem` has joined
 * to a ledger episode (docs/insights.md); an unjoined marker renders `children` with no popover.
 */
export function CompactionMarkerPopover({
  episode,
  children,
}: {
  episode: CompactionEpisode;
  children: ReactNode;
}) {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger accessibilityLabel="Compaction details" testID="compaction-marker-trigger">
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" align="start" offset={8}>
        <FloatingScrollView style={styles.popoverScroll} showsVerticalScrollIndicator={false}>
          <View style={styles.popoverContent} testID="compaction-marker-popover">
            <Text style={styles.outcome}>{compactionOutcomeLabel(episode.outcome)}</Text>
            {episode.steps.map((step) => (
              <View key={`${step.step}-${step.startedAtMs}`} style={styles.stepRow}>
                <Text style={styles.stepName}>{step.step}</Text>
                <Text style={styles.muted}>
                  {formatStepDuration(step.startedAtMs, step.endedAtMs)}
                </Text>
                <Text style={styles.cost}>{formatStepCost(step.costWeightedTokens)}</Text>
              </View>
            ))}
            <Text style={styles.muted}>Payback {formatEpisodePayback(episode)}</Text>
            {episode.quietGate ? (
              <Text style={styles.muted}>
                Waited {episode.quietGate.quietMinutes}m quiet, under{" "}
                {formatCompactionTokens(episode.quietGate.ceilingTokens)}
              </Text>
            ) : null}
            {episode.promptsCarried !== null && episode.promptsCarried !== undefined ? (
              <Text style={styles.muted}>
                {episode.promptsCarried} prompt{episode.promptsCarried === 1 ? "" : "s"} carried
              </Text>
            ) : null}
          </View>
        </FloatingScrollView>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  popoverScroll: {
    maxHeight: MARKER_POPOVER_MAX_HEIGHT,
  },
  popoverContent: {
    gap: theme.spacing[2],
    minWidth: 220,
  },
  outcome: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: theme.spacing[2],
  },
  stepName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textTransform: "capitalize",
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  cost: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
