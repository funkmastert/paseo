import { randomUUID } from "node:crypto";

import type {
  AgentClient,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

export interface ScriptedTurn {
  /** The context size the provider reports once this turn has run. */
  contextTokens?: number;
  compacts?: boolean;
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/**
 * Provider session that echoes each prompt into the timeline, reports the context size the test
 * scripted for that turn, and finishes. Every prompt it is handed is recorded, which is how the
 * tests see exactly what the agent received — and that nothing else started a turn.
 */
export class ScriptedSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  readonly script: ScriptedTurn[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turn = 0;

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turn += 1;
    const turnId = `turn-${this.turn}`;
    const text = promptText(prompt);
    this.prompts.push(text);
    const scripted = this.script.shift() ?? {};
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      this.push({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "user_message", text },
      });
      if (scripted.compacts) {
        this.push({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "compaction", status: "completed", trigger: "manual" },
        });
      }
      if (scripted.contextTokens !== undefined) {
        this.push({
          type: "usage_updated",
          provider: this.provider,
          turnId,
          usage: { contextWindowUsedTokens: scripted.contextTokens },
        });
      }
      this.push({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

export class ScriptedClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions: ScriptedSession[] = [];
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(): Promise<AgentSession> {
    const session = new ScriptedSession();
    this.sessions.push(session);
    return session;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}
