import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { formatPct, formatResetLabel } from "@/provider-usage/format";
import { ProviderUsageMeter, ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { Theme } from "@/styles/theme";
import {
  buildAccountBudgetRows,
  resolveAccountIcon,
  selectWorstBudgetWindow,
  type AccountBudgetRowViewModel,
} from "./account-budget-strip-model";

// Server caches usage for 5min; polling faster than that just re-serves the cache, so
// this stays well under that ceiling without hammering the daemon.
export const DEFAULT_REFETCH_INTERVAL_MS = 75_000;

export function AccountBudgetStrip({
  serverId,
  providerIds,
  refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS,
}: {
  serverId: string;
  providerIds: string[];
  refetchIntervalMs?: number;
}) {
  const { view } = useProviderUsage(serverId, {
    refetchInterval: refetchIntervalMs,
    catchUpOnFocus: true,
  });
  const { entries } = useProvidersSnapshot(serverId);

  const rows = useMemo(() => {
    if (view.kind !== "ready") return [];
    return buildAccountBudgetRows(view.payload.providers, providerIds, entries);
  }, [entries, providerIds, view]);
  const fetchedAt = useMemo(
    () => (view.kind === "ready" ? new Date(view.fetchedAt) : null),
    [view],
  );

  return <AccountBudgetStripView rows={rows} serverId={serverId} fetchedAt={fetchedAt} />;
}

/**
 * The strip without its data source, so a capture can hand it rows directly — the poll behind
 * AccountBudgetStrip needs a live host.
 */
export function AccountBudgetStripView({
  rows,
  serverId,
  fetchedAt,
}: {
  rows: AccountBudgetRowViewModel[];
  serverId: string;
  fetchedAt: Date | null;
}) {
  const isCompact = useIsCompactFormFactor();
  if (rows.length === 0) return null;
  if (isCompact) return <CompactBudgetStrip rows={rows} serverId={serverId} fetchedAt={fetchedAt} />;
  return (
    <View style={styles.strip}>
      <AccountBudgetRows rows={rows} serverId={serverId} />
      <UsageFreshness fetchedAt={fetchedAt} />
    </View>
  );
}

function AccountBudgetRows({
  rows,
  serverId,
}: {
  rows: AccountBudgetRowViewModel[];
  serverId: string;
}) {
  return (
    <View style={styles.container}>
      {rows.map((row) => (
        <AccountBudgetRow key={row.providerId} row={row} serverId={serverId} />
      ))}
    </View>
  );
}

/**
 * Three accounts at two windows each is six full-width bars — most of a phone's screen before a
 * single agent row. The collapsed strip is the one window that matters (the fullest, across every
 * account) and a tap opens the rest. It keeps the read time in view: the number is polled from a
 * cached endpoint and must not pass for live.
 */
function CompactBudgetStrip({
  rows,
  serverId,
  fetchedAt,
}: {
  rows: AccountBudgetRowViewModel[];
  serverId: string;
  fetchedAt: Date | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);
  const worst = useMemo(() => selectWorstBudgetWindow(rows), [rows]);
  const label = useCompactTimeAgo(fetchedAt);
  const Chevron = expanded ? ThemedChevronUp : ThemedChevronDown;

  const summaryRow = worst?.row ?? rows[0];
  const reset = worst ? formatResetLabel(worst.window.resetsAt) : null;
  const accessibilityLabel = worst
    ? `${worst.row.label}, ${worst.window.label} ${formatPct(worst.usedPct)}${reset ? `, ${reset}` : ""}`
    : summaryRow.label;

  return (
    <View style={styles.strip}>
      <Pressable
        testID="orchestration-budget-summary"
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded }}
        onPress={handleToggle}
        style={styles.summary}
      >
        <View style={styles.summaryTop}>
          <ThemedAccountUsageIcon
            providerId={summaryRow.providerId}
            serverId={serverId}
            size={14}
            uniProps={mutedIconColor}
          />
          <Text style={styles.summaryLabel} numberOfLines={1}>
            {summaryRow.label}
          </Text>
          {worst ? (
            <Text style={styles.summaryValue} numberOfLines={1}>
              {`${worst.window.label} ${formatPct(worst.usedPct)}`}
              {reset ? <Text style={styles.summaryReset}>{` · ${reset}`}</Text> : null}
            </Text>
          ) : (
            <Text style={styles.muted}>{t("panels.orchestration.usageUnavailable")}</Text>
          )}
          <Chevron size={14} uniProps={mutedIconColor} />
        </View>
        {worst ? (
          <View style={styles.summaryMeter}>
            <View style={styles.summaryMeterTrack}>
              <ProviderUsageMeter window={worst.window} />
            </View>
            {label ? (
              <Text style={styles.freshness} numberOfLines={1} testID="orchestration-usage-freshness">
                {t("panels.orchestration.usageAsOf", { time: label })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
      {expanded ? <AccountBudgetRows rows={rows} serverId={serverId} /> : null}
    </View>
  );
}

/**
 * When the bars were last read. Usage is polled and served from a daemon-side cache, so these
 * numbers are never live; without a timestamp a strip that stopped polling — the window was in
 * the background, the host went away — presents hours-old headroom as the headroom you have now.
 */
function UsageFreshness({ fetchedAt }: { fetchedAt: Date | null }) {
  const { t } = useTranslation();
  const label = useCompactTimeAgo(fetchedAt);
  if (!label) return null;
  return (
    <Text style={styles.freshness} numberOfLines={1} testID="orchestration-usage-freshness">
      {t("panels.orchestration.usageAsOf", { time: label })}
    </Text>
  );
}

interface AccountUsageIconProps {
  providerId: string;
  serverId: string;
  size: number;
  color?: string;
}

function AccountUsageIcon({ providerId, serverId, size, color = "" }: AccountUsageIconProps) {
  const Icon = resolveAccountIcon(providerId, serverId);
  return <Icon size={size} color={color} />;
}

const ThemedAccountUsageIcon = withUnistyles(AccountUsageIcon);

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function AccountBudgetRow({ row, serverId }: { row: AccountBudgetRowViewModel; serverId: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <ThemedAccountUsageIcon
          providerId={row.providerId}
          serverId={serverId}
          size={14}
          uniProps={mutedIconColor}
        />
        <Text style={styles.label} numberOfLines={1}>
          {row.label}
        </Text>
      </View>
      {row.kind === "unavailable" ? (
        <Text style={styles.muted}>{t("panels.orchestration.usageUnavailable")}</Text>
      ) : (
        <View style={styles.bars}>
          {row.windows.map((window) => (
            <ProviderUsageWindowBar key={window.id} window={window} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: {
    gap: theme.spacing[2],
  },
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
  },
  freshness: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  // 44pt is Apple's minimum; the summary is the whole tap target for the expand.
  summary: {
    minHeight: 44,
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  summaryTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryLabel: {
    flexGrow: 1,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  summaryValue: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  summaryReset: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  summaryMeter: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  summaryMeterTrack: {
    flex: 1,
  },
  row: {
    flexGrow: 1,
    flexBasis: 220,
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  bars: {
    gap: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
