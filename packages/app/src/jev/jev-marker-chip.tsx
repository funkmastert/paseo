import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingScrollView } from "@/components/ui/floating";
import { StatusBadge } from "@/components/ui/status-badge";
import type { JevDecisionLine, JevDecisionTag } from "./jev-decisions-model";

const ThemedGauge = withUnistyles(Gauge);
const LEADING_ICON_SIZE = 10;

const TAG_KEYS: Record<JevDecisionTag, string> = {
  shadow: "contextWindow.jevShadow",
  dryRun: "contextWindow.jevDryRun",
};

const MARKER_POPOVER_MAX_HEIGHT = 320;

/**
 * One or more JEV decisions collapsed onto a single stream position. Quiet by design (docs/design.md):
 * a small pill, same tap-triggered `Tooltip` pattern as `TokenBurnBadge`/`ContextWindowMeter`, so it is
 * cross-platform and hover-free without any `isWeb` branch.
 */
export function JevMarkerChip({ lines }: { lines: JevDecisionLine[] }) {
  const { t } = useTranslation();
  const label =
    lines.length > 1
      ? t("jevMarker.chipLabelCount", { count: lines.length })
      : t("jevMarker.chipLabel");
  const accessibilityLabel =
    lines.length > 1
      ? t("jevMarker.accessibilityLabelCount", { count: lines.length })
      : t("jevMarker.accessibilityLabel");
  const leadingIcon = useMemo(() => <ThemedGauge size={LEADING_ICON_SIZE} />, []);

  return (
    <View style={styles.row} testID="jev-marker">
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
        <TooltipTrigger asChild>
          <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} hitSlop={4}>
            <StatusBadge label={label} leading={leadingIcon} />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" offset={8}>
          <FloatingScrollView style={styles.popoverScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.popoverContent}>
              {lines.map((line) => (
                <JevMarkerDetailRow key={line.key} line={line} />
              ))}
            </View>
          </FloatingScrollView>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

/** The tag badge and cost, shared by both the pre-`summary` and `summary`-first layouts below. */
function JevMarkerMeta({ tag, cost }: { tag: JevDecisionTag | null; cost: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      {tag ? <StatusBadge label={t(TAG_KEYS[tag])} /> : null}
      {cost ? <Text style={styles.cost}>{cost}</Text> : null}
    </>
  );
}

function JevMarkerDetailRow({ line }: { line: JevDecisionLine }) {
  const { t } = useTranslation();
  // An older daemon sends no summary; render exactly as before this field existed.
  if (!line.summary) {
    return (
      <View style={styles.detailRow}>
        <View style={styles.detailHeader}>
          <Text style={styles.feature} numberOfLines={1}>
            {line.feature}
          </Text>
          <JevMarkerMeta tag={line.tag} cost={line.cost} />
        </View>
        <Text style={styles.question}>{line.question}</Text>
        <Text style={styles.muted}>
          {line.verdict} →{" "}
          {line.tag ? t("jevMarker.wouldHaveAction", { action: line.action }) : line.action}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailHeader}>
        <Text style={styles.summary} numberOfLines={2}>
          {line.summary}
        </Text>
        <JevMarkerMeta tag={line.tag} cost={line.cost} />
      </View>
      {line.subjectLabel ? (
        <Text style={styles.muted}>{t("jevMarker.forAgent", { title: line.subjectLabel })}</Text>
      ) : null}
      <Text style={styles.muted}>
        {line.feature} · {line.verdict}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[1],
  },
  popoverScroll: {
    maxHeight: MARKER_POPOVER_MAX_HEIGHT,
  },
  popoverContent: {
    gap: theme.spacing[3],
    minWidth: 220,
  },
  detailRow: {
    gap: theme.spacing[1],
  },
  detailHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[2],
    rowGap: theme.spacing[1],
  },
  feature: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  summary: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  cost: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  question: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
