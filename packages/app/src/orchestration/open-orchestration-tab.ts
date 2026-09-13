import type { OpenInSidePanePreferences } from "@/hooks/use-settings";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

export interface OpenOrchestrationTabInput {
  isCompact: boolean;
  /** Whether the platform supports desktop pane splits — see `supportsDesktopPaneSplits()`. */
  canSplit: boolean;
  workspaceKey: string | null;
  preferences: OpenInSidePanePreferences;
  parentTabId?: string | null;
  /** Plain reveal fallback when splitting isn't available — mirrors agent-tracks.tsx's provider-subagent path. */
  openTab: (target: WorkspaceTabTarget) => void;
}

/**
 * Opens the orchestration tab, shared by both entry points (the composer track-bar pill and the
 * Command Center action) so they route through one place. Reuses the `subagents` open-location
 * preference bucket rather than adding a new settings entry — per KTD4, the orchestration tab is
 * conceptually the same class of open as revealing a subagent.
 */
export function openOrchestrationTab(input: OpenOrchestrationTabInput): void {
  if (input.canSplit && input.workspaceKey) {
    openPreferredWorkspaceTarget({
      isCompact: input.isCompact,
      workspaceKey: input.workspaceKey,
      target: { kind: "orchestration" },
      source: "subagents",
      preferences: input.preferences,
      parentTabId: input.parentTabId,
    });
    return;
  }
  input.openTab({ kind: "orchestration" });
}
