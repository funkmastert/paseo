import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { router } from "expo-router";
import { Copy } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { DEFAULT_REFETCH_INTERVAL_MS } from "@/orchestration/account-budget-strip";
import { useCopyFixCommand } from "@/provider-usage/use-copy-fix-command";
import { providerUsageQueryKey, useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  buildAccountAlertEntries,
  signInActionFor,
  type AccountAlertEntry,
} from "./account-alert-model";
import { BelowBannerInsets } from "./below-banner-insets";
import { NO_ACCOUNT_ALERTS, reportHostAccountAlerts, useAccountAlertEntries } from "./store";

const COMPACT_MAX_ENTRIES = 2;
// Matches the daemon's own "Signing in..." cutoff (docs/account-failover.md): a login the app
// never heard back from stops blocking retries after this, win or lose.
const SIGN_IN_TIMEOUT_MS = 3 * 60_000;

const ThemedCopy = withUnistyles(Copy);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const filledIconColor = (theme: Theme) => ({ color: theme.colors.destructiveForeground });

type EntryTone = "filled" | "danger" | "warning";

function toneTextStyle(tone: EntryTone) {
  if (tone === "filled") return styles.filledText;
  if (tone === "danger") return styles.dangerText;
  return styles.warningText;
}

/**
 * Subscribes one host's usage and provider snapshot and reports the host's alert entries to the
 * store. A plain hook can't fan out over a host list whose length changes between renders, so the
 * feed mounts one of these per connected host instead.
 */
function HostAlertSource({ serverId, hostLabel }: { serverId: string; hostLabel: string }) {
  const { view } = useProviderUsage(serverId, {
    refetchInterval: DEFAULT_REFETCH_INTERVAL_MS,
    catchUpOnFocus: true,
  });
  const { entries: snapshot } = useProvidersSnapshot(serverId);
  const alertEntries = useMemo(() => {
    if (view.kind !== "ready") return NO_ACCOUNT_ALERTS;
    const providers = view.payload.providers;
    return buildAccountAlertEntries([{ serverId, hostLabel, providers, entries: snapshot }]);
  }, [serverId, hostLabel, view, snapshot]);

  useEffect(() => {
    reportHostAccountAlerts(serverId, alertEntries);
  }, [serverId, alertEntries]);

  // Unmount only: a cleanup on the report effect would clear and re-add the host every poll.
  useEffect(() => {
    return () => reportHostAccountAlerts(serverId, NO_ACCOUNT_ALERTS);
  }, [serverId]);

  return null;
}

/** One source per connected host; a removed host's source unmounts and clears its entries. */
function AccountAlertFeed() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <HostAlertSource key={host.serverId} serverId={host.serverId} hostLabel={host.label} />
      ))}
    </>
  );
}

function AccountAlertEntryRow({
  entry,
  showHost,
  filled,
}: {
  entry: AccountAlertEntry;
  showHost: boolean;
  /** The banner is filled red (a signed-out entry stands): entry text follows the fill, not its own tone. */
  filled: boolean;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(entry.serverId);
  const isLocalDaemon = useIsLocalDaemon(entry.serverId);
  const signInSupported = useSessionStore(
    (state) => state.sessions[entry.serverId]?.serverInfo?.features?.claudeAccountSignIn === true,
  );
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  // Set synchronously, so a second click before the re-render sends nothing.
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const signInAction = signInActionFor(entry, {
    isElectron: getIsElectron(),
    hostSupportsSignIn: signInSupported,
    isLocalDaemon,
  });

  const handleSignIn = useCallback(() => {
    if (pendingRef.current || !client) return;
    const settle = () => {
      pendingRef.current = false;
      setPending(false);
    };
    pendingRef.current = true;
    setPending(true);
    setError(null);
    void client
      .accountClaudeSignIn(entry.providerId)
      .then((response) => {
        if (response.outcome === "failed") {
          settle();
          setError(response.error ?? t("accountAlerts.signInError"));
          return;
        }
        timeoutRef.current = setTimeout(settle, SIGN_IN_TIMEOUT_MS);
        return;
      })
      .catch((caught: unknown) => {
        settle();
        setError(caught instanceof Error ? caught.message : t("accountAlerts.signInError"));
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: providerUsageQueryKey(entry.serverId) });
      });
  }, [client, entry.providerId, entry.serverId, queryClient, t]);

  const handleCopy = useCopyFixCommand(entry.fixCommand);

  const openSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(entry.serverId, "providers"));
  }, [entry.serverId]);

  let summaryTone: EntryTone = "warning";
  if (filled) summaryTone = "filled";
  else if (entry.kind === "signed_out") summaryTone = "danger";

  let signInControl: ReactNode = null;
  if (signInAction) {
    signInControl =
      signInAction === "sign_in" ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handleSignIn}
          disabled={pending}
          loading={pending}
          testID={`account-alert-sign-in-${entry.providerId}`}
        >
          {pending ? t("accountAlerts.signInPending") : t("accountAlerts.signIn")}
        </Button>
      ) : (
        <Text
          style={[styles.runOn, filled ? styles.filledText : styles.mutedText]}
          numberOfLines={1}
        >
          {t("accountAlerts.signInRunOn", { host: entry.hostLabel })}
        </Text>
      );
  }

  return (
    <View style={styles.entry} testID={`account-alert-entry-${entry.providerId}`}>
      <Pressable onPress={openSettings} accessibilityRole="button">
        <Text style={[styles.entryLabel, filled ? styles.filledText : null]} numberOfLines={1}>
          {showHost ? `${entry.label} · ${entry.hostLabel}` : entry.label}
        </Text>
      </Pressable>
      <Text style={[styles.entrySummary, toneTextStyle(summaryTone)]} numberOfLines={2}>
        {entry.summary}
      </Text>
      {!isCompact ? (
        <Text
          style={[styles.entryCommand, filled ? styles.filledText : styles.mutedText]}
          numberOfLines={1}
        >
          {entry.fixCommand}
        </Text>
      ) : null}
      <View style={styles.entryActions}>
        {signInControl}
        <Pressable
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={t("panels.orchestration.identityCopyFix")}
          testID={`account-alert-copy-${entry.providerId}`}
        >
          <ThemedCopy size={14} uniProps={filled ? filledIconColor : mutedIconColor} />
        </Pressable>
      </View>
      {error ? (
        <Text
          style={[styles.error, filled ? styles.filledText : styles.dangerText]}
          testID={`account-alert-error-${entry.providerId}`}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Not dismissible while a problem stands (docs/design.md §11): filled red the moment any entry
 * is signed out, amber when every entry is only an identity problem. Renders nothing otherwise.
 */
function AccountAlertBanner() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const entries = useAccountAlertEntries();
  const multiHost = useHosts().length > 1;

  const hasSignedOut = entries.some((entry) => entry.kind === "signed_out");
  const visibleEntries = useMemo(
    () => (isCompact ? entries.slice(0, COMPACT_MAX_ENTRIES) : entries),
    [isCompact, entries],
  );
  const hiddenCount = entries.length - visibleEntries.length;
  const overflowServerId = entries[visibleEntries.length]?.serverId;

  const openMore = useCallback(() => {
    if (overflowServerId) {
      router.push(buildSettingsHostSectionRoute(overflowServerId, "providers"));
    }
  }, [overflowServerId]);

  const description = useMemo(
    () => (
      <View style={styles.entries}>
        {visibleEntries.map((entry) => (
          <AccountAlertEntryRow
            key={`${entry.serverId}:${entry.providerId}`}
            entry={entry}
            showHost={multiHost}
            filled={hasSignedOut}
          />
        ))}
        {hiddenCount > 0 ? (
          <Pressable onPress={openMore} accessibilityRole="button" testID="account-alert-more">
            <Text style={[styles.more, hasSignedOut ? styles.filledText : null]}>
              {t("accountAlerts.moreCount", { count: hiddenCount })}
            </Text>
          </Pressable>
        ) : null}
      </View>
    ),
    [visibleEntries, multiHost, hasSignedOut, hiddenCount, openMore, t],
  );

  if (entries.length === 0) return null;

  return (
    <View testID="account-alert-banner">
      <WindowChromeSafeArea placement="below" />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Alert
          variant={hasSignedOut ? "error" : "warning"}
          emphasis={hasSignedOut ? "filled" : "quiet"}
          title={t("accountAlerts.title", { count: entries.length })}
          description={description}
        />
      </View>
    </View>
  );
}

/**
 * Every enabled account's sign-in or identity problem, across every connected host, as a banner
 * above the app shell. Mount once, around the shell: the frame holds no state, so a usage poll
 * re-renders the banner and never the shell.
 */
export function AccountAlertFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <AccountAlertFeed />
      <AccountAlertBanner />
      <BelowBannerInsets>{children}</BelowBannerInsets>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  entries: {
    gap: theme.spacing[3],
  },
  entry: {
    gap: theme.spacing[1],
  },
  entryLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  entrySummary: {
    fontSize: theme.fontSize.sm,
  },
  entryCommand: {
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
  },
  entryActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  runOn: {
    fontSize: theme.fontSize.sm,
  },
  more: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  error: {
    fontSize: theme.fontSize.sm,
  },
  filledText: {
    color: theme.colors.destructiveForeground,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
  },
  dangerText: {
    color: theme.colors.statusDanger,
  },
  warningText: {
    color: theme.colors.statusWarning,
  },
}));
