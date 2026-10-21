import { i18n } from "@/i18n/i18next";
import { formatEpisodeMarkerLine } from "@/compactions/compaction-insights-model";
import type { CompactionEpisode } from "@/compactions/use-compaction-episodes";

export interface CompactionMarkerLabelInput {
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
  /** The ledger episode this marker joined to (docs/insights.md), when one was found. */
  episode?: CompactionEpisode | null;
}

export function getCompactionMarkerLabel({
  status,
  trigger,
  preTokens,
  episode,
}: CompactionMarkerLabelInput): string {
  if (status === "loading") return i18n.t("message.compaction.loading");
  if (episode) return formatEpisodeMarkerLine(episode);
  if (trigger === "auto") return i18n.t("message.compaction.auto");
  if (trigger === "manual") return i18n.t("message.compaction.manual");
  if (preTokens) {
    return i18n.t("message.compaction.withTokens", {
      tokens: Math.round(preTokens / 1000),
    });
  }
  return i18n.t("message.compaction.completed");
}
