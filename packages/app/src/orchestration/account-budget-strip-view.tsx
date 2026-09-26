import { Fragment, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { formatPct, formatResetLabel } from "@/provider-usage/format";
import { ProviderUsageMeter, ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import type { Theme } from "@/styles/theme";
import {
  resolveAccountIcon,
  selectAccountWorstWindow,
  type AccountBalanceViewModel,
  type AccountBudgetRowViewModel,
  type AccountPoolRole,
  type AccountUsageCount,
  type WorstBudgetWindow,
} from "./account-budget-strip-model";

/**
 * The strip without its data source, so a capture can hand it rows directly — the poll behind
 * AccountBudgetStrip needs a live host, and its hooks reach the app graph a browser capture cannot
 * bundle. Keep this module free of imports that do. Every account is always on screen: on a phone each is one
 * compact row rather than a fold that shows one of them.
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
  return (
    <View style={styles.strip}>
      <View style={isCompact ? styles.compactContainer : styles.container}>
        {rows.map((row, index) => (
          <Fragment key={row.providerId}>
            {index > 0 && row.section !== rows[index - 1].section ? (
              <View style={styles.sectionRule} testID="orchestration-account-section-rule" />
            ) : null}
            <AccountBudgetRow row={row} serverId={serverId} compact={isCompact} />
          </Fragment>
        ))}
      </View>
      <UsageFreshness fetchedAt={fetchedAt} />
    </View>
  );
}

function useAccountRoleLabel(role: AccountPoolRole | null): string | null {
  const { t } = useTranslation();
  switch (role) {
    case "leader":
      return t("panels.orchestration.accountRoleLeader");
    case "primary":
      return t("panels.orchestration.accountRolePrimary");
    case "backup":
      return t("panels.orchestration.accountRoleBackup");
    default:
      return null;
  }
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

/** Past this the account is near a cap, and when it resets is what a reader needs next. */
const NEAR_CAP_PCT = 80;

/**
 * Where this tab's agents are on the account right now, apart from the pool role beside the label,
 * which is what the account is for. The role is an outlined word; this is a dotted chip. The
 * leader chip only appears when the tab's leader is on the account; the worker chip is always
 * there so the three accounts line up and a zero reads as a zero.
 */
function AccountPresence({ providerId, usage }: { providerId: string; usage: AccountUsageCount }) {
  const { t } = useTranslation();
  const leaderLabel =
    usage.leaders > 1
      ? t("panels.orchestration.accountLeadersHere", { count: usage.leaders })
      : t("panels.orchestration.accountLeaderHere");
  const workersLabel = t("panels.orchestration.accountWorkersHere", { count: usage.workers });
  const dotOn = useMemo(() => <View style={styles.dotOn} />, []);
  const dotOff = useMemo(() => <View style={styles.dotOff} />, []);
  return (
    <View style={styles.header} testID={`orchestration-account-usage-${providerId}`}>
      {usage.leaders > 0 ? (
        <StatusBadge label={leaderLabel} variant="success" leading={dotOn} />
      ) : null}
      <StatusBadge
        label={workersLabel}
        variant={usage.workers > 0 ? "success" : "muted"}
        leading={usage.workers > 0 ? dotOn : dotOff}
      />
    </View>
  );
}

function AccountBalance({ balance }: { balance: AccountBalanceViewModel }) {
  const { t } = useTranslation();
  const amount = balance.remaining
    ? t("panels.orchestration.accountBalanceLeft", { amount: balance.amount })
    : balance.amount;
  return (
    <View style={styles.balance} testID={`orchestration-account-balance-${balance.id}`}>
      <Text style={styles.balanceLabel} numberOfLines={1}>
        {balance.label}
      </Text>
      <Text style={[styles.balanceValue, balanceToneStyle(balance.tone)]} numberOfLines={1}>
        {amount}
      </Text>
    </View>
  );
}

function balanceToneStyle(tone: AccountBalanceViewModel["tone"]) {
  if (tone === "warning") return styles.balanceWarning;
  if (tone === "danger") return styles.balanceDanger;
  return null;
}

function AccountBudgetBody({
  row,
  worst,
  reset,
  compact,
}: {
  row: AccountBudgetRowViewModel;
  worst: WorstBudgetWindow | null;
  reset: string | null;
  compact: boolean;
}) {
  const { t } = useTranslation();
  if (row.kind === "unavailable") {
    return (
      <View style={styles.bars}>
        <Text style={styles.muted}>{t("panels.orchestration.usageUnavailable")}</Text>
        {row.error ? (
          <Text style={styles.muted} testID={`orchestration-account-error-${row.providerId}`}>
            {row.error}
          </Text>
        ) : null}
      </View>
    );
  }
  const balances = row.balances.map((balance) => (
    <AccountBalance key={balance.id} balance={balance} />
  ));
  if (!compact) {
    return (
      <View style={styles.bars}>
        {row.windows.map((window) => (
          <ProviderUsageWindowBar key={window.id} window={window} />
        ))}
        {balances}
      </View>
    );
  }
  return (
    <>
      {worst ? (
        <View style={styles.meterRow}>
          <View style={styles.meterTrack}>
            <ProviderUsageMeter window={worst.window} />
          </View>
          {reset ? (
            <Text style={styles.freshness} numberOfLines={1}>
              {reset}
            </Text>
          ) : null}
        </View>
      ) : null}
      {balances.length > 0 ? <View style={styles.bars}>{balances}</View> : null}
    </>
  );
}

function AccountBudgetRow({
  row,
  serverId,
  compact,
}: {
  row: AccountBudgetRowViewModel;
  serverId: string;
  compact: boolean;
}) {
  const roleLabel = useAccountRoleLabel(row.role);
  const worst = useMemo(() => selectAccountWorstWindow(row), [row]);
  const worstAtRisk =
    worst != null && worst.window.runsOutAt != null && worst.window.shortfallPct != null;
  const reset =
    worst && (worst.usedPct >= NEAR_CAP_PCT || worstAtRisk)
      ? formatResetLabel(worst.window.resetsAt)
      : null;
  return (
    <View
      style={compact ? styles.compactRow : styles.row}
      testID={`orchestration-account-${row.providerId}`}
    >
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
        {row.plan ? (
          <Text style={styles.plan} numberOfLines={1}>
            {row.plan}
          </Text>
        ) : null}
        {roleLabel ? <StatusBadge label={roleLabel} /> : null}
        {compact && worst ? (
          <Text style={styles.summaryValue} numberOfLines={1}>
            {`${worst.window.label} ${formatPct(worst.usedPct)}`}
          </Text>
        ) : null}
      </View>
      {row.usage ? <AccountPresence providerId={row.providerId} usage={row.usage} /> : null}
      <AccountBudgetBody row={row} worst={worst} reset={reset} compact={compact} />
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
  compactContainer: {
    gap: theme.spacing[3],
  },
  compactRow: {
    gap: theme.spacing[2],
  },
  // The fullest window's figure, pushed to the row's trailing edge; the label yields to it.
  summaryValue: {
    marginLeft: "auto",
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterTrack: {
    flex: 1,
  },
  dotOn: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.statusDotSuccess,
  },
  dotOff: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foregroundMuted,
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
  // Between the Claude pool and the other providers. Full width, so on the wrapping desktop grid
  // it also forces the next section onto its own line.
  sectionRule: {
    width: "100%",
    height: 1,
    backgroundColor: theme.colors.border,
  },
  plan: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  balance: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  balanceLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  balanceValue: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  balanceWarning: {
    color: theme.colors.statusWarning,
  },
  balanceDanger: {
    color: theme.colors.statusDanger,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
