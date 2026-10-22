import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingScrollView } from "@/components/ui/floating";
import { formatDuration } from "@/utils/time";
import {
  compactionOutcomeLabel,
  formatEpisodePayback,
  formatEpisodePromptsCarried,
  formatEpisodeQuietGate,
  formatStepCost,
} from "./compaction-insights-model";
import type { CompactionEpisode } from "./use-compaction-episodes";

// Matches JevMarkerChip's popover sizing (jev-marker-chip.tsx) -- the same tap/hover detail
// popover shape, tuned for the same column width.
const MARKER_POPOVER_MAX_HEIGHT = 320;
/** A carried prompt is quoted, not replayed: enough lines to recognise it. */
const CARRIED_PROMPT_LINES = 4;

function formatClockTime(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatStepDuration(startedAtMs: number, endedAtMs: number | null): string {
  if (endedAtMs === null) return new Date(startedAtMs).toLocaleTimeString();
  return `${new Date(startedAtMs).toLocaleTimeString()} · ${formatDuration(endedAtMs - startedAtMs)}`;
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
  const quietGateLine = formatEpisodeQuietGate(episode);
  const promptsCarriedLine = formatEpisodePromptsCarried(episode);
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
                <Text style={styles.cost}>{formatStepCost(step)}</Text>
              </View>
            ))}
            <Text style={styles.muted}>Payback {formatEpisodePayback(episode)}</Text>
            {quietGateLine && episode.quietGate ? (
              <Text style={styles.muted} testID="compaction-marker-quiet-gate">
                {quietGateLine}, {formatClockTime(episode.quietGate.heldFromMs)} to{" "}
                {formatClockTime(episode.quietGate.heldUntilMs)}
              </Text>
            ) : null}
            {promptsCarriedLine && episode.promptsCarried ? (
              <View style={styles.prompts} testID="compaction-marker-prompts">
                <Text style={styles.muted}>{promptsCarriedLine}</Text>
                {episode.promptsCarried.map((prompt) => (
                  <Text
                    key={`${prompt.atMs}-${prompt.text.length}`}
                    style={styles.prompt}
                    numberOfLines={CARRIED_PROMPT_LINES}
                  >
                    {formatClockTime(prompt.atMs)} “{prompt.text}”
                  </Text>
                ))}
              </View>
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
  prompts: {
    gap: theme.spacing[1],
  },
  prompt: {
    color: theme.colors.foreground,
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
