/**
 * Whether a workspace is agent-made and unpinned, the one rule every workspace-browsing list
 * (the sidebar, the command palette) applies to decide what Tyler never has to see. A pin is an
 * explicit signal that overrides it, so a manually pinned agent workspace is never hidden
 * (docs/done-janitor.md#manual-pin-vs-auto-pin).
 */
export function isHiddenAgentWorkspace(workspace: {
  createdBy?: "person" | "agent";
  pinnedAt?: string | null;
}): boolean {
  return workspace.createdBy === "agent" && !workspace.pinnedAt;
}
