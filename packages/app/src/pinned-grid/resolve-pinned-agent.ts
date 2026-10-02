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
  const isCandidate = (agent: CandidateAgent | undefined): agent is CandidateAgent => {
    if (
      !agent ||
      agent.archivedAt ||
      normalizeWorkspaceOpaqueId(agent.workspaceId) !== workspaceId
    ) {
      return false;
    }
    const parent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
    return isWorkspaceRootAgent(agent, parent);
  };
  // Keyed by live end; the value is the group's most recent member.
  const recencyByLiveEnd = new Map<string, CandidateAgent>();
  for (const agent of agentsById.values()) {
    if (!isCandidate(agent)) {
      continue;
    }
    const shown = resolveShownAgent(agent.id, (agentId) => agentsById.get(agentId));
    const liveEndId = shown.kind === "moved" ? shown.agentId : agent.id;
    if (!isCandidate(agentsById.get(liveEndId))) {
      continue;
    }
    const current = recencyByLiveEnd.get(liveEndId);
    if (!current || compareRecency(agent, current) > 0) {
      recencyByLiveEnd.set(liveEndId, agent);
    }
  }
  let best: { liveEndId: string; recency: CandidateAgent } | null = null;
  for (const [liveEndId, recency] of recencyByLiveEnd) {
    if (!best || compareRecency(recency, best.recency) > 0) {
      best = { liveEndId, recency };
    }
  }
  return best?.liveEndId ?? null;
}

function compareRecency(a: CandidateAgent, b: CandidateAgent): number {
  const byActivity = a.lastActivityAt.getTime() - b.lastActivityAt.getTime();
  if (byActivity !== 0) {
    return byActivity;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}
