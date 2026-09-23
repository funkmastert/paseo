import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { NotificationsPolicyPayload } from "@getpaseo/protocol/notify-policy/rpc-schemas";
import type {
  NotifyAvailabilityMode,
  NotifyLedgerEntry,
  NotifyPolicySettings,
} from "@getpaseo/protocol/notify-policy/types";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";
import {
  AVAILABILITY_MODES,
  availabilityForMode,
  DIGEST_INTERVAL_CHOICES,
  digestIntervalChoice,
  DURATION_CHOICES,
  durationChoiceForAvailability,
  INTERRUPT_CHOICES,
  interruptChoice,
  interruptPatch,
  NOTICES_CHOICES,
  noticesChoice,
  noticesPatch,
  type DigestIntervalChoice,
  type DurationChoice,
  type InterruptChoice,
  type NoticesChoice,
} from "@/screens/settings/host-notifications-state";

const UNREACHED_PREVIEW_LIMIT = 5;

function policyQueryKey(serverId: string) {
  return ["notify-policy", serverId] as const;
}

function unreachedQueryKey(serverId: string) {
  return ["notify-ledger-unreached", serverId] as const;
}

/**
 * The daemon's notify policy for one host: how loud an alert has to be to interrupt, whether
 * notices arrive as a digest, and whether the person is heads-down or away. The daemon owns the
 * decision (docs/notification-policy.md); this only edits its settings and shows what never landed.
 */
export function HostNotificationsSection({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(host.serverId);
  const connected = useHostRuntimeIsConnected(host.serverId);
  // COMPAT(notificationPolicy): added in v0.8.1, remove gate after 2027-09-23.
  const supported = useHostFeature(host.serverId, "notificationPolicy");
  const enabled = Boolean(client && connected && supported);

  const policy = useFetchQuery({
    queryKey: policyQueryKey(host.serverId),
    queryFn: async () => {
      if (!client) throw new Error(t("settings.host.notifications.loadError"));
      return client.getNotificationPolicy();
    },
    enabled,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const unreached = useFetchQuery({
    queryKey: unreachedQueryKey(host.serverId),
    queryFn: async () => {
      if (!client) throw new Error(t("settings.host.notifications.loadError"));
      return client.listNotificationLedger({
        unreachedOnly: true,
        limit: UNREACHED_PREVIEW_LIMIT,
      });
    },
    enabled: enabled && (policy.data?.unreachedCount ?? 0) > 0,
    dataShape: "value",
    staleTimeMs: 0,
  });

  const mutation = useMutation({
    mutationFn: async (changes: Partial<NotifyPolicySettings>) => {
      if (!client) throw new Error(t("settings.host.notifications.loadError"));
      return client.setNotificationPolicy(changes);
    },
    onSuccess: (next) => {
      queryClient.setQueryData(policyQueryKey(host.serverId), next);
    },
    onError: () => toast.error(t("errors.unableToSave")),
  });
  const save = mutation.mutate;

  if (!supported) {
    return (
      <SettingsSection title={t("settings.host.notifications.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.notifications.unsupported")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t("settings.host.notifications.title")}
      info={t("settings.host.notifications.info")}
      testID="host-notifications-section"
    >
      <View style={settingsStyles.card}>
        {policy.data ? (
          <NotificationPolicyRows
            policy={policy.data}
            unreachedEntries={unreached.data?.entries ?? []}
            onChange={save}
          />
        ) : (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>
              {policy.isError
                ? t("settings.host.notifications.loadError")
                : t("common.states.loading")}
            </Text>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

function NotificationPolicyRows({
  policy,
  unreachedEntries,
  onChange,
}: {
  policy: NotificationsPolicyPayload;
  unreachedEntries: NotifyLedgerEntry[];
  onChange: (changes: Partial<NotifyPolicySettings>) => void;
}) {
  const { settings, effectiveAvailability } = policy;
  const mode = effectiveAvailability.mode;
  // The duration is the person's choice for the *next* timed mode, so it follows the daemon's end
  // time while a timed mode is running and defaults to an hour otherwise.
  const duration: DurationChoice =
    mode === "available"
      ? "oneHour"
      : durationChoiceForAvailability(effectiveAvailability, Date.now());

  const handleMode = useCallback(
    (next: NotifyAvailabilityMode) =>
      onChange({ availability: availabilityForMode(next, duration, Date.now()) }),
    [duration, onChange],
  );
  const handleDuration = useCallback(
    (next: DurationChoice) =>
      onChange({ availability: availabilityForMode(mode, next, Date.now()) }),
    [mode, onChange],
  );
  const handleInterrupt = useCallback(
    (next: InterruptChoice) => onChange(interruptPatch(next)),
    [onChange],
  );
  const handleNotices = useCallback(
    (next: NoticesChoice) => onChange(noticesPatch(next)),
    [onChange],
  );
  const handleInterval = useCallback(
    (next: DigestIntervalChoice) => onChange({ digestIntervalMinutes: Number(next) }),
    [onChange],
  );

  return (
    <>
      <AvailabilityRow mode={mode} until={effectiveAvailability.until} onChange={handleMode} />
      {mode === "available" ? null : <DurationRow duration={duration} onChange={handleDuration} />}
      <InterruptRow choice={interruptChoice(settings)} onChange={handleInterrupt} />
      <NoticesRows
        notices={noticesChoice(settings)}
        interval={digestIntervalChoice(settings)}
        interruptsOnNotices={interruptChoice(settings) === "notice"}
        onNoticesChange={handleNotices}
        onIntervalChange={handleInterval}
      />
      <StatusRows
        heldCount={policy.heldCount}
        unreachedCount={policy.unreachedCount}
        unreachedEntries={unreachedEntries}
      />
    </>
  );
}

function AvailabilityRow({
  mode,
  until,
  onChange,
}: {
  mode: NotifyAvailabilityMode;
  until: string | null | undefined;
  onChange: (mode: NotifyAvailabilityMode) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      AVAILABILITY_MODES.map((value) => ({
        value,
        label: t(`settings.host.notifications.availability.options.${value}`),
        testID: `host-notifications-availability-${value}`,
      })),
    [t],
  );
  const endsAt =
    mode !== "available" && until
      ? t("settings.host.notifications.duration.endsAt", {
          time: new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        })
      : null;
  return (
    <View style={[settingsStyles.row, styles.choiceRow]}>
      <View>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.host.notifications.availability.label")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {endsAt ?? t(`settings.host.notifications.availability.hints.${mode}`)}
        </Text>
      </View>
      <SegmentedControl
        size="sm"
        options={options}
        value={mode}
        onValueChange={onChange}
        testID="host-notifications-availability"
      />
    </View>
  );
}

function DurationRow({
  duration,
  onChange,
}: {
  duration: DurationChoice;
  onChange: (duration: DurationChoice) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      DURATION_CHOICES.map((value) => ({
        value,
        label: t(`settings.host.notifications.duration.options.${value}`),
      })),
    [t],
  );
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.choiceRow]}>
      <Text style={settingsStyles.rowTitle}>{t("settings.host.notifications.duration.label")}</Text>
      <SegmentedControl size="sm" options={options} value={duration} onValueChange={onChange} />
    </View>
  );
}

function InterruptRow({
  choice,
  onChange,
}: {
  choice: InterruptChoice;
  onChange: (choice: InterruptChoice) => void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () =>
      INTERRUPT_CHOICES.map((value) => ({
        value,
        label: t(`settings.host.notifications.interrupt.options.${value}`),
      })),
    [t],
  );
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.choiceRow]}>
      <View>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.host.notifications.interrupt.label")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.host.notifications.interrupt.hint")}
        </Text>
      </View>
      <SegmentedControl size="sm" options={options} value={choice} onValueChange={onChange} />
    </View>
  );
}

function NoticesRows({
  notices,
  interval,
  interruptsOnNotices,
  onNoticesChange,
  onIntervalChange,
}: {
  notices: NoticesChoice;
  interval: DigestIntervalChoice;
  /** Everything already interrupts, so there is no digest to configure. */
  interruptsOnNotices: boolean;
  onNoticesChange: (choice: NoticesChoice) => void;
  onIntervalChange: (choice: DigestIntervalChoice) => void;
}) {
  const { t } = useTranslation();
  const noticeOptions = useMemo(
    () =>
      NOTICES_CHOICES.map((value) => ({
        value,
        label: t(`settings.host.notifications.notices.options.${value}`),
      })),
    [t],
  );
  const intervalOptions = useMemo(
    () =>
      DIGEST_INTERVAL_CHOICES.map((value) => ({
        value,
        label: t(`settings.host.notifications.digestInterval.options.m${value}`),
      })),
    [t],
  );
  if (interruptsOnNotices) return null;
  return (
    <>
      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.choiceRow]}>
        <View>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.notifications.notices.label")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.notifications.notices.hint")}
          </Text>
        </View>
        <SegmentedControl
          size="sm"
          options={noticeOptions}
          value={notices}
          onValueChange={onNoticesChange}
        />
      </View>
      {notices === "digest" ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.choiceRow]}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.notifications.digestInterval.label")}
          </Text>
          <SegmentedControl
            size="sm"
            options={intervalOptions}
            value={interval}
            onValueChange={onIntervalChange}
          />
        </View>
      ) : null}
    </>
  );
}

function StatusRows({
  heldCount,
  unreachedCount,
  unreachedEntries,
}: {
  heldCount: number;
  unreachedCount: number;
  unreachedEntries: NotifyLedgerEntry[];
}) {
  const { t } = useTranslation();
  if (heldCount === 0 && unreachedCount === 0) return null;
  return (
    <>
      {heldCount > 0 ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.notifications.status.held")}
          </Text>
          <Text style={settingsStyles.rowHint}>{heldCount}</Text>
        </View>
      ) : null}
      {unreachedCount > 0 ? (
        <View
          style={[settingsStyles.row, settingsStyles.rowBorder, styles.choiceRow]}
          testID="host-notifications-unreached"
        >
          <View>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.host.notifications.status.unreached", { count: unreachedCount })}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.host.notifications.status.unreachedHint")}
            </Text>
          </View>
          {unreachedEntries.map((entry) => (
            <Text key={entry.id} style={settingsStyles.rowHint} numberOfLines={2}>
              {entry.error ? `${entry.title}: ${entry.error}` : entry.title}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  choiceRow: {
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: theme.spacing[3],
  },
}));
