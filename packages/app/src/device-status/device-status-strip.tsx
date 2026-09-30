import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  MoreVertical,
  Power,
  Smartphone,
  Unlock,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/utils/confirm-dialog";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import type { Theme } from "@/styles/theme";
import { useDeviceActions, useDeviceStatus } from "./use-device-status";
import type { DeviceStatusMode, DeviceStatusRow, DeviceStatusTone } from "./device-status-model";

const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedUnlock = withUnistyles(Unlock);
const ThemedBookmark = withUnistyles(Bookmark);
const ThemedBookmarkCheck = withUnistyles(BookmarkCheck);
const ThemedPower = withUnistyles(Power);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const MENU_ICON_SIZE = 14;
// Module scope, like schedule-row.tsx's editLeading/deleteLeading: a JSX value created fresh
// every render is a new prop identity every render (eslint-plugin-react-perf).
const kebabIcon = <ThemedKebab size={MENU_ICON_SIZE} uniProps={foregroundMutedColorMapping} />;
const releaseLeading = (
  <ThemedUnlock size={MENU_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
);
const reserveLeading = (
  <ThemedBookmark size={MENU_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
);
const unreserveLeading = (
  <ThemedBookmarkCheck size={MENU_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
);
const shutdownLeading = <ThemedPower size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

function toneDotStyle(tone: DeviceStatusTone) {
  switch (tone) {
    case "warning":
      return styles.dotWarning;
    case "danger":
      return styles.dotDanger;
    default:
      return styles.dotOk;
  }
}

/** "Held by <agent>", "Reserved for you", "Free — the next agent that asks gets this", or
 * "Starting" — in that priority, since a reserved device can still show a current holder. */
function resolveHolderTranslationKey(row: DeviceStatusRow): string {
  if (row.holderKey === "heldBy") return "deviceStatus.heldBy";
  if (row.holderKey === "unleased") {
    return row.reserved ? "deviceStatus.reservedForYou" : "deviceStatus.free";
  }
  return `deviceStatus.${row.holderKey}`;
}

/** Short and glanceable: a device held for 2h14m reads "2h14m", not "2 hours 14 minutes". */
function formatHeldFor(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Whether the daemon config RPC round-tripped in time to flip the switch, or it should snap
 * back to what the daemon actually reports (the next push always wins). */
function useDryRunToggle(serverId: string | null) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [pending, setPending] = useState(false);
  const onValueChange = useCallback(
    (next: boolean) => {
      void (async () => {
        setPending(true);
        try {
          await patchConfig({ agents: { deviceLeases: { dryRun: next } } });
        } finally {
          setPending(false);
        }
      })();
    },
    [patchConfig],
  );
  return { canToggle: config !== null, pending, onValueChange };
}

function ModeHeader({
  mode,
  serverId,
  canManage,
}: {
  mode: DeviceStatusMode;
  serverId: string | null;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { canToggle, pending, onValueChange } = useDryRunToggle(serverId);

  return (
    <View style={styles.modeHeader} testID="device-status-mode-header">
      <View style={styles.modeHeaderText}>
        <Text style={styles.modeHeaderTitle}>{t(`deviceStatus.mode.${mode}`)}</Text>
        <Text style={styles.modeHeaderDescription} numberOfLines={2}>
          {t(`deviceStatus.mode.${mode}Description`)}
        </Text>
      </View>
      {canManage && canToggle && mode !== "off" ? (
        <Switch
          value={mode === "dryRun"}
          onValueChange={onValueChange}
          disabled={pending}
          accessibilityLabel={t("deviceStatus.dryRun")}
          testID="device-status-dry-run-switch"
        />
      ) : null}
    </View>
  );
}

function DeviceActionsMenu({
  row,
  onRelease,
  onSetReservation,
  onShutdown,
}: {
  row: DeviceStatusRow;
  onRelease: (deviceId: string) => Promise<void>;
  onSetReservation: (deviceId: string, reserved: boolean) => Promise<void>;
  onShutdown: (deviceId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"release" | "reserve" | "shutdown" | null>(null);
  const deviceId = row.deviceId;
  const reserved = row.reserved;

  const run = useCallback(
    (key: "release" | "reserve" | "shutdown", action: () => Promise<void>) => {
      void (async () => {
        setBusy(key);
        try {
          await action();
        } finally {
          setBusy(null);
        }
      })();
    },
    [],
  );
  const handleRelease = useCallback(() => {
    if (deviceId) run("release", () => onRelease(deviceId));
  }, [run, onRelease, deviceId]);
  const handleToggleReservation = useCallback(() => {
    if (deviceId) run("reserve", () => onSetReservation(deviceId, !reserved));
  }, [run, onSetReservation, deviceId, reserved]);
  const handleShutdown = useCallback(() => {
    if (deviceId) run("shutdown", () => onShutdown(deviceId));
  }, [run, onShutdown, deviceId]);

  if (!deviceId) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={styles.kebabTrigger}
        testID={`device-status-actions-${row.key}`}
        accessibilityLabel={t("deviceStatus.actions.menuLabel")}
      >
        {kebabIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        {row.holderKey === "heldBy" ? (
          <DropdownMenuItem
            leading={releaseLeading}
            status={busy === "release" ? "pending" : "idle"}
            onSelect={handleRelease}
            testID={`device-status-release-${row.key}`}
          >
            {t("deviceStatus.actions.release")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          leading={reserved ? unreserveLeading : reserveLeading}
          status={busy === "reserve" ? "pending" : "idle"}
          onSelect={handleToggleReservation}
          testID={`device-status-reserve-${row.key}`}
        >
          {t(reserved ? "deviceStatus.actions.unreserve" : "deviceStatus.actions.reserve")}
        </DropdownMenuItem>
        {row.isRunning ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              leading={shutdownLeading}
              destructive
              status={busy === "shutdown" ? "pending" : "idle"}
              onSelect={handleShutdown}
              testID={`device-status-shutdown-${row.key}`}
            >
              {t("deviceStatus.actions.shutdown")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeviceRow({
  row,
  canManage,
  onRelease,
  onSetReservation,
  onShutdown,
}: {
  row: DeviceStatusRow;
  canManage: boolean;
  onRelease: (deviceId: string) => Promise<void>;
  onSetReservation: (deviceId: string, reserved: boolean) => Promise<void>;
  onShutdown: (deviceId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const actionsVisible = isHovered || isNative || isCompact;
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const holder = t(resolveHolderTranslationKey(row), { agent: row.agentLabel ?? row.agentId });
  const heldFor =
    row.heldForSeconds === undefined
      ? ""
      : ` · ${t("deviceStatus.runningFor", { duration: formatHeldFor(row.heldForSeconds) })}`;
  // Said on the row itself, not only in a footnote: this is the device the cap could not have
  // stopped, and which device that is matters as much as how many there are.
  const enforcement =
    row.enforcement && row.enforcement !== "refuses"
      ? ` · ${t(`deviceStatus.enforcement.${row.enforcement}`)}`
      : "";

  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`device-status-row-${row.key}`}
    >
      <View style={styles.rowTextGroup}>
        <Text style={styles.rowName} numberOfLines={1}>
          {t(`deviceStatus.platform.${row.platform}`)}
          {row.label ? ` · ${row.label}` : ""}
          {row.reserved && row.holderKey === "heldBy"
            ? ` · ${t("deviceStatus.reservedForYou")}`
            : ""}
        </Text>
        <Text style={styles.rowStatus} numberOfLines={1}>
          {holder}
          {heldFor}
          {enforcement}
          {row.reason ? ` · ${row.reason}` : ""}
        </Text>
      </View>
      {canManage && actionsVisible ? (
        <DeviceActionsMenu
          row={row}
          onRelease={onRelease}
          onSetReservation={onSetReservation}
          onShutdown={onShutdown}
        />
      ) : null}
    </View>
  );
}

/**
 * Host-scoped Devices section, mounted beside McpStatusStrip in the sidebar. A management
 * surface, not only a readout: it says how many simulators and emulators are running against
 * the cap, who holds each one and for how long, who is waiting, what was refused recently — and
 * lets Tyler release a lease, reserve a device for himself, or shut one down.
 *
 * Every number here came from the daemon's process scan (docs/device-leases.md), so a
 * simulator Tyler booted by hand appears with no holder rather than not appearing. Renders
 * nothing on a daemon without the cap, or when there is no device and nobody waiting.
 *
 * It also says which of the running agents the cap cannot refuse. The cap binds Claude and
 * OpenCode at the tool call, Codex and the ACP agents only when they ask, and Pi not at all —
 * a count presented as enforced when it is only enforced for some agents is the half-truth
 * that makes the whole readout untrustworthy.
 */
export function DeviceStatusStrip() {
  const { t } = useTranslation();
  const { serverId, supportsDeviceStatus, supportsDeviceManagement, model } = useDeviceStatus();
  const { releaseLease, setReservation, shutdown } = useDeviceActions(serverId);
  // Collapsed by default, like the MCP strip: chrome state, not persisted.
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);

  const handleRelease = useCallback(
    async (deviceId: string) => {
      await releaseLease(deviceId);
    },
    [releaseLease],
  );
  const handleSetReservation = useCallback(
    async (deviceId: string, reserved: boolean) => {
      await setReservation(deviceId, reserved);
    },
    [setReservation],
  );
  const handleShutdown = useCallback(
    async (deviceId: string) => {
      const confirmed = await confirmDialog({
        title: t("deviceStatus.confirmShutdown.title"),
        message: t("deviceStatus.confirmShutdown.message"),
        confirmLabel: t("deviceStatus.confirmShutdown.confirmLabel"),
        destructive: true,
      });
      if (!confirmed) return;

      const result = await shutdown({ deviceId });
      if (result.status !== "needs-confirmation") return;

      const confirmedAnyway = await confirmDialog({
        title: t("deviceStatus.confirmShutdown.midTurnTitle"),
        message: result.message ?? t("deviceStatus.confirmShutdown.midTurnMessage", { agent: "" }),
        confirmLabel: t("deviceStatus.confirmShutdown.confirmLabel"),
        destructive: true,
      });
      if (!confirmedAnyway) return;

      await shutdown({ deviceId, confirmMidTurnHolder: true });
    },
    [shutdown, t],
  );

  if (!supportsDeviceStatus || !model.hasData) {
    return null;
  }

  const summary = model.enabled
    ? t("deviceStatus.summary", { used: model.used, total: model.totalSlots })
    : t("deviceStatus.summaryCapOff", { used: model.used });

  return (
    <View style={styles.container} testID="device-status-strip">
      <Pressable
        onPress={handleToggle}
        style={styles.summaryRow}
        accessibilityRole="button"
        accessibilityLabel={t(expanded ? "deviceStatus.collapse" : "deviceStatus.expand")}
        testID="device-status-summary-toggle"
      >
        <ThemedSmartphone size={14} uniProps={foregroundMutedColorMapping} />
        <View
          testID="device-status-summary-dot"
          style={[styles.dot, toneDotStyle(model.enabled ? model.tone : "ok")]}
        />
        <Text style={styles.summaryText} numberOfLines={1}>
          {summary}
          {model.dryRun ? ` · ${t("deviceStatus.dryRun")}` : ""}
        </Text>
        {expanded ? (
          <ThemedChevronUp size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.rowList} testID="device-status-rows">
          <ModeHeader mode={model.mode} serverId={serverId} canManage={supportsDeviceManagement} />
          <Text style={styles.footnote}>{t("deviceStatus.floorNote")}</Text>
          {model.rows.map((row) => (
            <DeviceRow
              key={row.key}
              row={row}
              canManage={supportsDeviceManagement}
              onRelease={handleRelease}
              onSetReservation={handleSetReservation}
              onShutdown={handleShutdown}
            />
          ))}
          {model.waiting.length > 0 ? (
            <Text style={styles.footnote} testID="device-status-waiting">
              {t("deviceStatus.waiting", { count: model.waiting.length })}
            </Text>
          ) : null}
          {model.unleasedCount > 0 ? (
            <Text style={styles.footnote} testID="device-status-unleased">
              {t("deviceStatus.unleasedCount", { count: model.unleasedCount })}
            </Text>
          ) : null}
          {model.blocked.length > 0 ? (
            <Text style={styles.footnote} testID="device-status-blocked">
              {t("deviceStatus.blocked", { count: model.blocked.length })}
            </Text>
          ) : null}
          {model.enabled && model.unenforcedProviders.length > 0 ? (
            <Text style={styles.footnote} testID="device-status-unenforced">
              {t("deviceStatus.unenforced", {
                providers: model.unenforcedProviders.map((entry) => entry.provider).join(", "),
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing[1],
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  summaryText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowList: {
    paddingBottom: theme.spacing[1],
  },
  modeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  modeHeaderText: {
    flex: 1,
    gap: 1,
  },
  modeHeaderTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  modeHeaderDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  rowTextGroup: {
    flex: 1,
    gap: 1,
  },
  rowName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  rowStatus: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  kebabTrigger: {
    padding: theme.spacing[1],
  },
  footnote: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  dotOk: {
    backgroundColor: theme.colors.statusSuccess,
  },
  dotWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  dotDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
