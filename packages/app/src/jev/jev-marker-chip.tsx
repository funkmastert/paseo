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
const LEADING_ICON_SIZE = 14;

const TAG_KEYS: Record<JevDecisionTag, string> = {
  shadow: "contextWindow.jevShadow",
  dryRun: "contextWindow.jevDryRun",
};

const MARKER_POPOVER_MAX_HEIGHT = 320;

/** Decisions shown directly in the row, newest first; the rest collapse into "+N more". */
const INLINE_VISIBLE_MAX = 3;

/**
 * One or more JEV decisions collapsed onto a single stream position. Quiet by design
 * (docs/design.md), but no longer a bare pill: the newest decisions read in the row itself
 * (docs/jev.md, "Feature 11" — O8), each with what JEV was checking, what it decided and what
 * happened, who it was about, and whether it only watched. A tap still opens every decision in
 * the group with its raw question, verdict and cost, reusing the same tap-triggered `Tooltip`
 * pattern as `TokenBurnBadge`/`ContextWindowMeter`, so it stays cross-platform and hover-free
 * without any `isWeb` branch.
 */
export function JevMarkerChip({ lines }: { lines: JevDecisionLine[] }) {
  const { t } = useTranslation();
  const newest = useMemo(() => [...lines].slice(-INLINE_VISIBLE_MAX).reverse(), [lines]);
  const hiddenCount = lines.length - newest.length;
  const accessibilityLabel =
    lines.length > 1
      ? t("jevMarker.accessibilityLabelCount", { count: lines.length })
      : t("jevMarker.accessibilityLabel");
  const leadingIcon = useMemo(() => <ThemedGauge size={LEADING_ICON_SIZE} />, []);

  return (
    <View style={styles.row} testID="jev-marker">
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
        <TooltipTrigger asChild>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            hitSlop={4}
            style={styles.trigger}
          >
            <View style={styles.iconWrap}>{leadingIcon}</View>
            <View style={styles.inlineList}>
              {newest.map((line) => (
                <JevMarkerInlineLine key={line.key} line={line} />
              ))}
              {hiddenCount > 0 ? (
                <Text style={styles.overflow}>
                  {t("jevMarker.overflowMore", { count: hiddenCount })}
                </Text>
              ) : null}
            </View>
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

/** `progressing (0.99)` reads `progressing`: a raw score never reaches the always-visible row. */
function withoutRawScore(text: string): string {
  return text.replace(/\s*\([\d.]+\)\s*$/, "");
}

/** The row's content without a tap: purpose, decision and result, subject, and watching-only. */
function JevMarkerInlineLine({ line }: { line: JevDecisionLine }) {
  const { t } = useTranslation();
  const purpose = t(`jevMarker.purpose.${line.featureId}`, { defaultValue: line.feature });
  // An older daemon sends no summary: fall back to the verdict and action, scores stripped.
  const primary = line.summary ?? `${withoutRawScore(line.verdict)} → ${line.action}`;
  return (
    <View style={styles.inlineLine}>
      <Text style={styles.purpose} numberOfLines={1}>
        {purpose}
      </Text>
      <Text style={styles.primary} numberOfLines={2}>
        {primary}
      </Text>
      {line.detail ? <Text style={styles.muted}>{line.detail}</Text> : null}
      {line.subjectLabel ? (
        <Text style={styles.muted}>{t("jevMarker.forAgent", { title: line.subjectLabel })}</Text>
      ) : null}
      {line.tag ? <Text style={styles.muted}>{t("jevMarker.watchingOnly")}</Text> : null}
    </View>
  );
}

/** The tag badge and cost, shown only in the tap-opened full detail. */
function JevMarkerMeta({ tag, cost }: { tag: JevDecisionTag | null; cost: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      {tag ? <StatusBadge label={t(TAG_KEYS[tag])} /> : null}
      {cost ? <Text style={styles.cost}>{cost}</Text> : null}
    </>
  );
}

/** Every decision's full detail: question, raw verdict and cost, opened by a tap on the row. */
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
  trigger: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  iconWrap: {
    paddingTop: theme.spacing[0.5],
  },
  inlineList: {
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  inlineLine: {
    gap: theme.spacing[0.5],
  },
  purpose: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  primary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  overflow: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
