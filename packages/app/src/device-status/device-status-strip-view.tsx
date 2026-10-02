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
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type {
  DeviceStatusMode,
  DeviceStatusRow,
  DeviceStatusStripModel,
  DeviceStatusTone,
  PhysicalDeviceStatusRow,
} from "./device-status-model";

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

/** The "Enforce" switch: on means the cap refuses, off means dry run. Driven by the container,
 * which owns the daemon-config round trip. */
export interface DeviceEnforceToggle {
  canToggle: boolean;
  pending: boolean;
  onValueChange: (enforce: boolean) => void;
}

function ModeHeader({
  mode,
  canManage,
  enforceToggle,
}: {
  mode: DeviceStatusMode;
  canManage: boolean;
  enforceToggle: DeviceEnforceToggle;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.modeHeader} testID="device-status-mode-header">
      <View style={styles.modeHeaderText}>
        <Text style={styles.modeHeaderTitle}>{t(`deviceStatus.mode.${mode}`)}</Text>
        <Text style={styles.modeHeaderDescription} numberOfLines={2}>
          {t(`deviceStatus.mode.${mode}Description`)}
        </Text>
      </View>
      {canManage && enforceToggle.canToggle && mode !== "off" ? (
        <View style={styles.enforceToggle}>
          <Text style={styles.modeHeaderDescription}>{t("deviceStatus.enforce")}</Text>
          <Switch
            value={mode === "enforcing"}
            onValueChange={enforceToggle.onValueChange}
            disabled={enforceToggle.pending}
            accessibilityLabel={t("deviceStatus.enforce")}
            testID="device-status-enforce-switch"
          />
        </View>
      ) : null}
    </View>
  );
}

/** The holder's title as a link that opens the agent. */
function HolderLink({
  agentId,
  label,
  text,
  onOpenAgent,
}: {
  agentId: string;
  label: string;
  text: string;
  onOpenAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpenAgent(agentId), [onOpenAgent, agentId]);
  return (
    <Text
      style={styles.holderLink}
      onPress={handlePress}
      accessibilityRole="link"
      accessibilityLabel={t("deviceStatus.openAgent", { agent: label })}
      testID={`device-status-holder-${agentId}`}
    >
      {text}
    </Text>
  );
}

/** "Held 2m · Running 3h" for a held device, "Running 3h" for one nobody holds. */
function formatDurations(
  t: (key: string, options?: Record<string, unknown>) => string,
  row: {
    holderKey?: DeviceStatusRow["holderKey"];
    heldForSeconds?: number;
    runningForSeconds?: number;
  },
  held: boolean,
): string {
  const parts: string[] = [];
  if (held && row.heldForSeconds !== undefined) {
    parts.push(t("deviceStatus.heldFor", { duration: formatHeldFor(row.heldForSeconds) }));
  }
  const running = held ? row.runningForSeconds : (row.runningForSeconds ?? row.heldForSeconds);
  if (running !== undefined) {
    parts.push(t("deviceStatus.runningFor", { duration: formatHeldFor(running) }));
  }
  return parts.map((part) => ` · ${part}`).join("");
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
  onOpenAgent,
  onRelease,
  onSetReservation,
  onShutdown,
}: {
  row: DeviceStatusRow;
  canManage: boolean;
  onOpenAgent: (agentId: string) => void;
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
  const durations = formatDurations(t, row, row.holderKey !== "unleased");
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
          {row.agentId && row.holderKey === "heldBy" ? (
            <HolderLink
              agentId={row.agentId}
              label={row.agentLabel ?? row.agentId}
              text={holder}
              onOpenAgent={onOpenAgent}
            />
          ) : (
            holder
          )}
          {durations}
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

/** No Shut down for a physical device (docs/device-leases.md) — Release and Reserve only. */
function PhysicalDeviceActionsMenu({
  row,
  onRelease,
  onSetReservation,
}: {
  row: PhysicalDeviceStatusRow;
  onRelease: (deviceId: string) => Promise<void>;
  onSetReservation: (deviceId: string, reserved: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"release" | "reserve" | null>(null);
  const reserved = row.reserved;

  const run = useCallback((key: "release" | "reserve", action: () => Promise<void>) => {
    void (async () => {
      setBusy(key);
      try {
        await action();
      } finally {
        setBusy(null);
      }
    })();
  }, []);
  const handleRelease = useCallback(() => {
    run("release", () => onRelease(row.id));
  }, [run, onRelease, row.id]);
  const handleToggleReservation = useCallback(() => {
    run("reserve", () => onSetReservation(row.id, !reserved));
  }, [run, onSetReservation, row.id, reserved]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={styles.kebabTrigger}
        testID={`device-status-physical-actions-${row.key}`}
        accessibilityLabel={t("deviceStatus.actions.menuLabel")}
      >
        {kebabIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        {row.agentId ? (
          <DropdownMenuItem
            leading={releaseLeading}
            status={busy === "release" ? "pending" : "idle"}
            onSelect={handleRelease}
            testID={`device-status-physical-release-${row.key}`}
          >
            {t("deviceStatus.actions.release")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          leading={reserved ? unreserveLeading : reserveLeading}
          status={busy === "reserve" ? "pending" : "idle"}
          onSelect={handleToggleReservation}
          testID={`device-status-physical-reserve-${row.key}`}
        >
          {t(reserved ? "deviceStatus.actions.unreserve" : "deviceStatus.actions.reserve")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PhysicalDeviceRow({
  row,
  canManage,
  onOpenAgent,
  onRelease,
  onSetReservation,
}: {
  row: PhysicalDeviceStatusRow;
  canManage: boolean;
  onOpenAgent: (agentId: string) => void;
  onRelease: (deviceId: string) => Promise<void>;
  onSetReservation: (deviceId: string, reserved: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const actionsVisible = isHovered || isNative || isCompact;
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const holder = row.agentId
    ? t("deviceStatus.heldBy", { agent: row.agentLabel ?? row.agentId })
    : t(row.reserved ? "deviceStatus.reservedForYou" : "deviceStatus.free");
  // A phone has no "running for" — only how long it has been held.
  const heldFor =
    row.agentId && row.heldForSeconds !== undefined
      ? ` · ${t("deviceStatus.heldFor", { duration: formatHeldFor(row.heldForSeconds) })}`
      : "";
  const connection = row.connected
    ? t(`deviceStatus.physical.transport.${row.transport}`)
    : t("deviceStatus.physical.disconnected", {
        duration: formatHeldFor(row.graceRemainingSeconds ?? 0),
      });

  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`device-status-physical-row-${row.key}`}
    >
      <View style={styles.rowTextGroup}>
        <Text style={styles.rowName} numberOfLines={1}>
          {t(`deviceStatus.physical.platform.${row.platform}`)}
          {row.name ? ` · ${row.name}` : ""} · {row.shortId}
          {row.reserved && row.agentId ? ` · ${t("deviceStatus.reservedForYou")}` : ""}
        </Text>
        <Text style={styles.rowStatus} numberOfLines={1}>
          {connection} ·{" "}
          {row.agentId ? (
            <HolderLink
              agentId={row.agentId}
              label={row.agentLabel ?? row.agentId}
              text={holder}
              onOpenAgent={onOpenAgent}
            />
          ) : (
            holder
          )}
          {heldFor}
        </Text>
      </View>
      {canManage && actionsVisible ? (
        <PhysicalDeviceActionsMenu
          row={row}
          onRelease={onRelease}
          onSetReservation={onSetReservation}
        />
      ) : null}
    </View>
  );
}

export interface DeviceStatusStripViewProps {
  model: DeviceStatusStripModel;
  /** The daemon supports release/reserve/shutdown (`server_info.features.deviceManagement`). */
  canManage: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  enforceToggle: DeviceEnforceToggle;
  onOpenAgent: (agentId: string) => void;
  onRelease: (deviceId: string) => Promise<void>;
  onSetReservation: (deviceId: string, reserved: boolean) => Promise<void>;
  onShutdown: (deviceId: string) => Promise<void>;
}

/**
 * The Devices section itself, from a model and callbacks — device-status-strip.tsx wires it to
 * the daemon. A management surface, not only a readout: how many simulators and emulators are
 * running against the cap, who holds each one and for how long, who is waiting, what was
 * refused recently — and Tyler can release a lease, reserve a device, or shut one down.
 *
 * It also says which of the running agents the cap cannot refuse. The cap binds Claude and
 * OpenCode at the tool call, Codex and the ACP agents only when they ask, and Pi not at all —
 * a count presented as enforced when it is only enforced for some agents is the half-truth
 * that makes the whole readout untrustworthy.
 */
export function DeviceStatusStripView({
  model,
  canManage,
  expanded,
  onToggleExpanded,
  enforceToggle,
  onOpenAgent,
  onRelease,
  onSetReservation,
  onShutdown,
}: DeviceStatusStripViewProps) {
  const { t } = useTranslation();
  const summary = model.enabled
    ? t("deviceStatus.summary", { used: model.used, total: model.totalSlots })
    : t("deviceStatus.summaryCapOff", { used: model.used });

  return (
    <View style={styles.container} testID="device-status-strip">
      <Pressable
        onPress={onToggleExpanded}
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
          <ModeHeader mode={model.mode} canManage={canManage} enforceToggle={enforceToggle} />
          <Text style={styles.footnote}>{t("deviceStatus.floorNote")}</Text>
          {model.rows.map((row) => (
            <DeviceRow
              key={row.key}
              row={row}
              canManage={canManage}
              onOpenAgent={onOpenAgent}
              onRelease={onRelease}
              onSetReservation={onSetReservation}
              onShutdown={onShutdown}
            />
          ))}
          {model.physicalRows.length > 0 ? (
            <>
              <Text style={styles.sectionHeader}>{t("deviceStatus.physical.sectionTitle")}</Text>
              {model.physicalRows.map((row) => (
                <PhysicalDeviceRow
                  key={row.key}
                  row={row}
                  canManage={canManage}
                  onOpenAgent={onOpenAgent}
                  onRelease={onRelease}
                  onSetReservation={onSetReservation}
                />
              ))}
            </>
          ) : null}
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
          {model.blockedCount > 0 ? (
            <Text style={styles.footnote} testID="device-status-blocked">
              {t(model.blockedDryRunOnly ? "deviceStatus.blockedDryRun" : "deviceStatus.blocked", {
                count: model.blockedCount,
              })}
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
  sectionHeader: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
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
  enforceToggle: {
    alignItems: "center",
    gap: 2,
  },
  holderLink: {
    color: theme.colors.foreground,
    textDecorationLine: "underline",
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
