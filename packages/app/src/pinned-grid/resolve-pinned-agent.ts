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
 * open action reaches the rest. A handle account failover retired shows as its live end.
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
  let best: CandidateAgent | null = null;
  for (const agent of agentsById.values()) {
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) !== workspaceId || agent.archivedAt) {
      continue;
    }
    const parent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
    if (!isWorkspaceRootAgent(agent, parent)) {
      continue;
    }
    if (!best || compareRecency(agent, best) > 0) {
      best = agent;
    }
  }
  if (!best) {
    return null;
  }
  const shown = resolveShownAgent(best.id, (agentId) => agentsById.get(agentId));
  return shown.kind === "moved" ? shown.agentId : best.id;
}

function compareRecency(a: CandidateAgent, b: CandidateAgent): number {
  const byActivity = a.lastActivityAt.getTime() - b.lastActivityAt.getTime();
  if (byActivity !== 0) {
    return byActivity;
  }
  return a.createdAt.getTime() - b.createdAt.getTime();
}
