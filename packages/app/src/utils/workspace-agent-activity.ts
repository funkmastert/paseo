import {
  getCompletionNoteFromLabels,
  getCompletionStateFromLabels,
  type CompletionState,
} from "@getpaseo/protocol/agent-labels";
import { pickPinnedWorkspaceAgents } from "@/pinned-grid/resolve-pinned-agent";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  completionState: CompletionState | null;
  completionNote: string | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();

  // The agent the pinned grid's cell shows for the workspace, so a handle account failover
  // retired never lends the row its status or its completion labels.
  for (const [workspaceId, agent] of pickPinnedWorkspaceAgents(agents)) {
    activityByWorkspaceId.set(workspaceId, {
      agentId: agent.id,
      status: deriveSidebarStateBucket({
        status: workspaceAgentStatus(agent),
        pendingPermissionCount: agent.pendingPermissions.length,
        requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason,
        tokenBurnAlert: agent.tokenBurnAlert !== undefined,
      }),
      enteredAt: agent.attentionTimestamp ?? agent.updatedAt,
      completionState: getCompletionStateFromLabels(agent.labels),
      completionNote: getCompletionNoteFromLabels(agent.labels),
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status &&
      previousActivity.completionState === activity.completionState &&
      previousActivity.completionNote === activity.completionNote
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
