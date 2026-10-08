/**
 * What the knowledge base adds to an agent's context (docs/knowledge-base.md): one fixed guidance
 * paragraph for every agent while the knowledge base is on, and the session-start summary taken
 * when the agent was created on a project. Both go into the appended system prompt on every
 * launch, unchanged, so the prompt cache survives resume and reload. Copilot over ACP reads no
 * system prompt, so for it the summary rides on its first prompt instead, and the tool
 * descriptions carry the guidance.
 */

import type { Logger } from "pino";

import type { KnowledgeBaseService } from "../knowledge-base/service.js";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { ManagedAgent, PromptDispatchInterceptor } from "./agent-manager.js";
import {
  appendRefocusToPrompt,
  isSlashCommandPrompt,
  type PromptInterception,
} from "./agent-refocus.js";

/** Never varies per agent: under 120 tokens, and the same bytes for every agent's prompt cache. */
export const KNOWLEDGE_BASE_GUIDANCE =
  "Knowledge base: each project (an initiative that may span repos) has a note with its links, " +
  "decisions, rules and status. At a kickoff, or when the user refers back to earlier work by a " +
  "description, flag, ticket, Figma file or PR, call kb_search, then kb_open the match or kb_create " +
  "a new project, and tell the user the project name. Record decisions (with why), rules and status " +
  "with kb_record as they happen. Links the user pastes are filed for you.";

export type KnowledgeBasePromptSource = Pick<KnowledgeBaseService, "isEnabled" | "getSnapshot">;

/** The guidance, then the agent's stored summary when it has one; empty while the feature is off. */
export function buildKnowledgeBaseSystemPrompt(
  knowledgeBase: KnowledgeBasePromptSource | null,
  agentId: string,
): string {
  if (!knowledgeBase?.isEnabled()) return "";
  const snapshot = knowledgeBase.getSnapshot(agentId);
  return snapshot ? `${KNOWLEDGE_BASE_GUIDANCE}\n\n${snapshot.text}` : KNOWLEDGE_BASE_GUIDANCE;
}

export interface KnowledgeBaseFirstPromptSummaryOptions {
  knowledgeBase: KnowledgeBasePromptSource;
  getAgent: (agentId: string) => Pick<ManagedAgent, "provider" | "lastUserMessageAt"> | null;
  /** Whether the provider ignores the system prompt (Copilot, or a provider extending it). */
  ignoresSystemPrompt: (provider: string) => boolean;
}

/**
 * The summary on a Copilot agent's first prompt. "First" is read off the agent: a prompt the
 * agent has already been sent sets `lastUserMessageAt`, which is persisted, so a restart never
 * sends the summary twice. A dispatch that fails leaves it for the next prompt.
 */
export class KnowledgeBaseFirstPromptSummary {
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: KnowledgeBaseFirstPromptSummaryOptions) {}

  interceptPrompt(agentId: string, prompt: AgentPromptInput): PromptInterception | null {
    if (this.inFlight.has(agentId)) return null;
    const agent = this.options.getAgent(agentId);
    if (!agent || agent.lastUserMessageAt) return null;
    if (!this.options.ignoresSystemPrompt(agent.provider)) return null;
    if (!this.options.knowledgeBase.isEnabled()) return null;
    const snapshot = this.options.knowledgeBase.getSnapshot(agentId);
    if (!snapshot) return null;
    // A slash command takes the rest of the prompt as its arguments.
    if (isSlashCommandPrompt(prompt)) return null;

    this.inFlight.add(agentId);
    return {
      prompt: appendRefocusToPrompt(prompt, `<paseo-system>\n${snapshot.text}\n</paseo-system>`),
      settle: () => {
        // Delivered or not, `lastUserMessageAt` now answers whether the next prompt is the first.
        this.inFlight.delete(agentId);
      },
    };
  }
}

/**
 * Runs each interceptor on the previous one's prompt, in order, and settles each on its own. An
 * interceptor or settle that throws is logged and skipped: neither may stop a prompt being sent.
 */
export function composePromptDispatchInterceptors(
  interceptors: PromptDispatchInterceptor[],
  logger: Pick<Logger, "warn">,
): PromptDispatchInterceptor {
  return (agentId, prompt) => {
    let current = prompt;
    const settles: Array<PromptInterception["settle"]> = [];
    for (const intercept of interceptors) {
      let interception: PromptInterception | null;
      try {
        interception = intercept(agentId, current);
      } catch (error) {
        logger.warn({ err: error, agentId }, "A prompt interceptor failed; sending without it");
        continue;
      }
      if (!interception) continue;
      current = interception.prompt;
      settles.push(interception.settle);
    }
    if (settles.length === 0) return null;
    return {
      prompt: current,
      settle: (delivered) => {
        for (const settle of settles) {
          try {
            settle(delivered);
          } catch (error) {
            logger.warn({ err: error, agentId }, "A prompt interceptor's settle failed");
          }
        }
      },
    };
  };
}
