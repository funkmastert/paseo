import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Clipboard from "expo-clipboard";
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
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { providerUsageQueryKey, useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { ProviderUsage } from "@/provider-usage/types";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  buildAccountAlertEntries,
  signInActionFor,
  type AccountAlertEntry,
  type AccountAlertHostUsage,
} from "./account-alert-model";

// The strip's cadence (account-budget-strip.tsx): well under the daemon's 5-minute usage cache.
const REFETCH_INTERVAL_MS = 75_000;
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

const EMPTY_PROVIDERS: readonly ProviderUsage[] = [];

/**
 * Subscribes one host's usage and provider snapshot and reports the combined row up. A plain
 * hook can't fan out over a host list whose length changes between renders, so the banner mounts
 * one of these per connected host instead and lifts the result through `onChange`.
 */
function HostAlertSource({
  serverId,
  hostLabel,
  onChange,
}: {
  serverId: string;
  hostLabel: string;
  onChange: (serverId: string, usage: AccountAlertHostUsage | null) => void;
}) {
  const { view } = useProviderUsage(serverId, {
    refetchInterval: REFETCH_INTERVAL_MS,
    catchUpOnFocus: true,
  });
  const { entries } = useProvidersSnapshot(serverId);
  const providers = useMemo(
    () => (view.kind === "ready" ? view.payload.providers : EMPTY_PROVIDERS),
    [view],
  );

  useEffect(() => {
    onChange(serverId, providers.length > 0 ? { serverId, hostLabel, providers, entries } : null);
  }, [serverId, hostLabel, providers, entries, onChange]);

  useEffect(() => {
    return () => onChange(serverId, null);
  }, [serverId, onChange]);

  return null;
}

/**
 * Every enabled account's sign-in or identity problem, merged across every connected host. Mount
 * once, high in the tree; `children` renders with the live state so a caller (the banner itself,
 * or a layout that needs to know whether the banner is showing) never fetches this twice.
 */
export function AccountAlertFeed({
  children,
}: {
  children: (state: { entries: AccountAlertEntry[]; multiHost: boolean }) => ReactNode;
}) {
  const hosts = useHosts();
  const [byHost, setByHost] = useState<Record<string, AccountAlertHostUsage>>({});

  const handleChange = useCallback((serverId: string, usage: AccountAlertHostUsage | null) => {
    setByHost((previous) => {
      if (usage === null) {
        if (!(serverId in previous)) return previous;
        const next = { ...previous };
        delete next[serverId];
        return next;
      }
      return { ...previous, [serverId]: usage };
    });
  }, []);

  // A host that disconnects entirely (removed, not just offline) stops reporting through
  // HostAlertSource's unmount cleanup only if it was mounted; this covers the gap.
  useEffect(() => {
    const liveIds = new Set(hosts.map((host) => host.serverId));
    setByHost((previous) => {
      let changed = false;
      const next: Record<string, AccountAlertHostUsage> = {};
      for (const [serverId, usage] of Object.entries(previous)) {
        if (liveIds.has(serverId)) {
          next[serverId] = usage;
        } else {
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [hosts]);

  const state = useMemo(
    () => ({
      entries: buildAccountAlertEntries(Object.values(byHost)),
      multiHost: hosts.length > 1,
    }),
    [byHost, hosts.length],
  );

  return (
    <>
      {hosts.map((host) => (
        <HostAlertSource
          key={host.serverId}
          serverId={host.serverId}
          hostLabel={host.label}
          onChange={handleChange}
        />
      ))}
      {children(state)}
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
  const toast = useToast();
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

  const handleCopy = useCallback(() => {
    void (async () => {
      try {
        await Clipboard.setStringAsync(entry.fixCommand);
        toast.copied(t("panels.orchestration.identityCopied"));
      } catch {
        toast.error(t("panels.orchestration.identityCopyError"));
      }
    })();
  }, [entry.fixCommand, t, toast]);

  const openSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(entry.serverId, "providers"));
  }, [entry.serverId]);

  let summaryTone: EntryTone = "warning";
  if (filled) summaryTone = "filled";
  else if (entry.kind === "signed_out") summaryTone = "danger";

  let signInControl: ReactNode = null;
  if (signInAction) {
    signInControl = signInAction === "sign_in" ? (
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
      <Text style={[styles.runOn, filled ? styles.filledText : styles.mutedText]} numberOfLines={1}>
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
export function AccountAlertBanner({
  entries,
  multiHost,
}: {
  entries: AccountAlertEntry[];
  multiHost: boolean;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const hasSignedOut = entries.some((entry) => entry.kind === "signed_out");
  const visibleEntries = isCompact ? entries.slice(0, COMPACT_MAX_ENTRIES) : entries;
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
