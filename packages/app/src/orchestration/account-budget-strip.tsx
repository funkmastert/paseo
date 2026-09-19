import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { Theme } from "@/styles/theme";
import {
  buildAccountBudgetRows,
  resolveAccountIcon,
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

  if (rows.length === 0) return null;

  return (
    <View style={styles.strip}>
      <View style={styles.container}>
        {rows.map((row) => (
          <AccountBudgetRow key={row.providerId} row={row} serverId={serverId} />
        ))}
      </View>
      <UsageFreshness fetchedAt={fetchedAt} />
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
