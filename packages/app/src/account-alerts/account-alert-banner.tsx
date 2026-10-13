import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { router } from "expo-router";
import { AlertTriangle, Copy } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { buttonControlHeight, createControlGeometry } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { DEFAULT_REFETCH_INTERVAL_MS } from "@/orchestration/account-budget-strip";
import { useCopyFixCommand } from "@/provider-usage/use-copy-fix-command";
import { providerUsageQueryKey, useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useHostRegistryLoaded, useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  accountAlertFingerprint,
  buildAccountAlertEntries,
  signInActionFor,
  type AccountAlertEntry,
} from "./account-alert-model";
import { BelowBannerInsets } from "./below-banner-insets";
import {
  pruneAccountAlertDismissals,
  pruneAccountAlertDismissalsForUnknownHosts,
  useAccountAlertDismissStore,
} from "./dismiss-store";
import { SIGN_IN_IDLE, SIGN_IN_TIMEOUT_MS, signInReducer, type SignInEvent } from "./sign-in-state";
import { NO_ACCOUNT_ALERTS, reportHostAccountAlerts, useAccountAlertEntries } from "./store";

const COMPACT_MAX_ENTRIES = 2;
const LINE_HEIGHT_RATIO = 1.4;

/**
 * While any entry stands, poll the daemon often enough that a fix in another terminal clears the
 * banner within about 15s instead of waiting out the quiet-state interval.
 */
const FAST_REFETCH_INTERVAL_MS = 15_000;

const ThemedCopy = withUnistyles(Copy);
const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const filledIconColor = (theme: Theme) => ({ color: theme.colors.destructiveForeground });
const warningIconColor = (theme: Theme) => ({ color: theme.colors.palette.amber[500] });

/**
 * Subscribes one host's usage and provider snapshot and reports the host's alert entries to the
 * store. A plain hook can't fan out over a host list whose length changes between renders, so the
 * feed mounts one of these per connected host instead.
 */
function HostAlertSource({ serverId, hostLabel }: { serverId: string; hostLabel: string }) {
  const [pollFast, setPollFast] = useState(false);
  const { view } = useProviderUsage(serverId, {
    refetchInterval: pollFast ? FAST_REFETCH_INTERVAL_MS : DEFAULT_REFETCH_INTERVAL_MS,
    catchUpOnFocus: true,
    alwaysCatchUp: true,
    refetchIntervalInBackground: true,
    // The daemon serves this from its own cache and reads auth state per call, over a WebSocket
    // this hook does not share with the browser's own connectivity check.
    networkMode: "always",
  });
  const { entries: snapshot } = useProvidersSnapshot(serverId);
  const hostSupportsSignIn = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.claudeAccountSignIn === true,
  );
  const alertEntries = useMemo(() => {
    if (view.kind !== "ready") return NO_ACCOUNT_ALERTS;
    const providers = view.payload.providers;
    return buildAccountAlertEntries([
      { serverId, hostLabel, hostSupportsSignIn, providers, entries: snapshot },
    ]);
  }, [serverId, hostLabel, hostSupportsSignIn, view, snapshot]);

  useEffect(() => {
    setPollFast(alertEntries.length > 0);
  }, [alertEntries]);

  useEffect(() => {
    reportHostAccountAlerts(serverId, alertEntries);
  }, [serverId, alertEntries]);

  // Ready-gated — see pruneAccountAlertDismissalsIn's doc comment for why.
  useEffect(() => {
    if (view.kind !== "ready") return;
    pruneAccountAlertDismissals(serverId, alertEntries.map(accountAlertFingerprint));
  }, [serverId, view.kind, alertEntries]);

  // Unmount only: a cleanup on the report effect would clear and re-add the host every poll.
  useEffect(() => {
    return () => reportHostAccountAlerts(serverId, NO_ACCOUNT_ALERTS);
  }, [serverId]);

  return null;
}

/** One source per connected host; a removed host's source unmounts and clears its entries. */
function AccountAlertFeed() {
  const hosts = useHosts();
  const registryLoaded = useHostRegistryLoaded();

  // Loaded-gated for the same reason as the per-host prune: an empty host list before the
  // registry finishes loading from disk must never read as "every host is gone" and wipe every
  // dismissal. Once loaded, a host missing from this list entirely (archived, removed) has no
  // HostAlertSource left to prune it, so this is the only place that ever drops its dismissals.
  useEffect(() => {
    if (!registryLoaded) return;
    pruneAccountAlertDismissalsForUnknownHosts(hosts.map((host) => host.serverId));
  }, [registryLoaded, hosts]);

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
  /**
   * The banner is filled red (a signed-out entry stands): entry text follows the fill, not its own
   * tone. Always true for a signed-out entry, so only an identity entry ever renders unfilled.
   */
  filled: boolean;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(entry.serverId);
  const isLocalDaemon = useIsLocalDaemon(entry.serverId);
  const queryClient = useQueryClient();
  const [signIn, dispatchSignIn] = useReducer(signInReducer, SIGN_IN_IDLE);
  // Set synchronously, so a second click before the re-render sends nothing.
  const pendingRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const signInAction = signInActionFor(entry, { isElectron: getIsElectron(), isLocalDaemon });

  const handleSignIn = useCallback(() => {
    if (pendingRef.current || !client) return;
    function settle(event: SignInEvent) {
      pendingRef.current = false;
      dispatchSignIn(event);
    }
    pendingRef.current = true;
    dispatchSignIn({ type: "start" });
    void client
      .accountClaudeSignIn(entry.providerId)
      .then((response) => {
        if (response.outcome === "failed") {
          settle({ type: "failed", error: response.error });
          return;
        }
        dispatchSignIn({ type: "started" });
        timeoutRef.current = setTimeout(() => settle({ type: "timed_out" }), SIGN_IN_TIMEOUT_MS);
        return;
      })
      .catch((caught: unknown) => settle({ type: "threw", error: caught }))
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: providerUsageQueryKey(entry.serverId) });
      });
  }, [client, entry.providerId, entry.serverId, queryClient]);

  const isSigningIn = signIn.status === "pending";
  const signInLabel = isSigningIn ? t("accountAlerts.signInPending") : t("accountAlerts.signIn");
  let signInError: string | null = null;
  if (signIn.status === "failed") signInError = signIn.message ?? t("accountAlerts.signInError");

  const handleCopy = useCopyFixCommand(entry.fixCommand);

  const openSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(entry.serverId, "providers"));
  }, [entry.serverId]);

  // Sign in, Run on, and the sign-in error only exist on a signed-out entry, so always on the fill.
  let signInControl: ReactNode = null;
  if (signInAction === "sign_in") {
    signInControl = (
      <Button
        variant="outline"
        size="sm"
        onPress={handleSignIn}
        disabled={isSigningIn}
        loading={isSigningIn}
        testID={`account-alert-sign-in-${entry.providerId}`}
      >
        {signInLabel}
      </Button>
    );
  } else if (signInAction === "run_on_host") {
    signInControl = (
      <Text style={[styles.runOn, styles.filledText]} numberOfLines={1}>
        {t("accountAlerts.signInRunOn", { host: entry.hostLabel })}
      </Text>
    );
  }

  return (
    <View style={styles.entry} testID={`account-alert-entry-${entry.providerId}`}>
      <Button
        variant="ghost"
        size="xs"
        onPress={openSettings}
        style={styles.inlineLink}
        textStyle={[styles.linkText, filled ? styles.filledText : null]}
        hoveredTextStyle={filled ? styles.filledText : null}
      >
        {showHost ? `${entry.label} · ${entry.hostLabel}` : entry.label}
      </Button>
      <Text
        style={[styles.entrySummary, filled ? styles.filledText : styles.warningText]}
        numberOfLines={2}
      >
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
      {signInError ? (
        <Text
          style={[styles.error, styles.filledText]}
          testID={`account-alert-error-${entry.providerId}`}
        >
          {signInError}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Dismissible via the alert's close button (docs/design.md §11): filled red the moment any
 * active entry is signed out, amber when every active entry is only an identity problem.
 * Renders nothing once every current entry is dismissed or fixed; a new problem — a different
 * account, a different kind, or the same account signed out again — shows again regardless of
 * what was dismissed before.
 */
function AccountAlertBanner() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const entries = useAccountAlertEntries();
  const dismissedFingerprints = useAccountAlertDismissStore((state) => state.dismissedFingerprints);
  const dismiss = useAccountAlertDismissStore((state) => state.dismiss);
  const multiHost = useHosts().length > 1;

  const activeEntries = useMemo(() => {
    if (dismissedFingerprints.length === 0) return entries;
    const dismissedSet = new Set(dismissedFingerprints);
    return entries.filter((entry) => !dismissedSet.has(accountAlertFingerprint(entry)));
  }, [entries, dismissedFingerprints]);

  const hasSignedOut = activeEntries.some((entry) => entry.kind === "signed_out");
  const visibleEntries = useMemo(
    () => (isCompact ? activeEntries.slice(0, COMPACT_MAX_ENTRIES) : activeEntries),
    [isCompact, activeEntries],
  );
  const hiddenCount = activeEntries.length - visibleEntries.length;
  const overflowServerId = activeEntries[visibleEntries.length]?.serverId;

  const openMore = useCallback(() => {
    if (overflowServerId) {
      router.push(buildSettingsHostSectionRoute(overflowServerId, "providers"));
    }
  }, [overflowServerId]);

  const handleDismiss = useCallback(() => {
    dismiss(entries.map(accountAlertFingerprint));
  }, [dismiss, entries]);

  const icon = useMemo(
    () => (
      <ThemedAlertTriangle
        size={ICON_SIZE.sm}
        uniProps={hasSignedOut ? filledIconColor : warningIconColor}
      />
    ),
    [hasSignedOut],
  );

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
          <Button
            variant="ghost"
            size="xs"
            onPress={openMore}
            style={styles.inlineLink}
            textStyle={[styles.linkText, hasSignedOut ? styles.filledText : null]}
            hoveredTextStyle={hasSignedOut ? styles.filledText : null}
            testID="account-alert-more"
          >
            {t("accountAlerts.moreCount", { count: hiddenCount })}
          </Button>
        ) : null}
      </View>
    ),
    [visibleEntries, multiHost, hasSignedOut, hiddenCount, openMore, t],
  );

  if (activeEntries.length === 0) return null;

  return (
    <View testID="account-alert-banner">
      <WindowChromeSafeArea placement="below" />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <Alert
          variant={hasSignedOut ? "error" : "warning"}
          emphasis={hasSignedOut ? "filled" : "quiet"}
          icon={icon}
          title={t("accountAlerts.title", { count: activeEntries.length })}
          description={description}
          onDismiss={handleDismiss}
          dismissAccessibilityLabel={t("accountAlerts.dismiss")}
          testID="account-alert-banner-alert"
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

const styles = StyleSheet.create((theme) => {
  // A ghost button's label sits a padding step inside its box, and the box is taller than a line
  // of text. Pulling the box out by both puts the label's ink where plain text would sit; the hit
  // area grows outward instead (docs/design.md §8).
  const ghostInkInset = createControlGeometry(theme).buttonXs.paddingHorizontal;
  const lineHeight = Math.round(theme.fontSize.sm * LINE_HEIGHT_RATIO);
  const lineOverhang = Math.round((lineHeight - buttonControlHeight.xs) / 2);

  return {
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
    inlineLink: {
      alignSelf: "flex-start",
      marginLeft: -ghostInkInset,
      marginVertical: lineOverhang,
    },
    linkText: {
      color: theme.colors.foreground,
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
    error: {
      fontSize: theme.fontSize.sm,
    },
    filledText: {
      color: theme.colors.destructiveForeground,
    },
    mutedText: {
      color: theme.colors.foregroundMuted,
    },
    warningText: {
      color: theme.colors.statusWarning,
    },
  };
});
