import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { DeliverPromptToAgent } from "./queue/delivery.js";
import type { AgentTurnSource } from "./queue/finish-link.js";

// The two places coordination touches agents, built from the agent manager in bootstrap and
// replaced by fakes in unit tests.

export function createAgentPromptDeliverer(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): DeliverPromptToAgent {
  return async (agentId, prompt) => {
    const record = await input.agentStorage.get(agentId);
    if (!record && !input.agentManager.getAgent(agentId)) {
      throw new Error(`no agent with id ${agentId}`);
    }
    // An archived agent is not woken for queue work: the item records the failure instead, and
    // whoever reads it can hand the work to someone live.
    if (record?.archivedAt) throw new Error(`agent ${agentId} is archived`);
    await sendPromptToAgent({
      agentManager: input.agentManager,
      agentStorage: input.agentStorage,
      agentId,
      prompt,
      // Joins a running turn rather than replacing it, the same as a finish report.
      activeTurnBehavior: "steer",
      unarchive: false,
      logger: input.logger,
    });
  };
}

/** A turn ended when an agent leaves `running`. */
export function createAgentTurnSource(agentManager: AgentManager): AgentTurnSource {
  return {
    onTurnEnded(listener) {
      const lastLifecycle = new Map<string, string>();
      return agentManager.subscribe((event) => {
        if (event.type !== "agent_state") return;
        const { id, lifecycle } = event.agent;
        const previous = lastLifecycle.get(id);
        lastLifecycle.set(id, lifecycle);
        if (previous === "running" && lifecycle !== "running") listener(id);
      });
    },
    getFinalMessage: (agentId) => agentManager.getLastAssistantMessage(agentId),
  };
}
