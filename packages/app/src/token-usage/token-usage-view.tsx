import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
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
  unit: TokenUsageUnit;
  onUnitChange: (unit: TokenUsageUnit) => void;
  range: TokenUsageRange;
  onRangeChange: (range: TokenUsageRange) => void;
}

export function TokenUsageContent({
  breakdown,
  isLoading,
  unit,
  onUnitChange,
  range,
  onRangeChange,
}: TokenUsageContentProps): ReactElement {
  const displayState = breakdown
    ? resolveTokenUsageDisplayState(breakdown.rows, breakdown.coverage)
    : null;
  const bars = useMemo(
    () => (breakdown ? buildTokenUsageModelBars(breakdown.rows, unit) : []),
    [breakdown, unit],
  );
  const roleTotals = useMemo(
    () => (breakdown ? buildTokenUsageRoleTotals(breakdown.rows, unit) : []),
    [breakdown, unit],
  );
  const incompleteAttribution = breakdown ? hasIncompleteAttribution(breakdown.rows, unit) : false;

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
      {!breakdown && isLoading ? (
        <View style={styles.loadingRow} testID="token-usage-loading">
          <ThemedLoadingSpinner size={14} />
          <Text style={styles.loadingLabel}>Loading...</Text>
        </View>
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
}));
