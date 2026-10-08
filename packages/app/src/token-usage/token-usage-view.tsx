import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  buildTokenUsageModelBars,
  buildTokenUsageRoleTotals,
  formatCompactTokens,
  hasIncompleteAttribution,
  resolveTokenUsageDisplayState,
  type TokenUsageBreakdown,
  type TokenUsageRange,
  type TokenUsageUnit,
} from "./token-usage-model";
import { TokensByModelCard } from "./tokens-by-model-card";
import { TokensByRoleCard } from "./tokens-by-role-card";

/**
 * The screen's presentational pieces: no `expo-router`, no navigation hooks. A capture (or this
 * screen's browser test) can mount these directly with fixture data — `expo-router`'s `router`
 * singleton pulls in the whole navigation stack, which breaks the browser capture's esbuild loader
 * on its JSX (the same trap `jev-dashboard-view.tsx` avoids). `token-usage-screen.tsx` wires
 * fixture data today and will wire `use-token-usage.ts` in U5, without touching this file.
 */

const UNIT_OPTIONS: SegmentedControlOption<TokenUsageUnit>[] = [
  { value: "weighted", label: "Weighted", testID: "token-usage-unit-weighted" },
  { value: "raw", label: "Raw", testID: "token-usage-unit-raw" },
];

const RANGE_OPTIONS: SegmentedControlOption<TokenUsageRange>[] = [
  { value: "24h", label: "24h", testID: "token-usage-range-24h" },
  { value: "7d", label: "7 days", testID: "token-usage-range-7d" },
  { value: "30d", label: "30 days", testID: "token-usage-range-30d" },
];

export interface TokenUsageContentProps {
  breakdown: TokenUsageBreakdown;
  unit: TokenUsageUnit;
  onUnitChange: (unit: TokenUsageUnit) => void;
  range: TokenUsageRange;
  onRangeChange: (range: TokenUsageRange) => void;
}

export function TokenUsageContent({
  breakdown,
  unit,
  onUnitChange,
  range,
  onRangeChange,
}: TokenUsageContentProps): ReactElement {
  const displayState = resolveTokenUsageDisplayState(breakdown.rows, breakdown.coverage);
  const bars = useMemo(
    () => buildTokenUsageModelBars(breakdown.rows, unit),
    [breakdown.rows, unit],
  );
  const roleTotals = useMemo(
    () => buildTokenUsageRoleTotals(breakdown.rows, unit),
    [breakdown.rows, unit],
  );
  const incompleteAttribution = hasIncompleteAttribution(breakdown.rows, unit);

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
        <SegmentedControl
          size="sm"
          value={range}
          onValueChange={onRangeChange}
          options={RANGE_OPTIONS}
          testID="token-usage-range"
        />
      </View>
      {displayState.kind === "backfilling" ? (
        <Alert
          variant="info"
          title="Building the 30-day history"
          description={`Scanned ${formatCompactTokens(displayState.filesDone)} of ${formatCompactTokens(displayState.filesTotal)} transcript files.`}
          testID="token-usage-backfilling"
        />
      ) : null}
      {displayState.kind === "empty" ? (
        <Text style={styles.emptyState} testID="token-usage-empty">
          No token usage yet
        </Text>
      ) : null}
      {displayState.kind === "data" ? (
        <>
          <TokensByModelCard bars={bars} />
          <TokensByRoleCard totals={roleTotals} />
        </>
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
    gap: theme.spacing[3],
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
}));
