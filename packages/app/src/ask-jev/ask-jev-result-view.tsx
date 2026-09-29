import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { MeterBar } from "@/provider-usage/window-bar";
import { settingsStyles } from "@/styles/settings";
import {
  formatPercent,
  type AskJevBar,
  type AskJevMeta,
  type AskJevPosition,
  type AskJevResultView,
} from "./ask-jev-result";

/** Said once, under every answer: JEV picks among what you defined; it writes nothing. */
export const ASK_JEV_CLASSIFIES_NOTE =
  "JEV classifies: it picks among the answers you defined and never writes text.";

function metaLine(meta: AskJevMeta): string {
  return [meta.costLabel, meta.latencyLabel, meta.modelLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function BarRow({ bar }: { bar: AskJevBar }): ReactElement {
  return (
    <View style={styles.barRow} testID={`ask-jev-bar-${bar.key}`}>
      <View style={styles.barLabelRow}>
        <Text style={bar.chosen ? styles.barLabelChosen : styles.barLabel} numberOfLines={1}>
          {bar.label}
        </Text>
        <Text style={bar.chosen ? styles.barValueChosen : styles.barValue}>
          {formatPercent(bar.fraction)}
        </Text>
      </View>
      <MeterBar pct={bar.fraction * 100} tone={bar.chosen ? "emphasis" : "default"} />
    </View>
  );
}

function PositionRow({ position }: { position: AskJevPosition }): ReactElement {
  return (
    <View style={styles.barRow} testID="ask-jev-position">
      <MeterBar pct={position.fraction * 100} tone="emphasis" />
      <View style={styles.barLabelRow}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {position.lowLabel}
        </Text>
        <Text style={styles.barLabel} numberOfLines={1}>
          {position.highLabel}
        </Text>
      </View>
    </View>
  );
}

function MetaRow({ meta }: { meta: AskJevMeta }): ReactElement {
  return (
    <View style={styles.metaRow} testID="ask-jev-meta">
      <Text style={styles.metaText}>{metaLine(meta)}</Text>
      {meta.redactionLabel ? <Text style={styles.metaText}>{meta.redactionLabel}</Text> : null}
    </View>
  );
}

export function AskJevResultCard({ result }: { result: AskJevResultView }): ReactElement {
  if (result.kind === "notice") {
    return (
      <View style={styles.notice} testID="ask-jev-notice">
        <Alert variant={result.tone} title={result.title} description={result.description} />
        {result.meta ? <MetaRow meta={result.meta} /> : null}
      </View>
    );
  }

  return (
    <SettingsCard testID="ask-jev-answer">
      <View style={styles.headlineRow}>
        <Text style={settingsStyles.rowTitle} testID="ask-jev-headline">
          {result.headline}
        </Text>
        <Text style={styles.detail}>{result.detail}</Text>
      </View>
      <View style={styles.barsRow}>
        {result.position ? <PositionRow position={result.position} /> : null}
        {result.bars.map((bar) => (
          <BarRow key={bar.key} bar={bar} />
        ))}
      </View>
      <View style={styles.footerRow}>
        <MetaRow meta={result.meta} />
        <Text style={styles.metaText}>{ASK_JEV_CLASSIFIES_NOTE}</Text>
      </View>
    </SettingsCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    gap: theme.spacing[2],
  },
  headlineRow: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  barsRow: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  barRow: {
    gap: theme.spacing[1],
  },
  barLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  barLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  barLabelChosen: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  barValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  barValueChosen: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  footerRow: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  metaRow: {
    gap: theme.spacing[1],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
