import type { AgentManager } from "../../agent/agent-manager.js";
import { readRefocusBrief } from "../../agent/agent-refocus.js";
import type { JevSavingsSink } from "../contract.js";
import type { ReadCheckAgentSource } from "./observer.js";

/** The first rows hold the assignment: the agent's first message. */
const ASSIGNMENT_HEAD_ROWS = 40;

/**
 * What the read check reads about an agent, from the daemon's own records. Takes a getter because
 * the observer is built before the agent manager it reads; no hook fires before both exist.
 */
export function createReadCheckAgentSource(
  getAgentManager: () => Pick<AgentManager, "getAgent" | "fetchTimeline">,
): ReadCheckAgentSource {
  return {
    agent(agentId) {
      const agent = getAgentManager().getAgent(agentId);
      if (!agent) return null;
      return {
        title: agent.config.title ?? null,
        cwd: agent.cwd,
        model: agent.config.model ?? null,
        workspaceId: agent.workspaceId ?? null,
        labels: agent.labels,
        contextTokens: agent.lastUsage?.contextWindowUsedTokens ?? null,
      };
    },
    assignment(agentId) {
      const head = getAgentManager().fetchTimeline(agentId, {
        direction: "after",
        limit: ASSIGNMENT_HEAD_ROWS,
      });
      return readRefocusBrief(head.rows.map((row) => row.item)).assignment;
    },
    tail(agentId, limit) {
      const page = getAgentManager().fetchTimeline(agentId, { direction: "tail", limit });
      return { epoch: page.epoch, rows: page.rows };
    },
    after(agentId, cursor, limit) {
      const page = getAgentManager().fetchTimeline(agentId, { direction: "after", cursor, limit });
      return { epoch: page.epoch, rows: page.rows };
    },
  };
}

/** Drops every line. The read check's sink until the savings seam provides `jev.savings`. */
export const DROPPED_JEV_SAVINGS: JevSavingsSink = {
  record: () => "",
  settle: () => undefined,
  validate: () => undefined,
  countNotAsked: () => undefined,
  noteRead: () => undefined,
};
