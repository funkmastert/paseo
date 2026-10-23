import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

export interface PaneTabActivity {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
}

/** The agent id to show in a pane's toolbar: the active tab's, when it's an agent tab. */
export function selectActivePaneAgentId(tabs: readonly PaneTabActivity[]): string | null {
  const active = tabs.find((item) => item.isActive);
  return active && active.tab.target.kind === "agent" ? active.tab.target.agentId : null;
}
