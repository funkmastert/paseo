import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { Agent } from "@/stores/session-store";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { pickPinnedWorkspaceAgentId } from "@/pinned-grid/resolve-pinned-agent";

export type BroadcastPinnedWorkspace = Pick<
  SidebarWorkspaceEntry,
  "serverId" | "workspaceId" | "name" | "currentBranch"
>;

export type BroadcastPinnedAgentCandidate = Pick<
  Agent,
  | "id"
  | "serverId"
  | "workspaceId"
  | "parentAgentId"
  | "archivedAt"
  | "lastActivityAt"
  | "createdAt"
  | "labels"
  | "status"
  | "title"
>;

export interface BroadcastPinnedTarget {
  id: string;
  serverId: string;
  workspaceId: string;
  label: string;
  agentTitle: string | null;
  status: AgentLifecycleStatus;
}

/**
 * One target per pinned workspace: exactly the agent that workspace's pinned cell shows in the
 * grid (`pickPinnedWorkspaceAgentId`, the same picker `pinned-grid/resolve-pinned-agent.ts` uses)
 * — its most-recently-active, non-archived root agent, or the live end of that conversation when
 * account failover retired the agent Tyler was looking at. Messaging anything else would reach a
 * stale leader or an agent he can no longer see.
 *
 * `label` is the workspace's own display name, via `resolveSidebarWorkspacePrimaryLabel` — the
 * same derivation the Pinned section and the pinned grid use — not the agent's title. The agent's
 * title is a conversation topic that can lag or diverge from the workspace name (a rename updates
 * the workspace, not the agent), so rows must not be labelled by it.
 */
export function selectBroadcastPinnedLeaderTargets(input: {
  pinnedChats: readonly BroadcastPinnedWorkspace[];
  agents: readonly BroadcastPinnedAgentCandidate[];
  workspaceTitleSource: WorkspaceTitleSource;
}): BroadcastPinnedTarget[] {
  const { pinnedChats, agents, workspaceTitleSource } = input;
  if (pinnedChats.length === 0 || agents.length === 0) return [];

  const agentsById = new Map<string, BroadcastPinnedAgentCandidate>();
  const agentsByServer = new Map<string, BroadcastPinnedAgentCandidate[]>();
  for (const agent of agents) {
    agentsById.set(agent.id, agent);
    const list = agentsByServer.get(agent.serverId);
    if (list) {
      list.push(agent);
    } else {
      agentsByServer.set(agent.serverId, [agent]);
    }
  }

  const targets: BroadcastPinnedTarget[] = [];
  for (const workspace of pinnedChats) {
    const serverAgents = agentsByServer.get(workspace.serverId);
    if (!serverAgents) continue;
    const liveEndId = pickPinnedWorkspaceAgentId({
      agents: serverAgents,
      workspaceId: workspace.workspaceId,
    });
    if (!liveEndId) continue;
    const agent = agentsById.get(liveEndId);
    if (!agent) continue;
    targets.push({
      id: agent.id,
      serverId: agent.serverId,
      workspaceId: workspace.workspaceId,
      label: resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource }),
      agentTitle: agent.title?.trim() || null,
      status: agent.status,
    });
  }
  return targets;
}
