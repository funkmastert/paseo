/**
 * The idle leg of account failover: roots sitting between turns on an account that ran out. Pure;
 * the monitor passes this sweep's dead accounts in and performs the moves. See
 * docs/account-failover.md.
 *
 * The rescue leg only sees an agent once a turn has failed on the cap. That left Tyler's root
 * sessions on an exhausted account with nothing to say they were stuck until he wrote to one and
 * watched it fail (2026-09-24, while the leader account had nearly all its budget). An idle
 * root is moved as soon as its account is known to be out, and it is never prompted: it has nothing
 * to resume, and the next message Tyler sends it runs on an account that can answer.
 */
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AccountFailoverAgentSummary } from "./agent-manager.js";
import { getMigratedToFromLabels, isLimitShapedError } from "./account-failover-detector.js";

export interface PlanIdleRehomesInput {
  agents: readonly AccountFailoverAgentSummary[];
  poolProviderIds: ReadonlySet<string>;
  /** This sweep's dead accounts, from planAccountFailoverSweep. */
  deadProviderIds: ReadonlySet<string>;
  /** Per-agent earliest next attempt after a refused move. */
  backoffs: ReadonlyMap<string, number>;
  nowMs: number;
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
    // An agent in error is the rescue leg's: it moves and resumes it.
    if (agent.lifecycle !== "idle") return false;
    if (agent.busy || agent.pendingPermissionCount > 0) return false;
    if (!agent.sessionId) return false;
    // A child answers its leader, not Tyler: it stays until something asks it to work, fails on
    // the cap, and is rescued then.
    if (getParentAgentIdFromLabels(agent.labels) !== null) return false;
    const until = input.backoffs.get(agent.id);
    return !(typeof until === "number" && input.nowMs < until);
  });
}
