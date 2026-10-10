import {
  deriveAgentStateBucket,
  getWorkspaceStateBucketPriority,
} from "@getpaseo/protocol/agent-state-bucket";
import type { Agent } from "@/stores/session-store";

/**
 * How urgent an agent's state is, lower first — the shared bucket ranking, not a second opinion.
 */
export function agentStatePriority(agent: Agent): number {
  return getWorkspaceStateBucketPriority(
    deriveAgentStateBucket({
      status: agent.status,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
      pendingPermissionCount: agent.pendingPermissions.length,
      tokenBurnAlert: Boolean(agent.tokenBurnAlert),
    }),
  );
}

export function compareByCreatedAt(left: Agent, right: Agent): number {
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/**
 * Root order: the most urgent state anywhere in a root's subtree, then age.
 *
 * A fleet is mostly finished work — a measured one had thirty idle and nineteen closed agents
 * against four running — and in creation order the handful that are alive end up scattered
 * through fifty that are not. Children keep creation order, so nesting still reads as the order
 * the work was handed out.
 */
export function compareOrchestrationRoots(
  left: { agent: Agent; subtreePriority: number },
  right: { agent: Agent; subtreePriority: number },
): number {
  return (
    left.subtreePriority - right.subtreePriority || compareByCreatedAt(left.agent, right.agent)
  );
}
