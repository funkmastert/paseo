import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronUp, ExternalLink, KeyRound, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderUsageTone } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";
import { useMcpStatus } from "./use-mcp-status";
import type {
  McpStatusRow,
  McpStatusRowAnnotation,
  McpStatusRowStatusKey,
} from "./mcp-status-strip-model";

const ThemedServer = withUnistyles(Server);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedKeyRound = withUnistyles(KeyRound);
const ThemedExternalLink = withUnistyles(ExternalLink);

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

function reportedByText(t: TFunction, annotation: McpStatusRowAnnotation): string {
  return annotation.reporterCount > 1
    ? t("mcpStatus.reportedByCount", { count: annotation.reporterCount })
    : t("mcpStatus.reportedBy", { agent: annotation.agentLabel });
}

function StatusDot({ tone, testID }: { tone: ProviderUsageTone; testID?: string }) {
  return <View testID={testID} style={[styles.dot, toneDotStyle(tone)]} />;
}

function McpStatusRowView({
  row,
  onAction,
  actionDisabled,
  authError,
}: {
  row: McpStatusRow;
  onAction: (row: McpStatusRow) => void;
  actionDisabled: boolean;
  /** Last resolved auth error for this row (U8 slice), already cleared once the row's own
   * status has moved on from the status it was recorded against. */
  authError?: string;
}) {
  const { t } = useTranslation();
  const handleActionPress = useCallback(() => onAction(row), [onAction, row]);

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
            {row.annotation ? ` · ${reportedByText(t, row.annotation)}` : ""}
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
      {authError ? (
        <Text
          style={styles.authErrorText}
          numberOfLines={2}
          testID={`mcp-status-auth-error-${row.name}`}
        >
          {t("mcpStatus.authError", { error: authError })}
        </Text>
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
  // Per-row "last auth error" (P2 slice of #8): the daemon's `mcp_gateway.auth.start` RPC
  // resolves rather than throws for known failures (static-auth server, unknown server,
  // gateway error), so the strip has to surface `result.error` itself — the mutation's own
  // rejection path never fires for those cases.
  const [authErrors, setAuthErrors] = useState<Record<string, string>>({});
  const rowStatusByNameRef = useRef<Record<string, McpStatusRowStatusKey>>({});

  // Clear a row's stored error once that row's own status has moved on — a fresh
  // mcp_status_update push means the daemon's view of the server changed independently of
  // whether the user retried, so a stale error should not linger under a new status.
  useEffect(() => {
    const previousStatusByName = rowStatusByNameRef.current;
    const nextStatusByName: Record<string, McpStatusRowStatusKey> = {};
    const namesWithChangedStatus: string[] = [];
    for (const row of model.rows) {
      nextStatusByName[row.name] = row.statusKey;
      if (
        previousStatusByName[row.name] !== undefined &&
        previousStatusByName[row.name] !== row.statusKey
      ) {
        namesWithChangedStatus.push(row.name);
      }
    }
    rowStatusByNameRef.current = nextStatusByName;

    if (namesWithChangedStatus.length === 0) return;
    setAuthErrors((prev) => {
      let next: Record<string, string> | undefined;
      for (const name of namesWithChangedStatus) {
        if (name in prev) {
          next ??= { ...prev };
          delete next[name];
        }
      }
      return next ?? prev;
    });
  }, [model.rows]);

  const handleToggle = useCallback(() => setExpanded((prev) => !prev), []);
  const handleAction = useCallback(
    (row: McpStatusRow) => {
      const name = row.name;
      // Clear any stale error for this row as soon as a new attempt starts.
      setAuthErrors((prev) => {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      void (async () => {
        try {
          if (row.action === "openClaudeAi") {
            await openClaudeAiConnectors();
            return;
          }
          const result =
            row.action === "adopt" && row.annotation
              ? await adoptServer(name, row.annotation.agentId)
              : await startAuth(name);
          if (result.error && !result.authorizationUrl) {
            const error = result.error;
            setAuthErrors((prev) => ({ ...prev, [name]: error }));
          }
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
              authError={authErrors[row.name]}
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
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
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
