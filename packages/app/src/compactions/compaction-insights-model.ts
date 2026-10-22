import { formatTokens } from "@/jev/jev-dashboard-model";
import { formatDuration } from "@/utils/time";
import type { CompactionEpisode, CompactionEpisodesSummary } from "./use-compaction-episodes";

type CompactionStep = CompactionEpisode["steps"][number];

/**
 * Pure formatting for the Insights screen's Compactions section and the timeline's compaction
 * marker (docs/insights.md). Shared so the two surfaces never disagree about what a figure means.
 */

/** Compacted token count, matching the JEV dashboard's own tile formatting: 1,284 / 12.4k / 3.1M. */
export const formatCompactionTokens = formatTokens;

/** The episode's own cost: a figure when measured, an explicit "not measured" when not. */
export function formatEpisodeCost(episode: CompactionEpisode): string {
  if (episode.costBasis !== "measured" || episode.costWeightedTokens === null) {
    return "not measured";
  }
  return formatCompactionTokens(episode.costWeightedTokens);
}

/** One step's own cost, or why it has none: a message steered into its turn shares the spend. */
export function formatStepCost(step: CompactionStep): string {
  if (step.costWeightedTokens !== null) return formatCompactionTokens(step.costWeightedTokens);
  const steeredIn = step.steeredIn ?? 0;
  if (steeredIn > 0) {
    return `not measured: ${steeredIn} message${steeredIn === 1 ? "" : "s"} joined`;
  }
  return "not measured";
}

/** "Waited 7m for quiet" when the quiet gate held the start; null when it did not. */
export function formatEpisodeQuietGate(episode: CompactionEpisode): string | null {
  if (!episode.quietGate) return null;
  return `Waited ${formatDuration(episode.quietGate.heldMs)} for quiet`;
}

/** "2 prompts carried" into the restore message; null when there were none. */
export function formatEpisodePromptsCarried(episode: CompactionEpisode): string | null {
  const count = episode.promptsCarried?.length ?? 0;
  if (count === 0) return null;
  return `${count} prompt${count === 1 ? "" : "s"} carried`;
}

/** The payback estimate: an em dash when nothing has been computed yet. */
export function formatEpisodePayback(episode: CompactionEpisode): string {
  if (episode.estimatedSavedWeightedTokens === null) return "—";
  return `~${formatCompactionTokens(episode.estimatedSavedWeightedTokens)} est.`;
}

/** "612k → 31k tokens", or just the one side known. */
export function formatEpisodeContext(episode: CompactionEpisode): string {
  const before = episode.contextBeforeTokens;
  const after = episode.contextAfterTokens;
  if (before !== null && after !== null) {
    return `${formatCompactionTokens(before)} → ${formatCompactionTokens(after)} tokens`;
  }
  if (before !== null) return `${formatCompactionTokens(before)} tokens`;
  if (after !== null) return `${formatCompactionTokens(after)} tokens`;
  return "unknown context size";
}

export function formatEpisodeTrigger(episode: CompactionEpisode): string {
  switch (episode.trigger) {
    case "line":
      return "crossed the line";
    case "early":
      return episode.triggerReason ?? "started early";
    case "auto":
      return "Claude Code auto-compact";
    case "manual":
      return "manual /compact";
    default:
      return episode.trigger;
  }
}

export type CompactionOutcomeVariant = "success" | "warning" | "error" | "muted";

export function compactionOutcomeLabel(outcome: CompactionEpisode["outcome"]): string {
  switch (outcome) {
    case "done":
      return "Done";
    case "gaveUp":
      return "Gave up";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown";
  }
}

export function compactionOutcomeVariant(
  outcome: CompactionEpisode["outcome"],
): CompactionOutcomeVariant {
  switch (outcome) {
    case "done":
      return "success";
    case "gaveUp":
    case "interrupted":
      return "warning";
    case "cancelled":
      return "error";
    default:
      return "muted";
  }
}

/** A few minutes either side covers prepare->compact->restore's real wall-clock spread. */
export const COMPACTION_MARKER_MATCH_TOLERANCE_MS = 10 * 60 * 1000;

function distanceToEpisodeMs(episode: CompactionEpisode, timestampMs: number): number {
  const startMs = episode.startedAtMs;
  const endMs = episode.endedAtMs ?? episode.startedAtMs;
  if (timestampMs < startMs) return startMs - timestampMs;
  if (timestampMs > endMs) return timestampMs - endMs;
  return 0;
}

/**
 * The episode whose span is closest to `timestampMs`, within tolerance -- for joining a
 * timeline `CompactionItem` to its ledger row by agent + time (docs/insights.md). Null when
 * nothing in range, which degrades the marker back to its plain, unjoined rendering.
 */
export function findMatchingCompactionEpisode(
  episodes: readonly CompactionEpisode[],
  timestampMs: number,
  toleranceMs: number = COMPACTION_MARKER_MATCH_TOLERANCE_MS,
): CompactionEpisode | null {
  let best: CompactionEpisode | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const episode of episodes) {
    const distance = distanceToEpisodeMs(episode, timestampMs);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = episode;
      bestDistance = distance;
    }
  }
  return best;
}

/** The timeline marker's one-line summary once joined to its episode. */
export function formatEpisodeMarkerLine(episode: CompactionEpisode): string {
  return `${formatEpisodeContext(episode)}, ${formatEpisodeTrigger(episode)}, cost ${formatEpisodeCost(
    episode,
  )}`;
}

export interface CompactionInsightsTile {
  id: "count" | "total-cost" | "average-cost" | "estimated-saved";
  label: string;
  value: string;
  caption: string;
}

/** The totals row at the top of the Compactions section. */
export function buildCompactionInsightsTiles(
  summary: CompactionEpisodesSummary,
): CompactionInsightsTile[] {
  const nothingMeasured = summary.measuredCount === 0;
  return [
    {
      id: "count",
      label: "Compactions",
      value: summary.count.toLocaleString("en-US"),
      caption:
        summary.measuredCount === summary.count
          ? "all measured"
          : `${summary.measuredCount} of ${summary.count} measured`,
    },
    {
      id: "total-cost",
      label: "Total cost",
      // The server sums only measured episodes; with none, 0 would read as "free".
      value: nothingMeasured ? "—" : formatCompactionTokens(summary.totalCostWeightedTokens),
      caption: "weighted tokens",
    },
    {
      id: "average-cost",
      label: "Average cost",
      value: nothingMeasured ? "—" : formatCompactionTokens(summary.averageCostWeightedTokens),
      caption: "per measured compaction",
    },
    {
      id: "estimated-saved",
      label: "Estimated saved",
      value: formatCompactionTokens(summary.totalEstimatedSavedWeightedTokens),
      caption: "estimate, not measured",
    },
  ];
}
