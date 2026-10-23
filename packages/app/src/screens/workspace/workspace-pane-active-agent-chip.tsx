import type { ReactElement } from "react";
import { AgentIdChip } from "@/components/agent-id-chip";
import {
  selectActivePaneAgentId,
  type PaneTabActivity,
} from "@/screens/workspace/workspace-pane-active-agent";

/** One chip per pane — the pane's active agent, not one per tab (see docs/pinned-grid.md). */
export function PaneActiveAgentIdChip({
  tabs,
  testID,
}: {
  tabs: readonly PaneTabActivity[];
  testID?: string;
}): ReactElement | null {
  const activeAgentId = selectActivePaneAgentId(tabs);
  if (!activeAgentId) {
    return null;
  }
  return <AgentIdChip agentId={activeAgentId} testID={testID} />;
}
