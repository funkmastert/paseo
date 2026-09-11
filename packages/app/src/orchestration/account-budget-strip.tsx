import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
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
const DEFAULT_REFETCH_INTERVAL_MS = 75_000;

export function AccountBudgetStrip({
  serverId,
  providerIds,
  refetchIntervalMs = DEFAULT_REFETCH_INTERVAL_MS,
}: {
  serverId: string;
  providerIds: string[];
  refetchIntervalMs?: number;
}) {
  const { view } = useProviderUsage(serverId, { refetchInterval: refetchIntervalMs });
  const { entries } = useProvidersSnapshot(serverId);

  const rows = useMemo(() => {
    if (view.kind !== "ready") return [];
    return buildAccountBudgetRows(view.payload.providers, providerIds, entries);
  }, [entries, providerIds, view]);

  if (rows.length === 0) return null;

  return (
    <View style={styles.container}>
      {rows.map((row) => (
        <AccountBudgetRow key={row.providerId} row={row} serverId={serverId} />
      ))}
    </View>
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
        <Text style={styles.muted}>Usage unavailable</Text>
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
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
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
