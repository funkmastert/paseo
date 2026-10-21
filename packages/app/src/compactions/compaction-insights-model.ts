import type { CompactionEpisode, CompactionEpisodesSummary } from "./use-compaction-episodes";

/**
 * Pure formatting for the Insights screen's Compactions section and the timeline's compaction
 * marker (docs/insights.md). Shared so the two surfaces never disagree about what a figure means.
 */

/** Compacted token count, matching the JEV dashboard's tile convention: 1,284 / 12.4k / 3.1M. */
export function formatCompactionTokens(tokens: number): string {
  const abs = Math.abs(tokens);
  if (abs >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return Math.round(tokens).toLocaleString("en-US");
}

/** The episode's own cost: a figure when measured, an explicit "not measured" when not. */
export function formatEpisodeCost(episode: CompactionEpisode): string {
  if (episode.costBasis !== "measured" || episode.costWeightedTokens === null) {
    return "not measured";
  }
  return formatCompactionTokens(episode.costWeightedTokens);
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
      value: formatCompactionTokens(summary.totalCostWeightedTokens),
      caption: "weighted tokens",
    },
    {
      id: "average-cost",
      label: "Average cost",
      value: formatCompactionTokens(summary.averageCostWeightedTokens),
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
