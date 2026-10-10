import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentPromptInput, AgentTimelineItem } from "./agent-sdk-types.js";
import { isSystemInjectedEnvelope } from "./agent-prompt.js";
import { MonitorModeLog } from "../monitor-mode-log.js";

/**
 * Refocus (docs/refocus.md). A long session drifts: the subtask in front of the agent starts to
 * feel like the goal, and after a compaction the agent's picture of its assignment is a summary
 * of a summary. Refocus restates the assignment verbatim, from the daemon's own timeline, and
 * asks the agent three short questions about it.
 *
 * It never starts a turn. A due refocus waits for the next prompt some other surface is already
 * sending the agent — a person's message, a notify-on-finish, a schedule fire, a compaction
 * restore — and rides along on it (`interceptPrompt`, called from agent-prompt.ts's
 * `startAgentRun`). A turn re-reads the whole context; the refocus adds only its own few hundred
 * tokens to a turn that was happening anyway.
 */

// ~300K tokens of new conversation: the same work-since-last-restatement OpenRig's hook waits
// for (2.6MB of transcript). Growth, not turns — one turn can add 200K across fifty tool calls —
// and not wall clock, since drift comes from sustained work rather than elapsed time.
const DEFAULT_GROWTH_TOKENS = 300_000;
// Head of the assignment carried verbatim. The latest direction gets half. Together with the
// questions a firing stays under ~1K tokens.
const DEFAULT_EXCERPT_CHARS = 2_000;

export type RefocusReason = "growth" | "compaction";

export interface RefocusConfig {
  enabled?: boolean;
  dryRun?: boolean;
  growthTokens?: number;
  onCompaction?: boolean;
  scope?: "all" | "topLevelOnly";
  excerptChars?: number;
}

interface ResolvedRefocusConfig {
  enabled: boolean;
  dryRun: boolean;
  growthTokens: number;
  onCompaction: boolean;
  scope: "all" | "topLevelOnly";
  excerptChars: number;
}

export function resolveRefocusConfig(config: RefocusConfig | undefined): ResolvedRefocusConfig {
  return {
    enabled: config?.enabled ?? false,
    dryRun: config?.dryRun ?? false,
    growthTokens: config?.growthTokens ?? DEFAULT_GROWTH_TOKENS,
    onCompaction: config?.onCompaction ?? true,
    scope: config?.scope ?? "all",
    excerptChars: config?.excerptChars ?? DEFAULT_EXCERPT_CHARS,
  };
}

// Every refocus block opens with "<paseo-system>\nRefocus (", so a later refocus can strip an
// earlier one out of the user message it rode on before quoting that message as direction.
const REFOCUS_BLOCK_PATTERN = /\n*<paseo-system>\nRefocus \([\s\S]*?<\/paseo-system>/g;

function stripRefocusBlocks(text: string): string {
  return text.replace(REFOCUS_BLOCK_PATTERN, "").trim();
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n[… ${omitted} more characters not shown]`;
}

export interface RefocusBrief {
  /** The first message of the conversation: what the agent was created to do. */
  assignment: string | null;
  /** The newest message from a person or the parent agent, when it is not the assignment. */
  latestDirection: string | null;
}

/**
 * Reads the assignment and the newest direction out of the daemon's timeline. System-injected
 * envelopes (notify-on-finish, resource warnings) are reports to the agent, not direction, so
 * they never count as the latest direction.
 */
export function readRefocusBrief(items: readonly AgentTimelineItem[]): RefocusBrief {
  let assignment: string | null = null;
  let assignmentIndex = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.type !== "user_message") continue;
    const text = stripRefocusBlocks(item.text);
    if (!text) continue;
    assignment = text;
    assignmentIndex = index;
    break;
  }
  let latestDirection: string | null = null;
  for (let index = items.length - 1; index > assignmentIndex; index -= 1) {
    const item = items[index];
    if (item?.type !== "user_message") continue;
    const text = stripRefocusBlocks(item.text);
    if (!text || isSystemInjectedEnvelope(text)) continue;
    latestDirection = text;
    break;
  }
  return { assignment, latestDirection };
}

function formatThousands(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}K` : `${tokens}`;
}

export function formatRefocusBlock(input: {
  reason: RefocusReason;
  growthTokens: number;
  brief: RefocusBrief;
  excerptChars: number;
}): string {
  const why =
    input.reason === "compaction"
      ? "your context was just compacted"
      : `about ${formatThousands(input.growthTokens)} tokens of work since the last restatement`;
  const lines = [
    `Refocus (${why}).`,
    input.reason === "compaction"
      ? "What you now remember of your assignment is a summary. Here it is as it was given."
      : "Over a long run the work in front of you starts to feel like the goal. Here is the goal as it was given.",
  ];
  if (input.brief.assignment) {
    lines.push(
      "",
      "Your assignment (the first message of this conversation):",
      "<assignment>",
      excerpt(input.brief.assignment, input.excerptChars),
      "</assignment>",
    );
  }
  if (input.brief.latestDirection) {
    lines.push(
      "",
      "The most recent direction you were given. Where it differs from the assignment, it wins:",
      "<latest-direction>",
      excerpt(input.brief.latestDirection, Math.floor(input.excerptChars / 2)),
      "</latest-direction>",
    );
  }
  lines.push(
    "",
    "Before your next step, answer these in two or three lines of your reply, then carry on:",
    "1. What outcome is this work for? Name what the person gets, not the subtask you are on.",
    "2. Does what you are doing right now move that outcome? If not, say so and change course.",
    "3. What have you concluded without checking it at the source?",
    "",
    "This is an automatic Paseo check (agents.refocus), not a new task and not a correction.",
  );
  return `<paseo-system>\n${lines.join("\n")}\n</paseo-system>`;
}

/** Slash commands (`/compact <instructions>`, `/goal …`) take the rest of the prompt as arguments. */
function isSlashCommandPrompt(prompt: AgentPromptInput): boolean {
  const text =
    typeof prompt === "string"
      ? prompt
      : (prompt.find((block) => block.type === "text") as { text: string } | undefined)?.text;
  return text?.trimStart().startsWith("/") ?? false;
}

export function appendRefocusToPrompt(prompt: AgentPromptInput, block: string): AgentPromptInput {
  if (typeof prompt === "string") {
    return `${prompt}\n\n${block}`;
  }
  return [...prompt, { type: "text", text: block }];
}

export interface PromptInterception {
  prompt: AgentPromptInput;
  /** Called once dispatch resolves. A failed dispatch puts the refocus back so the next prompt carries it. */
  settle(delivered: boolean): void;
}

interface AgentRefocusState {
  lastContextTokens: number | undefined;
  growthTokens: number;
  pending: RefocusReason | null;
  /** Taken by a dispatch that has not resolved yet. */
  inFlight: { reason: RefocusReason; growthTokens: number } | null;
}

interface AgentRefocusLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface AgentRefocusOptions {
  agentManager: Pick<AgentManager, "subscribe" | "getAgent" | "getTimeline">;
  readDaemonConfig: () => { refocus?: RefocusConfig };
  logger: AgentRefocusLogger;
}

export class AgentRefocus {
  private readonly agentManager: AgentRefocusOptions["agentManager"];
  private readonly readDaemonConfig: AgentRefocusOptions["readDaemonConfig"];
  private readonly logger: AgentRefocusLogger;
  private readonly modeLog: MonitorModeLog;
  private readonly states = new Map<string, AgentRefocusState>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: AgentRefocusOptions) {
    this.agentManager = options.agentManager;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.modeLog = new MonitorModeLog(options.logger);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.agentManager.subscribe((event) => this.onEvent(event), {
      replayState: false,
    });
    this.reportMode();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.states.clear();
  }

  reportMode(): void {
    const config = this.config();
    this.modeLog.report([
      { monitor: "refocus", enabled: config.enabled, dryRun: config.enabled && config.dryRun },
    ]);
  }

  private config(): ResolvedRefocusConfig {
    return resolveRefocusConfig(this.readDaemonConfig().refocus);
  }

  private inScope(agent: ManagedAgent, config: ResolvedRefocusConfig): boolean {
    if (agent.internal) return false;
    return config.scope === "all" || !isDelegatedAgent(agent);
  }

  private onEvent(event: AgentManagerEvent): void {
    // Every stream fragment of every agent lands here; drop the irrelevant ones before reading
    // config.
    const isCompaction =
      event.type === "agent_stream" &&
      event.event.type === "timeline" &&
      event.event.item.type === "compaction" &&
      event.event.item.status === "completed";
    if (event.type !== "agent_state" && !isCompaction) return;
    const config = this.config();
    if (!config.enabled) {
      // Turning it on later starts every agent from a fresh baseline rather than a stale one.
      if (this.states.size > 0) this.states.clear();
      return;
    }
    if (event.type === "agent_state") {
      this.observeState(event.agent, config);
    } else if (event.type === "agent_stream") {
      this.observeCompaction(event.agentId, config);
    }
  }

  private observeState(agent: ManagedAgent, config: ResolvedRefocusConfig): void {
    // Archive closes the runtime, so "closed" covers it.
    if (agent.lifecycle === "closed" || !this.inScope(agent, config)) {
      this.states.delete(agent.id);
      return;
    }
    const used = agent.lastUsage?.contextWindowUsedTokens;
    if (typeof used !== "number" || !Number.isFinite(used)) return;
    const state = this.stateFor(agent.id);
    if (state.lastContextTokens === undefined) {
      // First reading for this agent: the baseline, not growth. Nothing it did before the
      // daemon (or this feature) started watching counts.
      state.lastContextTokens = used;
      return;
    }
    // Growth is the sum of rises. A drop is a compaction or a rewind: the new, smaller context
    // is the baseline from here, and no growth is claimed for it.
    if (used > state.lastContextTokens) {
      state.growthTokens += used - state.lastContextTokens;
    }
    state.lastContextTokens = used;
    if (state.pending === null && state.growthTokens >= config.growthTokens) {
      state.pending = "growth";
      this.logger.info(
        { agentId: agent.id, reason: "growth", growthTokens: state.growthTokens },
        "Refocus due; waiting for the agent's next prompt",
      );
    }
  }

  private observeCompaction(agentId: string, config: ResolvedRefocusConfig): void {
    if (!config.onCompaction) return;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent || !this.inScope(agent, config)) return;
    const state = this.stateFor(agentId);
    // Compaction outranks growth: whatever was pending is now about a context that no longer
    // exists, and the restatement it owed is exactly what the compaction reason delivers.
    state.pending = "compaction";
    state.growthTokens = 0;
    this.logger.info(
      { agentId, reason: "compaction" },
      "Refocus due; waiting for the agent's next prompt",
    );
  }

  private stateFor(agentId: string): AgentRefocusState {
    let state = this.states.get(agentId);
    if (!state) {
      state = { lastContextTokens: undefined, growthTokens: 0, pending: null, inFlight: null };
      this.states.set(agentId, state);
    }
    return state;
  }

  /**
   * Called for every prompt dispatched to an agent (agent-prompt.ts's `startAgentRun`). Returns
   * null to leave the prompt untouched. Never starts a turn: it only ever adds to a prompt that
   * is already being sent.
   */
  interceptPrompt(agentId: string, prompt: AgentPromptInput): PromptInterception | null {
    const state = this.states.get(agentId);
    if (!state?.pending) return null;
    const config = this.config();
    if (!config.enabled) return null;
    // `/compact <instructions>` would read the refocus as summarisation instructions. Keep it
    // pending for the prompt after — which, for a compaction, is the restore.
    if (isSlashCommandPrompt(prompt)) return null;

    const reason = state.pending;
    const growthTokens = state.growthTokens;
    const agent = this.agentManager.getAgent(agentId);
    const brief = readRefocusBrief(agent ? this.agentManager.getTimeline(agentId) : []);
    const block = formatRefocusBlock({
      reason,
      growthTokens,
      brief,
      excerptChars: config.excerptChars,
    });
    state.pending = null;
    state.growthTokens = 0;
    const inFlight = { reason, growthTokens };
    state.inFlight = inFlight;

    const logFields = {
      agentId,
      reason,
      growthTokens,
      carrier:
        agent?.lifecycle === "running" ? "steer into running turn" : "prompt starting a turn",
      blockChars: block.length,
      approxTokens: Math.ceil(block.length / 4),
    };
    if (config.dryRun) {
      this.logger.info({ ...logFields, block }, "Refocus (dry run): would append to this prompt");
    }
    return {
      prompt: config.dryRun ? prompt : appendRefocusToPrompt(prompt, block),
      settle: (delivered) => {
        if (state.inFlight !== inFlight) return;
        state.inFlight = null;
        if (delivered) {
          if (!config.dryRun) this.logger.info(logFields, "Refocus delivered");
          return;
        }
        // The prompt never reached the agent, so neither did the refocus.
        if (state.pending === null) {
          state.pending = reason;
          state.growthTokens += growthTokens;
        }
        this.logger.warn(logFields, "Refocus not delivered; kept for the next prompt");
      },
    };
  }
}
