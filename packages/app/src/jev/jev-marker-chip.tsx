import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingScrollView } from "@/components/ui/floating";
import { StatusBadge } from "@/components/ui/status-badge";
import type { JevDecisionLine } from "./jev-decisions-model";

const ThemedGauge = withUnistyles(Gauge);
const LEADING_ICON_SIZE = 10;

const MARKER_POPOVER_MAX_HEIGHT = 320;

/** `progressing (0.99)` reads `progressing`: a raw score never reaches the always-visible row. */
function withoutRawScore(text: string): string {
  return text.replace(/\s*\([\d.]+\)\s*$/, "");
}

/**
 * The first typed answer, scores and underscores dropped: `blocked_on_person 0.08, reply_kind
 * confirm 0.86` reads `blocked on person`. Only an older daemon, which sends no `summary`, needs it.
 */
function plainVerdict(verdict: string): string {
  const [first = ""] = verdict.split(",");
  return first
    .replace(/\(\s*[\d.]+\s*\)/g, "")
    .replace(/(^|\s)[\d.]+(?=\s|$)/g, " ")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `JEV: progressing` reads `progressing`: the leading "JEV"/"JEV:" is redundant with the pill. A
 * record from an older daemon has no `summary`, so the row names the feature and the plain verdict
 * instead of the raw verdict and action, which carry scores and snake_case.
 */
function rowSummary(line: JevDecisionLine): string {
  if (!line.summary) {
    const verdict = plainVerdict(line.verdict);
    return verdict ? `${line.feature}: ${verdict}` : line.feature;
  }
  return withoutRawScore(line.summary).replace(/^JEV:?\s*/, "");
}

/**
 * One or more JEV decisions collapsed onto a single stream position: a one-line pill (quiet by
 * design, docs/design.md) plus the newest decision's plain-words summary and a "+N" for the rest.
 * Hover on desktop, tap on phone (the same tap-triggered `Tooltip` pattern as
 * `TokenBurnBadge`/`ContextWindowMeter`, cross-platform and hover-free on native) opens the
 * popover with every decision's full explanation: purpose, summary, detail, subject, watching-only,
 * and the raw verdict and cost.
 */
export function JevMarkerChip({ lines }: { lines: JevDecisionLine[] }) {
  const { t } = useTranslation();
  const newest = lines[lines.length - 1];
  const moreCount = lines.length - 1;
  const reversedLines = useMemo(() => lines.toReversed(), [lines]);
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
            <StatusBadge label={t("jevMarker.chipLabel")} leading={leadingIcon} />
            <Text style={styles.summary} numberOfLines={1}>
              {rowSummary(newest)}
            </Text>
            {moreCount > 0 ? (
              <Text style={styles.overflow}>{t("jevMarker.plusCount", { count: moreCount })}</Text>
            ) : null}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" offset={8}>
          <FloatingScrollView style={styles.popoverScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.popoverContent}>
              {reversedLines.map((line) => (
                <JevMarkerDetailRow key={line.key} line={line} />
              ))}
            </View>
          </FloatingScrollView>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

/** Every decision's full explanation, opened by hover (desktop) or a tap (phone) on the row. */
function JevMarkerDetailRow({ line }: { line: JevDecisionLine }) {
  const { t } = useTranslation();
  const purpose = t(`jevMarker.purpose.${line.featureId}`, { defaultValue: line.feature });
  // An older daemon sends no summary: fall back to the action alone, since the footer below
  // already shows the raw verdict — embedding it here too would print it twice.
  const primary = line.summary ?? line.action;
  return (
    <View style={styles.detailRow}>
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
      <View style={styles.detailFooter}>
        <Text style={styles.muted} numberOfLines={1}>
          {line.verdict}
        </Text>
        {line.cost ? <Text style={styles.cost}>{line.cost}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[1],
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summary: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  overflow: {
    flexShrink: 0,
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
    gap: theme.spacing[0.5],
  },
  purpose: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  primary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  detailFooter: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: theme.spacing[2],
  },
  cost: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
