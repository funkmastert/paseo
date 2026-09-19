import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Smartphone } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useDeviceStatus } from "./use-device-status";
import type { DeviceStatusRow, DeviceStatusTone } from "./device-status-model";

const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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

/** Short and glanceable: a device held for 2h14m reads "2h14m", not "2 hours 14 minutes". */
function formatHeldFor(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function DeviceRow({ row }: { row: DeviceStatusRow }) {
  const { t } = useTranslation();
  const holder =
    row.holderKey === "heldBy"
      ? t("deviceStatus.heldBy", { agent: row.agentLabel ?? row.agentId })
      : t(`deviceStatus.${row.holderKey}`);
  const heldFor = row.heldForSeconds === undefined ? "" : ` · ${formatHeldFor(row.heldForSeconds)}`;
  // Said on the row itself, not only in a footnote: this is the device the cap could not have
  // stopped, and which device that is matters as much as how many there are.
  const enforcement =
    row.enforcement && row.enforcement !== "refuses"
      ? ` · ${t(`deviceStatus.enforcement.${row.enforcement}`)}`
      : "";

  return (
    <View style={styles.row} testID={`device-status-row-${row.key}`}>
      <View style={styles.rowTextGroup}>
        <Text style={styles.rowName} numberOfLines={1}>
          {t(`deviceStatus.platform.${row.platform}`)}
          {row.label ? ` · ${row.label}` : ""}
        </Text>
        <Text style={styles.rowStatus} numberOfLines={1}>
          {holder}
          {heldFor}
          {enforcement}
          {row.reason ? ` · ${row.reason}` : ""}
        </Text>
      </View>
    </View>
  );
}

/**
 * Host-scoped device-cap readout, mounted beside McpStatusStrip in the sidebar. A status
 * readout, not a control panel: it says how many simulators and emulators are running against
 * the cap, who holds each one and for how long, and who is waiting.
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
  const { supportsDeviceStatus, model } = useDeviceStatus();
  // Collapsed by default, like the MCP strip: chrome state, not persisted.
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);

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
          {model.rows.map((row) => (
            <DeviceRow key={row.key} row={row} />
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
