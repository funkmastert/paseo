import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import { searchAgentTranscript } from "../../agent/transcript-search/index.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

export interface TranscriptSearchSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: pino.Logger;
}

type TranscriptSearchRequest = Extract<
  SessionInboundMessage,
  { type: "agent.transcript_search.search.request" }
>;

/** Session controller for `agent.transcript_search.search`. See docs/agent-lifecycle.md. */
export class TranscriptSearchSession {
  constructor(private readonly options: TranscriptSearchSessionOptions) {}

  async handleSearchRequest(request: TranscriptSearchRequest): Promise<void> {
    const { host, agentManager, agentStorage, logger } = this.options;
    try {
      const result = await searchAgentTranscript({
        agentManager,
        agentStorage,
        rootAgentId: request.agentId,
        pattern: request.pattern,
        tree: request.tree,
        regex: request.regex,
        caseInsensitive: request.caseInsensitive,
        full: request.full,
      });
      host.emit({
        type: "agent.transcript_search.search.response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          backend: result.backend,
          agents: result.agents,
          targetSetTruncated: result.targetSetTruncated,
          error: null,
        },
      });
    } catch (error) {
      logger.warn({ err: error, agentId: request.agentId }, "Transcript search failed");
      host.emit({
        type: "agent.transcript_search.search.response",
        payload: {
          requestId: request.requestId,
          agentId: request.agentId,
          backend: null,
          agents: [],
          targetSetTruncated: false,
          error: getErrorMessage(error),
        },
      });
    }
  }
}
