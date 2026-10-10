import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { formatTimeAgo } from "@/utils/time";
import {
  buildContextBreakdownView,
  buildReReadAdvice,
  type AgentContextUsagePayload,
  type ContextBarSegment,
  type ContextBreakdownRow,
  type ContextMessageRowId,
  type ContextMeterThresholds,
  type ContextMeterTone,
} from "./context-meter-model";

const MESSAGE_ROW_LABEL_KEYS: Record<ContextMessageRowId, string> = {
  toolResults: "contextWindow.messageToolResults",
  attachments: "contextWindow.messageAttachments",
  assistant: "contextWindow.messageAssistant",
  toolCalls: "contextWindow.messageToolCalls",
  user: "contextWindow.messageUser",
};

// A used row keeps its slot for as long as it is in the list, so its dot matches its bar segment.
const SLOT_STYLE_NAMES = ["slot0", "slot1", "slot2", "slot3", "slot4"] as const;
// Keeps a sliver of a segment visible without pretending it is bigger than it is.
const MIN_SEGMENT_FRACTION = 0.004;

type BreakdownStatus =
  | { kind: "loading" }
  | { kind: "message"; message: string; tone: "muted" | "error" }
  // `refreshFailed`: the daemon could not capture again and sent its last good breakdown.
  | {
      kind: "breakdown";
      usage: NonNullable<AgentContextUsagePayload["usage"]>;
      refreshFailed: boolean;
    };

function resolveBreakdownStatus(
  payload: AgentContextUsagePayload | undefined,
  isLoading: boolean,
  t: (key: string) => string,
): BreakdownStatus {
  if (!payload) {
    return isLoading
      ? { kind: "loading" }
      : { kind: "message", message: t("contextWindow.breakdownError"), tone: "error" };
  }
  if (payload.usage) {
    const refreshFailed = payload.status !== "captured" && payload.status !== "cached";
    return { kind: "breakdown", usage: payload.usage, refreshFailed };
  }
  if (payload.status === "captured" || payload.status === "cached") {
    return { kind: "message", message: t("contextWindow.breakdownError"), tone: "error" };
  }
  if (payload.status === "pending") {
    return { kind: "message", message: t("contextWindow.breakdownPending"), tone: "muted" };
  }
  if (payload.status === "unsupported") {
    return { kind: "message", message: t("contextWindow.breakdownUnsupported"), tone: "muted" };
  }
  // "error" and any status a newer daemon adds.
  return { kind: "message", message: t("contextWindow.breakdownError"), tone: "error" };
}

function slotStyleFor(rows: ContextBreakdownRow[], id: string) {
  const usedIds = rows.filter((row) => row.kind === "used").map((row) => row.id);
  const index = Math.max(0, usedIds.indexOf(id));
  return styles[SLOT_STYLE_NAMES[index % SLOT_STYLE_NAMES.length]];
}

function dotStyleFor(row: ContextBreakdownRow, rows: ContextBreakdownRow[]) {
  if (row.kind === "buffer") return styles.bufferFill;
  if (row.kind === "free") return styles.freeDot;
  return slotStyleFor(rows, row.id);
}

function BreakdownBar({
  segments,
  rows,
  accessibilityLabel,
}: {
  segments: ContextBarSegment[];
  rows: ContextBreakdownRow[];
  accessibilityLabel: string;
}) {
  return (
    <View
      style={styles.bar}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID="context-usage-bar"
    >
      {segments.map((segment) => (
        <View
          key={segment.id}
          style={[
            segment.kind === "buffer" ? styles.bufferFill : slotStyleFor(rows, segment.id),
            { flexGrow: Math.max(segment.fraction, MIN_SEGMENT_FRACTION), flexBasis: 0 },
          ]}
        />
      ))}
      <BarRemainder grow={Math.max(1 - sumFractions(segments), 0)} />
    </View>
  );
}

// The free space: whatever the segments leave, so the bar always spans the whole window.
function BarRemainder({ grow }: { grow: number }) {
  const style = useMemo(() => ({ flexGrow: grow, flexBasis: 0 }), [grow]);
  return <View style={style} />;
}

function sumFractions(segments: ContextBarSegment[]): number {
  return segments.reduce((total, segment) => total + segment.fraction, 0);
}

function BreakdownRow({
  row,
  rows,
  muted = false,
}: {
  row: ContextBreakdownRow;
  rows: ContextBreakdownRow[];
  muted?: boolean;
}) {
  return (
    <View style={styles.row} testID={`context-usage-row-${row.id}`}>
      {muted ? (
        <View style={styles.dotSpacer} />
      ) : (
        <View style={[styles.dot, dotStyleFor(row, rows)]} />
      )}
      <Text style={muted ? styles.rowLabelMuted : styles.rowLabel} numberOfLines={1}>
        {row.label}
      </Text>
      <Text style={styles.rowValue}>{row.formattedTokens}</Text>
      <Text style={styles.rowPercent}>{row.formattedPercent ?? ""}</Text>
    </View>
  );
}

function BreakdownBody({
  usage,
  thresholds,
}: {
  usage: NonNullable<AgentContextUsagePayload["usage"]>;
  thresholds: ContextMeterThresholds;
}) {
  const { t } = useTranslation();
  const view = buildContextBreakdownView(usage, thresholds);
  const asOf = Number.isFinite(view.capturedAt)
    ? t("contextWindow.breakdownAsOf", { time: formatTimeAgo(new Date(view.capturedAt)) })
    : null;
  const hasMemoryWarning = view.memory.total !== null || view.memory.files.length > 0;

  return (
    <>
      <BreakdownBar
        segments={view.segments}
        rows={view.rows}
        accessibilityLabel={t("contextWindow.breakdownBarAccessibility")}
      />
      <View style={styles.rows}>
        {view.rows.map((row) => (
          <View key={row.id}>
            <BreakdownRow row={row} rows={view.rows} />
            {row.id === "messages"
              ? view.messageRows.map((messageRow) => (
                  <View
                    key={messageRow.id}
                    style={styles.subRow}
                    testID={`context-usage-message-${messageRow.id}`}
                  >
                    <Text style={styles.rowLabelMuted} numberOfLines={1}>
                      {t(MESSAGE_ROW_LABEL_KEYS[messageRow.id])}
                    </Text>
                    <Text style={styles.rowValueMuted}>{messageRow.formattedTokens}</Text>
                  </View>
                ))
              : null}
          </View>
        ))}
      </View>
      {view.deferredRows.length > 0 ? (
        <View style={styles.deferred}>
          <Text style={styles.detail}>{t("contextWindow.deferredTitle")}</Text>
          {view.deferredRows.map((row) => (
            <BreakdownRow key={row.id} row={row} rows={view.rows} muted />
          ))}
        </View>
      ) : null}
      {hasMemoryWarning ? (
        <View style={styles.warnings} testID="context-usage-memory-warnings">
          {view.memory.total ? (
            <Text style={styles.warning}>
              {t("contextWindow.memoryTotalWarning", {
                tokens: view.memory.total.formattedTokens,
                limit: view.memory.total.limitFormatted,
              })}
            </Text>
          ) : null}
          {view.memory.files.map((file) => (
            <Text key={file.path} style={styles.warning} numberOfLines={2}>
              {t("contextWindow.memoryFileWarning", {
                path: file.shortPath,
                tokens: file.formattedTokens,
                limit: file.limitFormatted,
              })}
            </Text>
          ))}
        </View>
      ) : null}
      {asOf ? <Text style={styles.detail}>{asOf}</Text> : null}
    </>
  );
}

/**
 * What the popover shows below the totals: the provider's own breakdown of the window, the
 * status of that read, and, once the session is big, the advice to start a fresh one. Pure in
 * its props so the browser capture can render every state; `ContextUsageBreakdownSection` wires
 * it to the daemon.
 */
export function ContextUsageBreakdown({
  payload,
  isSupported,
  isLoading,
  usedTokens,
  tone,
  thresholds,
}: {
  payload: AgentContextUsagePayload | undefined;
  isSupported: boolean;
  isLoading: boolean;
  usedTokens: number;
  tone: ContextMeterTone;
  thresholds: ContextMeterThresholds;
}) {
  const { t } = useTranslation();
  const advice = buildReReadAdvice(usedTokens, tone);
  const status = isSupported ? resolveBreakdownStatus(payload, isLoading, t) : null;
  if (!status && !advice) return null;

  return (
    <>
      <View style={styles.divider} />
      {status?.kind === "loading" ? (
        <Text style={styles.detail}>{t("contextWindow.breakdownLoading")}</Text>
      ) : null}
      {status?.kind === "message" ? (
        <Text style={status.tone === "error" ? styles.error : styles.detail}>{status.message}</Text>
      ) : null}
      {status?.kind === "breakdown" ? (
        <BreakdownBody usage={status.usage} thresholds={thresholds} />
      ) : null}
      {status?.kind === "breakdown" && status.refreshFailed ? (
        <Text style={styles.error}>{t("contextWindow.breakdownError")}</Text>
      ) : null}
      {advice ? (
        <Text
          style={tone === "red" ? styles.adviceRed : styles.adviceAmber}
          testID="context-usage-advice"
        >
          {t("contextWindow.reReadAdvice", { tokens: advice })}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  divider: {
    height: 1,
    backgroundColor: theme.colors.borderAccent,
    marginVertical: theme.spacing[2],
    marginHorizontal: -theme.spacing[2],
  },
  bar: {
    flexDirection: "row",
    height: 8,
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
    gap: 1,
    marginBottom: theme.spacing[2],
  },
  slot0: { backgroundColor: theme.colors.palette.blue[500] },
  slot1: { backgroundColor: theme.colors.palette.purple[500] },
  slot2: { backgroundColor: theme.colors.palette.green[500] },
  slot3: { backgroundColor: theme.colors.palette.blue[300] },
  slot4: { backgroundColor: theme.colors.palette.teal[200] },
  bufferFill: { backgroundColor: theme.colors.borderAccent },
  freeDot: {
    backgroundColor: theme.colors.surface3,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  rows: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotSpacer: {
    width: 8,
  },
  rowLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowLabelMuted: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
    minWidth: 44,
  },
  rowValueMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
    minWidth: 44,
  },
  rowPercent: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
    minWidth: 44,
  },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // Lines the sub-row label up with the row label above it: dot width plus one gap.
    paddingLeft: theme.spacing[4],
    // The percent column has no sub-row figure; reserve it so the token figures line up.
    paddingRight: 44 + theme.spacing[2],
  },
  deferred: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[1],
  },
  warnings: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[1],
  },
  warning: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginTop: theme.spacing[1],
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  adviceAmber: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginTop: theme.spacing[2],
  },
  adviceRed: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginTop: theme.spacing[2],
  },
}));
