import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, KeyRound, Server } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderUsageTone } from "@getpaseo/protocol/messages";
import { useMcpStatus } from "./use-mcp-status";
import type { McpStatusRow, McpStatusRowStatusKey } from "./mcp-status-strip-model";

function toneDotStyle(tone: ProviderUsageTone) {
  switch (tone) {
    case "ok":
      return styles.dotOk;
    case "warning":
      return styles.dotWarning;
    case "danger":
      return styles.dotDanger;
    default:
      return styles.dotDefault;
  }
}

function statusLabelKeyFor(statusKey: McpStatusRowStatusKey): string {
  switch (statusKey) {
    case "needsAuth":
      return "mcpStatus.status.needsAuth";
    case "sessionReported":
      return "mcpStatus.status.sessionReported";
    default:
      return `mcpStatus.status.${statusKey}`;
  }
}

function StatusDot({ tone, testID }: { tone: ProviderUsageTone; testID?: string }) {
  return <View testID={testID} style={[styles.dot, toneDotStyle(tone)]} />;
}

function McpStatusRowView({
  row,
  onAuth,
  authDisabled,
}: {
  row: McpStatusRow;
  onAuth: (name: string) => void;
  authDisabled: boolean;
}) {
  const { t } = useTranslation();
  const handleAuthPress = useCallback(() => onAuth(row.name), [onAuth, row.name]);

  return (
    <View style={styles.row} testID={`mcp-status-row-${row.name}`}>
      <StatusDot tone={row.tone} testID={`mcp-status-dot-${row.name}`} />
      <View style={styles.rowTextGroup}>
        <Text style={styles.rowName} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={styles.rowStatus} numberOfLines={1}>
          {t(statusLabelKeyFor(row.statusKey))}
          {row.annotation
            ? ` · ${t("mcpStatus.reportedBy", { agent: row.annotation.agentLabel })}`
            : ""}
        </Text>
      </View>
      {row.canAuth ? (
        <Pressable
          onPress={handleAuthPress}
          disabled={authDisabled}
          accessibilityRole="button"
          accessibilityLabel={t(
            row.statusKey === "error" ? "mcpStatus.reauthAction" : "mcpStatus.authAction",
          )}
          style={styles.authButton}
          testID={`mcp-status-auth-${row.name}`}
        >
          <KeyRound size={14} color={styles.authIconColor.color} />
          <Text style={styles.authButtonLabel}>
            {t(row.statusKey === "error" ? "mcpStatus.reauthAction" : "mcpStatus.authAction")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Persistent, host-scoped MCP status strip (KTD10). Mounted once in the desktop sidebar beside
 * `SidebarCalloutSlot` and once in `MobileSidebar`'s footer region. Renders nothing on an old
 * daemon (no `mcpStatus` feature) or when there is truly nothing to show — no brokered servers
 * and no session-reported failures.
 */
export function McpStatusStrip() {
  const { t } = useTranslation();
  const { supportsMcpStatus, model, startAuth, isStartingAuth } = useMcpStatus();
  // Always starts collapsed — this is UI chrome state, not persisted, per KTD10.
  const [expanded, setExpanded] = useState(false);

  const handleToggle = useCallback(() => setExpanded((prev) => !prev), []);
  const handleAuth = useCallback(
    (name: string) => {
      void startAuth(name).catch(() => {
        // The mutation's error/`isPending` state already reflects the failure; the strip
        // stays interactive and the next mcp_status_update push repaints the real state.
      });
    },
    [startAuth],
  );

  if (!supportsMcpStatus || !model.hasData) {
    return null;
  }

  const summaryText =
    model.collapsed.unhealthyCriticalNames.length > 0
      ? t("mcpStatus.collapsedSummary.issues", {
          names: model.collapsed.unhealthyCriticalNames.join(", "),
        })
      : t("mcpStatus.collapsedSummary.healthy");

  return (
    <View style={styles.container} testID="mcp-status-strip">
      <Pressable
        onPress={handleToggle}
        style={styles.summaryRow}
        accessibilityRole="button"
        accessibilityLabel={t(expanded ? "mcpStatus.collapse" : "mcpStatus.expand")}
        testID="mcp-status-summary-toggle"
      >
        <Server size={14} color={styles.summaryIconColor.color} />
        <StatusDot tone={model.collapsed.tone} testID="mcp-status-summary-dot" />
        <Text style={styles.summaryText} numberOfLines={1}>
          {summaryText}
        </Text>
        {expanded ? (
          <ChevronUp size={14} color={styles.chevronColor.color} />
        ) : (
          <ChevronDown size={14} color={styles.chevronColor.color} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.rowList} testID="mcp-status-rows">
          {model.rows.map((row) => (
            <McpStatusRowView
              key={row.key}
              row={row}
              onAuth={handleAuth}
              authDisabled={isStartingAuth}
            />
          ))}
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
  summaryIconColor: {
    color: theme.colors.foregroundMuted,
  },
  chevronColor: {
    color: theme.colors.foregroundMuted,
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
  authButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  authIconColor: {
    color: theme.colors.accent,
  },
  authButtonLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
    fontWeight: theme.fontWeight.medium,
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
  dotDefault: {
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
