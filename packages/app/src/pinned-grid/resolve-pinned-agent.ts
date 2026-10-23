import type { Agent } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { resolveShownAgent } from "@/utils/agent-migration";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type CandidateAgent = Pick<
  Agent,
  "id" | "workspaceId" | "parentAgentId" | "archivedAt" | "lastActivityAt" | "createdAt" | "labels"
>;

/**
 * The chat a pinned workspace shows in the grid: its most recently active root agent that is not
 * archived. A workspace can hold several agents; the grid shows one chat per pin, and the cell's
 * open action reaches the rest. A handle account failover retired stands for its live end: the
 * conversation ranks by the most recent of its handles, and the live end itself must be a
 * non-archived agent of this workspace.
 */
export function pickPinnedWorkspaceAgentId(input: {
  agents: Iterable<CandidateAgent>;
  workspaceId: string;
}): string | null {
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!workspaceId) {
    return null;
  }
  const agentsById = new Map<string, CandidateAgent>();
  for (const agent of input.agents) {
    agentsById.set(agent.id, agent);
  }
  return pickLiveEndByWorkspaceId(agentsById, workspaceId).get(workspaceId)?.id ?? null;
}

/**
 * The agent `pickPinnedWorkspaceAgentId` picks, for every workspace of one host in a single pass,
 * keyed by workspace id. The sidebar row's status and completion state read this agent, so a row
 * and the grid cell for the same workspace never show two different chats.
 */
export function pickPinnedWorkspaceAgents<T extends CandidateAgent>(
  agentsById: ReadonlyMap<string, T>,
): Map<string, T> {
  return pickLiveEndByWorkspaceId(agentsById, null);
}

/** One conversation: its live end, and the most recent of the handles that lead to it. */
interface ConversationGroup<T> {
  workspaceId: string;
  liveEnd: T;
  recency: T;
}

function pickLiveEndByWorkspaceId<T extends CandidateAgent>(
  agentsById: ReadonlyMap<string, T>,
  onlyWorkspaceId: string | null,
): Map<string, T> {
  // The workspace an agent can be shown for, or null when it is not a candidate.
  const shownWorkspaceIdOf = (agent: T | undefined): string | null => {
    if (!agent || agent.archivedAt) {
      return null;
    }
    const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    const inScope = onlyWorkspaceId === null || workspaceId === onlyWorkspaceId;
    if (!workspaceId || !inScope) {
      return null;
    }
    const parent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
    return isWorkspaceRootAgent(agent, parent) ? workspaceId : null;
  };
  const groupByLiveEndId = new Map<string, ConversationGroup<T>>();
  for (const agent of agentsById.values()) {
    const workspaceId = shownWorkspaceIdOf(agent);
    if (!workspaceId) {
      continue;
    }
    const shown = resolveShownAgent(agent.id, (agentId) => agentsById.get(agentId));
    const liveEnd = shown.kind === "moved" ? agentsById.get(shown.agentId) : agent;
    if (!liveEnd || shownWorkspaceIdOf(liveEnd) !== workspaceId) {
      continue;
    }
    const group = groupByLiveEndId.get(liveEnd.id);
    if (!group || compareRecency(agent, group.recency) > 0) {
      groupByLiveEndId.set(liveEnd.id, { workspaceId, liveEnd, recency: agent });
    }
  }
  const bestByWorkspaceId = new Map<string, ConversationGroup<T>>();
  for (const group of groupByLiveEndId.values()) {
    const best = bestByWorkspaceId.get(group.workspaceId);
    if (!best || compareRecency(group.recency, best.recency) > 0) {
      bestByWorkspaceId.set(group.workspaceId, group);
    }
  }
  const liveEndByWorkspaceId = new Map<string, T>();
  for (const [workspaceId, best] of bestByWorkspaceId) {
    liveEndByWorkspaceId.set(workspaceId, best.liveEnd);
  }
  return liveEndByWorkspaceId;
}

function compareRecency(a: CandidateAgent, b: CandidateAgent): number {
  const byActivity = a.lastActivityAt.getTime() - b.lastActivityAt.getTime();
  if (byActivity !== 0) {
    return byActivity;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}
