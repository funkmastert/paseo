import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatTimeAgo } from "@/utils/time";
import type { JevDecisionLine, JevDecisionTag, JevDecisionsView } from "./jev-decisions-model";

const TAG_KEYS: Record<JevDecisionTag, string> = {
  shadow: "contextWindow.jevShadow",
  dryRun: "contextWindow.jevDryRun",
};

/**
 * An agent's JEV decisions for the context meter's popover, without a data source, so a capture
 * can hand it a view directly. Renders nothing when there are none: most agents never have one.
 * `onOpenAllActivity` is a plain callback, not a navigation import, so this stays capture-safe —
 * the caller (`jev-decisions-section.tsx`) wires it to `router.push`.
 */
export function JevDecisionsList({
  view,
  now,
  onOpenAllActivity,
}: {
  view: JevDecisionsView;
  now?: Date;
  onOpenAllActivity?: () => void;
}) {
  const { t } = useTranslation();
  if (view.lines.length === 0) return null;
  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.title}>{t("contextWindow.jevTitle")}</Text>
      <View style={styles.list} testID="jev-decisions">
        {view.lines.map((line) => (
          <JevDecisionRow key={line.key} line={line} now={now} />
        ))}
      </View>
      {view.hidden > 0 ? (
        <Text style={styles.muted}>{t("contextWindow.jevOlder", { count: view.hidden })}</Text>
      ) : null}
      {onOpenAllActivity ? (
        <Pressable onPress={onOpenAllActivity} testID="jev-all-activity-link">
          <Text style={styles.link}>{t("contextWindow.jevAllActivity")}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function JevDecisionRow({ line, now }: { line: JevDecisionLine; now?: Date }) {
  const { t } = useTranslation();
  const meta = [line.at ? formatTimeAgo(line.at, now) : null, line.cost]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.row} testID="jev-decision">
      <View style={styles.header}>
        <Text style={styles.feature} numberOfLines={1}>
          {line.feature}
        </Text>
        {line.tag ? <StatusBadge label={t(TAG_KEYS[line.tag])} /> : null}
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Text style={styles.question}>{line.question}</Text>
      <Text style={styles.muted}>{`${line.verdict} → ${line.action}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  list: {
    gap: theme.spacing[3],
  },
  row: {
    gap: theme.spacing[1],
  },
  // Wraps rather than truncating: on a phone the time and cost drop under the feature's name.
  header: {
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
  // Time and cost, pushed to the trailing edge; the feature name yields to it.
  meta: {
    marginLeft: "auto",
    flexShrink: 0,
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
  link: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
}));
