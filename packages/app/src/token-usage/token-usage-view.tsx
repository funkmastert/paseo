import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  buildTokenUsageCostSummary,
  buildTokenUsageModelBars,
  buildTokenUsageRoleTotals,
  formatCompactTokens,
  hasIncompleteAttribution,
  resolveTokenUsageDisplayState,
  type TokenUsageBreakdown,
  type TokenUsageCostSummary,
  type TokenUsageRange,
  type TokenUsageUnit,
} from "./token-usage-model";
import { TokensByModelCard } from "./tokens-by-model-card";
import { TokensByRoleCard } from "./tokens-by-role-card";

/**
 * The screen's presentational pieces: no `expo-router`, no navigation hooks. A capture (or this
 * screen's browser test) can mount these directly with fixture data — `expo-router`'s `router`
 * singleton pulls in the whole navigation stack, which breaks the browser capture's esbuild loader
 * on its JSX (the same trap `jev-dashboard-view.tsx` avoids).
 */

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const UNIT_OPTIONS: SegmentedControlOption<TokenUsageUnit>[] = [
  { value: "weighted", label: "Weighted", testID: "token-usage-unit-weighted" },
  { value: "raw", label: "Raw", testID: "token-usage-unit-raw" },
];

const RANGE_OPTIONS: SegmentedControlOption<TokenUsageRange>[] = [
  { value: "24h", label: "24h", testID: "token-usage-range-24h" },
  { value: "7d", label: "7 days", testID: "token-usage-range-7d" },
  { value: "30d", label: "30 days", testID: "token-usage-range-30d" },
];

export type TokenUsageAvailability =
  | { kind: "no-host" }
  | { kind: "connecting" }
  | { kind: "update-host" }
  | { kind: "ready" };

/** A deep link to this route on a host without the feature says to update the host (R6/U5). */
export function resolveTokenUsageAvailability(input: {
  hasHost: boolean;
  connected: boolean;
  supported: boolean;
}): TokenUsageAvailability {
  if (!input.hasHost) return { kind: "no-host" };
  if (!input.connected) return { kind: "connecting" };
  if (!input.supported) return { kind: "update-host" };
  return { kind: "ready" };
}

export function TokenUsageAvailabilityBanner({
  availability,
}: {
  availability: TokenUsageAvailability;
}) {
  switch (availability.kind) {
    case "no-host":
      return (
        <Alert
          title="No host"
          description="Add a host to see token usage."
          testID="token-usage-no-host"
        />
      );
    case "connecting":
      return <Alert title="Waiting for the host to connect" testID="token-usage-connecting" />;
    case "update-host":
      return (
        <Alert
          variant="info"
          title="Update the host for token usage"
          description="This host's daemon is older than the Tokens screen. Update it, then come back."
          testID="token-usage-update-host"
        />
      );
    case "ready":
      return null;
  }
}

export interface TokenUsageContentProps {
  breakdown: TokenUsageBreakdown | undefined;
  isLoading: boolean;
  queryError: Error | null;
  onRetry: () => void;
  unit: TokenUsageUnit;
  onUnitChange: (unit: TokenUsageUnit) => void;
  range: TokenUsageRange;
  onRangeChange: (range: TokenUsageRange) => void;
  /** Whether the host daemon advertises `tokenUsageCost` — hides all cost UI when it doesn't. */
  costSupported: boolean;
}

function RetryButton({ onRetry, testID }: { onRetry: () => void; testID: string }) {
  return (
    <Button variant="outline" size="sm" onPress={onRetry} testID={testID}>
      Retry
    </Button>
  );
}

/** The range-total cost line (R4) shown above the model/role cards, only when the host supports
 * the `tokenUsageCost` feature (KTD-6). */
function CostSummary({ summary }: { summary: TokenUsageCostSummary }) {
  const { t } = useTranslation();
  return (
    <View testID="token-usage-cost-summary">
      <View style={styles.costSummaryRow}>
        <Text style={styles.costSummaryLabel}>{t("tokenUsage.costLabel")}</Text>
        <Text style={styles.costSummaryValue} testID="token-usage-cost-summary-value">
          {summary.formattedTotal ?? "—"}
        </Text>
      </View>
      <Text style={styles.costSummaryCaption}>{t("tokenUsage.costCaption")}</Text>
      {summary.hasUnpriced ? (
        <Text style={styles.footerNote} testID="token-usage-cost-unpriced-footer">
          {t("tokenUsage.unpricedFooter", { count: formatCompactTokens(summary.unpricedTokens) })}
        </Text>
      ) : null}
    </View>
  );
}

/** The populated-data body: model/role cards plus the cost summary (R4), when supported. */
function TokenUsageDataSection({
  bars,
  roleTotals,
  costSupported,
  costSummary,
}: {
  bars: ReturnType<typeof buildTokenUsageModelBars>;
  roleTotals: ReturnType<typeof buildTokenUsageRoleTotals>;
  costSupported: boolean;
  costSummary: TokenUsageCostSummary | null;
}) {
  return (
    <>
      {costSupported && costSummary ? <CostSummary summary={costSummary} /> : null}
      <TokensByModelCard bars={bars} costSupported={costSupported} />
      <TokensByRoleCard totals={roleTotals} costSupported={costSupported} />
    </>
  );
}

export function TokenUsageContent({
  breakdown,
  isLoading,
  queryError,
  onRetry,
  unit,
  onUnitChange,
  range,
  onRangeChange,
  costSupported,
}: TokenUsageContentProps): ReactElement {
  const displayState = breakdown ? resolveTokenUsageDisplayState(breakdown) : null;
  const bars = useMemo(
    () => (breakdown ? buildTokenUsageModelBars(breakdown.rows, unit) : []),
    [breakdown, unit],
  );
  const roleTotals = useMemo(
    () => (breakdown ? buildTokenUsageRoleTotals(breakdown.rows, unit) : []),
    [breakdown, unit],
  );
  const incompleteAttribution = breakdown ? hasIncompleteAttribution(breakdown.rows, unit) : false;
  const costSummary = useMemo(
    () => (breakdown ? buildTokenUsageCostSummary(breakdown) : null),
    [breakdown],
  );

  return (
    <View style={styles.readyColumn}>
      <View style={styles.controlsRow}>
        <SegmentedControl
          size="sm"
          value={unit}
          onValueChange={onUnitChange}
          options={UNIT_OPTIONS}
          testID="token-usage-unit"
        />
        <View style={styles.controlsDivider} testID="token-usage-controls-divider" />
        <SegmentedControl
          size="sm"
          value={range}
          onValueChange={onRangeChange}
          options={RANGE_OPTIONS}
          testID="token-usage-range"
        />
      </View>
      {!breakdown && isLoading ? (
        <View style={styles.loadingRow} testID="token-usage-loading">
          <ThemedLoadingSpinner size={14} />
          <Text style={styles.loadingLabel}>Loading...</Text>
        </View>
      ) : null}
      {!breakdown && !isLoading && queryError ? (
        <Alert
          variant="error"
          title="Couldn't load token usage"
          description={queryError.message}
          testID="token-usage-query-error"
        >
          <RetryButton onRetry={onRetry} testID="token-usage-query-error-retry" />
        </Alert>
      ) : null}
      {displayState?.kind === "error" ? (
        <Alert
          variant="error"
          title="Couldn't load token usage"
          description={displayState.message}
          testID="token-usage-error"
        >
          <RetryButton onRetry={onRetry} testID="token-usage-error-retry" />
        </Alert>
      ) : null}
      {displayState?.kind === "disabled" ? (
        <Alert
          variant="info"
          title="Token usage is turned off"
          description="Recording is off on this host (agents.tokenUsage.enabled)."
          testID="token-usage-disabled"
        />
      ) : null}
      {displayState?.kind === "backfilling" ? (
        <Alert
          variant="info"
          title="Building the 30-day history"
          description={`Scanned ${formatCompactTokens(displayState.filesDone)} of ${formatCompactTokens(displayState.filesTotal)} transcript files.`}
          testID="token-usage-backfilling"
        />
      ) : null}
      {displayState?.kind === "empty" ? (
        <Text style={styles.emptyState} testID="token-usage-empty">
          No token usage yet
        </Text>
      ) : null}
      {displayState?.kind === "data" ? (
        <TokenUsageDataSection
          bars={bars}
          roleTotals={roleTotals}
          costSupported={costSupported}
          costSummary={costSummary}
        />
      ) : null}
      {incompleteAttribution ? (
        <Text style={styles.footerNote} testID="token-usage-attribution-footer">
          Attribution is incomplete — some responses have no known model
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  readyColumn: {
    gap: theme.spacing[6],
  },
  controlsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  // A visible boundary between the unit and range groups (docs/design.md §5: borders separate) —
  // without it, five segments in a row with only a gap between groups reads as one control.
  controlsDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: theme.colors.border,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  loadingLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[8],
  },
  footerNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  costSummaryRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  costSummaryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  costSummaryValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontVariant: ["tabular-nums"],
  },
  costSummaryCaption: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
