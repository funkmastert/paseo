import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { useToast } from "@/contexts/toast-context";
import { useMcpStatus } from "./use-mcp-status";
import { failureClipboardText } from "./mcp-status-copy";
import type { McpStatusActionFailure, McpStatusRow } from "./mcp-status-strip-model";
import { McpStatusStripView } from "./mcp-status-strip-view";

/**
 * Persistent, host-scoped MCP status strip (KTD10): wires McpStatusStripView to the daemon, the
 * per-host hidden list, and the clipboard. Mounted once in the desktop sidebar beside
 * `SidebarCalloutSlot` and once in `MobileSidebar`'s footer region. Renders nothing on an old
 * daemon (no `mcpStatus` feature) or when there is truly nothing to show — no brokered servers
 * and no session-reported failures.
 */
export function McpStatusStrip() {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    supportsMcpStatus,
    model,
    startAuth,
    adoptServer,
    openClaudeAiConnectors,
    isStartingAuth,
    hideServer,
    unhideServer,
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
  const handleCopyFailure = useCallback(
    (row: McpStatusRow, failure: McpStatusActionFailure) => {
      void (async () => {
        try {
          await Clipboard.setStringAsync(failureClipboardText(t, row, failure));
          toast.copied(t("mcpStatus.copiedError"));
        } catch {
          toast.error(t("mcpStatus.copyError"));
        }
      })();
    },
    [t, toast],
  );

  if (!supportsMcpStatus || !model.hasData) {
    return null;
  }

  return (
    <McpStatusStripView
      model={model}
      expanded={expanded}
      onToggleExpanded={handleToggle}
      actionDisabled={isStartingAuth}
      onAction={handleAction}
      onHide={hideServer}
      onUnhide={unhideServer}
      onCopyFailure={handleCopyFailure}
    />
  );
}
