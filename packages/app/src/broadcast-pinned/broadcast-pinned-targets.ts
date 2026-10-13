import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { Agent } from "@/stores/session-store";
import { pickPinnedWorkspaceAgentId } from "@/pinned-grid/resolve-pinned-agent";

export interface BroadcastPinnedWorkspace {
  serverId: string;
  workspaceId: string;
  name: string;
}

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
  workspaceName: string;
  label: string;
  status: AgentLifecycleStatus;
}

/**
 * One target per pinned workspace: exactly the agent that workspace's pinned cell shows in the
 * grid (`pickPinnedWorkspaceAgentId`, the same picker `pinned-grid/resolve-pinned-agent.ts` uses)
 * — its most-recently-active, non-archived root agent, or the live end of that conversation when
 * account failover retired the agent Tyler was looking at. Messaging anything else would reach a
 * stale leader or an agent he can no longer see.
 */
export function selectBroadcastPinnedLeaderTargets(input: {
  pinnedChats: readonly BroadcastPinnedWorkspace[];
  agents: readonly BroadcastPinnedAgentCandidate[];
}): BroadcastPinnedTarget[] {
  const { pinnedChats, agents } = input;
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
      workspaceName: workspace.name,
      label: agent.title?.trim() || "Untitled agent",
      status: agent.status,
    });
  }
  return targets;
}
