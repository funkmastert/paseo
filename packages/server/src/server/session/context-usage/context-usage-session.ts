import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AgentContextUsageService } from "../../context-usage/agent-context-usage-service.js";

interface ContextUsageSessionLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface ContextUsageSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  service: AgentContextUsageService;
  /** Loads a stored, unarchived agent so a panel opened on a closed agent can still be read. */
  loadAgent: (agentId: string) => Promise<void>;
  logger: ContextUsageSessionLogger;
}

/** Serves `agent.context_usage.read` from the daemon-wide AgentContextUsageService. */
export class ContextUsageSession {
  private readonly options: ContextUsageSessionOptions;

  constructor(options: ContextUsageSessionOptions) {
    this.options = options;
  }

  async handleReadRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.context_usage.read.request" }>,
  ): Promise<void> {
    const { host, service, loadAgent, logger } = this.options;
    const respond = (payload: {
      status: string;
      usage: Awaited<ReturnType<AgentContextUsageService["read"]>>["usage"];
      error: string | null;
    }) =>
      host.emit({
        type: "agent.context_usage.read.response",
        payload: { requestId: msg.requestId, agentId: msg.agentId, ...payload },
      });
    try {
      await loadAgent(msg.agentId);
      respond(await service.read(msg.agentId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error, agentId: msg.agentId }, "Failed to read agent context usage");
      respond({ status: "error", usage: null, error: message });
    }
  }
}

/** Null when the host did not give the session a service (only a test does), so callers stay flat. */
export function createContextUsageSession(
  options: Omit<ContextUsageSessionOptions, "service"> & {
    service: AgentContextUsageService | undefined;
  },
): ContextUsageSession | null {
  const { service, ...rest } = options;
  return service ? new ContextUsageSession({ ...rest, service }) : null;
}
