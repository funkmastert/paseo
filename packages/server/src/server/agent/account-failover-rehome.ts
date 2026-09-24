/**
 * The idle leg of account failover: agents sitting between turns on an account that ran out. Pure;
 * the monitor passes this sweep's dead accounts in and performs the moves. See
 * docs/account-failover.md.
 *
 * The rescue leg only sees an agent once a turn has failed on the cap. That left Tyler's root
 * sessions on an exhausted account with nothing to say they were stuck until he wrote to one and
 * watched it fail (2026-09-24, while the leader account had nearly all its budget). An idle agent
 * is moved as soon as its account is known to be out, and it is never prompted: it has nothing to
 * resume, and the next message anyone sends it runs on an account that can answer.
 */
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import { getMigratedToFromLabels, isLimitShapedError } from "./account-failover-detector.js";

/** Between turns. `error` counts: a turn that ended on something other than the cap is over. */
const SETTLED_LIFECYCLES: ReadonlySet<AgentLifecycleStatus> = new Set(["idle", "error"]);

export interface PlanIdleRehomesInput {
  agents: readonly AccountFailoverAgentSummary[];
  poolProviderIds: ReadonlySet<string>;
  /** This sweep's dead accounts, from planAccountFailoverSweep. */
  deadProviderIds: ReadonlySet<string>;
  /** Per-agent earliest next attempt after a refused move. */
  backoffs: ReadonlyMap<string, number>;
  nowMs: number;
  migrateSubagents: boolean;
}

export function planIdleRehomes(input: PlanIdleRehomesInput): AccountFailoverAgentSummary[] {
  return input.agents.filter((agent) => {
    if (agent.internal) return false;
    if (!input.poolProviderIds.has(agent.provider)) return false;
    if (!input.deadProviderIds.has(agent.provider)) return false;
    if (getMigratedToFromLabels(agent.labels)) return false;
    // Cut off by the cap: the rescue leg moves it and resumes the turn it lost.
    if (isLimitShapedError(agent.lastError)) return false;
    // Mid-turn: the daemon refuses the move. A turn that is dead rather than slow is cancelled by
    // the stalled-agent sweep with a limit-shaped error, and the rescue leg picks it up from there.
    if (!SETTLED_LIFECYCLES.has(agent.lifecycle)) return false;
    if (agent.busy || agent.pendingPermissionCount > 0) return false;
    if (!agent.sessionId) return false;
    if (!input.migrateSubagents && getParentAgentIdFromLabels(agent.labels) !== null) return false;
    const until = input.backoffs.get(agent.id);
    return !(typeof until === "number" && input.nowMs < until);
  });
}
