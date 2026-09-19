import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Copy, ExternalLink, KeyRound, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderUsageTone } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";
import * as Clipboard from "expo-clipboard";
import { useToast } from "@/contexts/toast-context";
import { useMcpStatus } from "./use-mcp-status";
import { failureClipboardText, failureText, remedyLines, reportedByText } from "./mcp-status-copy";
import type {
  McpStatusActionFailure,
  McpStatusRow,
  McpStatusRowStatusKey,
} from "./mcp-status-strip-model";

const ThemedServer = withUnistyles(Server);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedKeyRound = withUnistyles(KeyRound);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedCopy = withUnistyles(Copy);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accent });

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

function actionLabelKeyFor(row: McpStatusRow): string {
  switch (row.action) {
    case "adopt":
      return "mcpStatus.adoptAction";
    case "openClaudeAi":
      return "mcpStatus.openClaudeAiAction";
    default:
      return row.statusKey === "error" ? "mcpStatus.reauthAction" : "mcpStatus.authAction";
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
  onAction,
  actionDisabled,
}: {
  row: McpStatusRow;
  onAction: (row: McpStatusRow) => void;
  actionDisabled: boolean;
}) {
  const { t } = useTranslation();
  const handleActionPress = useCallback(() => onAction(row), [onAction, row]);
  const reporters = reportedByText(t, row);

  return (
    <View testID={`mcp-status-row-${row.name}`}>
      <View style={styles.row}>
        <StatusDot tone={row.tone} testID={`mcp-status-dot-${row.name}`} />
        <View style={styles.rowTextGroup}>
          <Text style={styles.rowName} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.rowStatus} numberOfLines={1}>
            {t(statusLabelKeyFor(row.statusKey))}
            {reporters ? ` · ${reporters}` : ""}
          </Text>
        </View>
        {row.action ? (
          <Pressable
            onPress={handleActionPress}
            disabled={actionDisabled}
            accessibilityRole="button"
            accessibilityLabel={t(actionLabelKeyFor(row))}
            style={styles.authButton}
            testID={`mcp-status-auth-${row.name}`}
          >
            {row.action === "openClaudeAi" ? (
              <ThemedExternalLink size={14} uniProps={accentColorMapping} />
            ) : (
              <ThemedKeyRound size={14} uniProps={accentColorMapping} />
            )}
            <Text style={styles.authButtonLabel}>{t(actionLabelKeyFor(row))}</Text>
          </Pressable>
        ) : null}
      </View>
      {row.failure ? <McpStatusRowFailure row={row} failure={row.failure} /> : null}
    </View>
  );
}

/**
 * A failure under its row. The message is clamped to two lines and opens on tap: several of
 * these carry instructions — a redirect URI to register, a file to edit, JSON to paste — and a
 * clamp turns instructions into a teaser. Copy takes the whole thing, because nobody retypes a
 * callback URL from a sidebar.
 */
function McpStatusRowFailure({
  row,
  failure,
}: {
  row: McpStatusRow;
  failure: McpStatusActionFailure;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const lines = remedyLines(t, row, failure);

  const handleToggle = useCallback(() => setExpanded((previous) => !previous), []);
  const handleCopy = useCallback(() => {
    void (async () => {
      try {
        await Clipboard.setStringAsync(failureClipboardText(t, row, failure));
        toast.copied(t("mcpStatus.copiedError"));
      } catch {
        toast.error(t("mcpStatus.copyError"));
      }
    })();
  }, [failure, row, t, toast]);

  return (
    <View style={styles.failureBlock}>
      <View style={styles.failureHeader}>
        <Pressable
          onPress={handleToggle}
          accessibilityRole="button"
          accessibilityLabel={t(expanded ? "mcpStatus.showLessError" : "mcpStatus.showFullError")}
          style={styles.failureTextPressable}
          testID={`mcp-status-auth-error-${row.name}`}
        >
          <Text style={styles.authErrorText} numberOfLines={expanded ? undefined : 2}>
            {failureText(t, row, failure)}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={t("mcpStatus.copyError")}
          style={styles.failureCopyButton}
          testID={`mcp-status-copy-error-${row.name}`}
        >
          <ThemedCopy size={13} uniProps={foregroundMutedColorMapping} />
        </Pressable>
      </View>
      {expanded
        ? lines.map((line) => (
            <View key={line.key} style={styles.remedyLine}>
              <Text style={styles.remedyLabel}>{line.label}</Text>
              <Text
                style={styles.remedyValue}
                selectable
                testID={`mcp-status-remedy-${line.key}-${row.name}`}
              >
                {line.value}
              </Text>
            </View>
          ))
        : null}
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
  const {
    supportsMcpStatus,
    model,
    startAuth,
    adoptServer,
    openClaudeAiConnectors,
    isStartingAuth,
  } = useMcpStatus();
  // Always starts collapsed — this is UI chrome state, not persisted, per KTD10.
  const [expanded, setExpanded] = useState(false);

  const handleToggle = useCallback(() => setExpanded((prev) => !prev), []);
  const handleAction = useCallback(
    (row: McpStatusRow) => {
      void (async () => {
        try {
          if (row.action === "openClaudeAi") {
            await openClaudeAiConnectors();
            return;
          }
          // Both resolve with the daemon's answer and record it onto the row themselves.
          if (row.action === "adopt" && row.annotation) {
            await adoptServer(row.name, row.annotation.agentId);
            return;
          }
          await startAuth(row.name);
        } catch {
          // The mutation's error/`isPending` state already reflects the failure; the strip
          // stays interactive and the next mcp_status_update push repaints the real state.
        }
      })();
    },
    [adoptServer, openClaudeAiConnectors, startAuth],
  );

  if (!supportsMcpStatus || !model.hasData) {
    return null;
  }

  // issueNames falls back from unhealthy critical servers to every unhealthy row, so the
  // collapsed text never claims "connected" above rows that aren't.
  const summaryText =
    model.collapsed.issueNames.length > 0
      ? t("mcpStatus.collapsedSummary.issues", { names: model.collapsed.issueNames.join(", ") })
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
        <ThemedServer size={14} uniProps={foregroundMutedColorMapping} />
        <StatusDot tone={model.collapsed.tone} testID="mcp-status-summary-dot" />
        <Text style={styles.summaryText} numberOfLines={1}>
          {summaryText}
        </Text>
        {expanded ? (
          <ThemedChevronUp size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.rowList} testID="mcp-status-rows">
          {model.rows.map((row) => (
            <McpStatusRowView
              key={row.key}
              row={row}
              onAction={handleAction}
              actionDisabled={isStartingAuth}
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
  authErrorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  failureBlock: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[1],
  },
  failureHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
  failureTextPressable: {
    flex: 1,
  },
  failureCopyButton: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
  },
  remedyLine: {
    gap: 1,
  },
  remedyLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  remedyValue: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
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
