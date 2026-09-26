import type {
  AgentManager,
  IdleTurnOutcome,
  LeaderCompactionAgentSummary,
} from "./agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "./agent/agent-prompt.js";
import {
  applyLeaderCompactionTurnOutcome,
  planLeaderCompactionStep,
  resolveLeaderCompactionConfig,
  type LeaderCompactionConfig,
  type LeaderCompactionEpisode,
  type LeaderCompactionSettings,
  type LeaderCompactionState,
  type LeaderCompactionStep,
  type LeaderCompactionStepFailure,
  type LeaderCompactionTurnResult,
} from "./agent/leader-compaction-planner.js";
import type { PushNotificationSender } from "./push/index.js";
import { MonitorModeLog } from "./monitor-mode-log.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/**
 * A restore note is meant to be a page or two. One that ran away is cut rather than replayed
 * whole: it goes back into a context this whole sequence exists to keep small.
 */
const MAX_NOTE_CHARS = 20_000;

interface LeaderCompactionMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentLeaderCompactionMonitorOptions {
  agentManager: Pick<AgentManager, "listAgentsForLeaderCompaction" | "startTurnIfIdle">;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  readDaemonConfig: () => { leaderCompaction?: LeaderCompactionSettings };
  logger: LeaderCompactionMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

/**
 * Step 1. The agent writes its own working state while it still has all of it, including the
 * reasoning compaction will not carry forward. The note is its reply rather than a file: a reply
 * needs no permission and no path, and the daemon reads it straight off the turn.
 */
export function formatPrepareMessage(usedTokens: number, config: LeaderCompactionConfig): string {
  return formatSystemNotificationPrompt(
    [
      `Bozeo leader compaction — step 1 of 3. Your conversation is ${formatTokens(usedTokens)} ` +
        `tokens, over the ${formatTokens(config.prepareAtTokens)} line. Every request you make ` +
        "re-reads the whole of it, so at this size each step costs many times what it would " +
        "in a fresh context. The daemon will compact your conversation (Claude Code's " +
        "/compact) as soon as this turn ends. You keep the same agent id, your subagents keep " +
        "running, and their finish notifications still come to you.",
      "Compaction replaces your history with a summary, and your earlier reasoning does not " +
        "survive it. So write your restore note now, as your entire reply. The daemon hands it " +
        "back to you word for word afterwards. Do not call tools or start anything new in this " +
        "turn. Cover:",
      [
        "- The goal, and every instruction, rule or constraint the user gave you. Quote them.",
        "- What is done: commits, branches, PRs, files, with ids and paths.",
        "- What is in flight: each subagent id you are waiting on and what it is doing.",
        "- Decisions made and why, and dead ends not to try again.",
        "- The exact next step.",
      ].join("\n"),
      "Keep it under about 1,500 words. Facts over narrative.",
    ].join("\n\n"),
  );
}

/**
 * Step 2. `/compact` takes free-text instructions for its summarizer, which reads the visible
 * conversation only — the note it is told to keep is what carries the reasoning across.
 */
export function formatCompactCommand(): string {
  return (
    "/compact Keep the most recent assistant message verbatim: it is a restore note written for " +
    "this compaction. Also keep every instruction and constraint the user gave, the ids of " +
    "subagents still in flight, file paths, branches, commits and PR numbers, and the next step."
  );
}

/**
 * The post-compaction figure is Claude Code's `post_tokens`: the summarized history alone. The
 * system prompt and tools still come on top of it, so it is not the next request's size.
 */
function describeCompaction(episode: LeaderCompactionEpisode): string {
  const from = episode.compactedFromTokens ?? episode.triggeredAtTokens;
  const to = episode.compactedToTokens;
  if (to === null) {
    return `from ${formatTokens(from)} tokens`;
  }
  return `from ${formatTokens(from)} tokens; the history is now a ${formatTokens(to)}-token summary`;
}

function truncateNote(note: string): string {
  if (note.length <= MAX_NOTE_CHARS) return note;
  return `${note.slice(0, MAX_NOTE_CHARS)}\n\n[note cut at ${MAX_NOTE_CHARS} characters]`;
}

/** Step 3. What happened, why, what did not change, and the note itself. */
export function formatRestoreMessage(episode: LeaderCompactionEpisode): string {
  const noteSection = episode.note
    ? [
        "Your restore note, written by you just before the compaction:",
        `<restore-note>\n${truncateNote(episode.note)}\n</restore-note>`,
      ].join("\n\n")
    : "You did not leave a restore note, so the summary above is all that carried over. Check " +
      "the state of your work (git, your subagents) before acting on it.";
  return formatSystemNotificationPrompt(
    [
      "Bozeo leader compaction — step 3 of 3, done. Your conversation was compacted to cut " +
        `the cost of every request you make: ${describeCompaction(episode)}. Earlier ` +
        "turns are now a summary, and your reasoning from before it is gone, so where the " +
        "summary and the note disagree, trust the note. Nothing else changed: same agent id, " +
        "same workspace, and your subagents are still running and still report to you.",
      noteSection,
      "Carry on from the note's next step. If you were waiting on subagents, there is nothing " +
        "to do now; their finish notifications will wake you. Re-read a file before editing " +
        "it rather than trusting the summary's memory of it.",
    ].join("\n\n"),
  );
}

function formatStepPrompt(
  step: LeaderCompactionStep,
  episode: LeaderCompactionEpisode,
  config: LeaderCompactionConfig,
): string {
  switch (step) {
    case "prepare":
      return formatPrepareMessage(episode.triggeredAtTokens, config);
    case "compact":
      return formatCompactCommand();
    case "restore":
      return formatRestoreMessage(episode);
  }
}

function describeFailure(failure: LeaderCompactionStepFailure): string {
  switch (failure.kind) {
    case "canceled":
      return "the turn was cancelled";
    case "failed":
      return `the turn failed: ${failure.error}`;
    case "busy":
      return "the agent started other work first";
    case "notCompacted":
      return failure.usedTokens === undefined
        ? "the context size could not be read afterwards"
        : `the context was still ${formatTokens(failure.usedTokens)} tokens afterwards`;
  }
}

/**
 * Keeps leaders' conversations from growing to enormous context sizes, where each request re-reads
 * hundreds of thousands of cached tokens. Past `prepareAtTokens` it runs three turns on the same
 * agent: ask it for a restore note, send `/compact`, hand the note back. Every turn starts only
 * when the agent is idle, and none of them ever steers or replaces a turn someone else started.
 *
 * Same shape as its siblings: an unref'd 60s timer, config re-read every sweep, and in-memory
 * state only. Off by default, with a dry run that reports each crossing and does nothing.
 *
 * See docs/leader-compaction.md.
 */
export class AgentLeaderCompactionMonitor {
  private readonly options: AgentLeaderCompactionMonitorOptions;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly modeLog: MonitorModeLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private readonly states = new Map<string, LeaderCompactionState>();
  /** Turns this monitor started and has not seen end. Tests await them through `settle()`. */
  private readonly turns = new Set<Promise<void>>();

  constructor(options: AgentLeaderCompactionMonitorOptions) {
    this.options = options;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.modeLog = new MonitorModeLog(options.logger);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.reportMode();
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Leader compaction sweep failed");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reportMode(): void {
    const settings = this.options.readDaemonConfig().leaderCompaction;
    this.modeLog.report([
      {
        monitor: "leader-compaction",
        enabled: settings?.enabled === true,
        dryRun: settings?.dryRun ?? false,
      },
    ]);
  }

  /** Runs one sweep; a call while another sweep is in flight returns without sweeping. */
  async tick(): Promise<void> {
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** Resolves once every turn this monitor has started so far has ended and been applied. */
  async settle(): Promise<void> {
    while (this.turns.size > 0) {
      await Promise.all(this.turns);
    }
  }

  /** The state for one agent, for tests and for the log line that explains a step. */
  getState(agentId: string): LeaderCompactionState | undefined {
    return this.states.get(agentId);
  }

  private sweep(): void {
    this.reportMode();
    const settings = this.options.readDaemonConfig().leaderCompaction;
    if (settings?.enabled !== true) {
      // A turn already started still ends and is applied; everything else starts over when the
      // leg comes back, the same as after a restart.
      for (const [agentId, state] of this.states) {
        if (state.phase !== "inFlight") this.states.delete(agentId);
      }
      return;
    }
    const config = resolveLeaderCompactionConfig(settings);
    const nowMs = this.now();
    const agents = this.options.agentManager.listAgentsForLeaderCompaction();
    const liveIds = new Set(agents.map((agent) => agent.id));
    for (const agentId of this.states.keys()) {
      if (!liveIds.has(agentId) && this.states.get(agentId)?.phase !== "inFlight") {
        this.states.delete(agentId);
      }
    }

    for (const agent of agents) {
      const plan = planLeaderCompactionStep({
        state: this.states.get(agent.id),
        agent,
        config,
        nowMs,
      });
      this.setState(agent.id, plan.state);
      if (plan.action.kind === "reportDryRun") {
        this.reportDryRun(agent, plan.action.usedTokens, plan.action.startsNow, config);
      } else if (plan.action.kind === "startTurn") {
        this.startStep(agent, plan.action.step, plan.action.episode, config);
      }
    }
  }

  private setState(agentId: string, state: LeaderCompactionState): void {
    if (state.phase === "armed") {
      this.states.delete(agentId);
    } else {
      this.states.set(agentId, state);
    }
  }

  private reportDryRun(
    agent: LeaderCompactionAgentSummary,
    usedTokens: number,
    startsNow: boolean,
    config: LeaderCompactionConfig,
  ): void {
    this.options.logger.info(
      {
        dryRun: true,
        agentId: agent.id,
        title: agent.title,
        provider: agent.provider,
        usedTokens,
        prepareAtTokens: config.prepareAtTokens,
        lifecycle: agent.lifecycle,
        startsNow,
        prepareMessage: formatPrepareMessage(usedTokens, config),
        compactCommand: formatCompactCommand(),
      },
      startsNow
        ? "Leader compaction would start now: prepare, then /compact, then restore"
        : "Leader compaction would start at the agent's next idle moment: prepare, then /compact, then restore",
    );
  }

  private startStep(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    episode: LeaderCompactionEpisode,
    config: LeaderCompactionConfig,
  ): void {
    const prompt = formatStepPrompt(step, episode, config);
    let started: Promise<IdleTurnOutcome> | null;
    try {
      started = this.options.agentManager.startTurnIfIdle(agent.id, prompt);
    } catch (error) {
      started = Promise.resolve({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!started) {
      this.applyResult(agent, step, episode, { status: "busy" }, config);
      return;
    }
    this.options.logger.info(
      {
        agentId: agent.id,
        step,
        usedTokens: agent.contextWindowUsedTokens,
        attempt: episode.attempts + 1,
      },
      "Leader compaction started a step",
    );
    const tracked = this.finishStep(agent, step, episode, started, config).finally(() => {
      this.turns.delete(tracked);
    });
    this.turns.add(tracked);
  }

  private async finishStep(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    episode: LeaderCompactionEpisode,
    started: Promise<IdleTurnOutcome>,
    config: LeaderCompactionConfig,
  ): Promise<void> {
    let result: LeaderCompactionTurnResult;
    try {
      result = this.toTurnResult(agent.id, await started);
    } catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    this.applyResult(agent, step, episode, result, config);
  }

  /** Reads the context size after the turn: for `/compact`, the only proof it took. */
  private toTurnResult(agentId: string, outcome: IdleTurnOutcome): LeaderCompactionTurnResult {
    if (outcome.status !== "completed") {
      return outcome;
    }
    const usedTokensAfter = this.options.agentManager
      .listAgentsForLeaderCompaction()
      .find((agent) => agent.id === agentId)?.contextWindowUsedTokens;
    return { status: "completed", finalText: outcome.finalText, usedTokensAfter };
  }

  private applyResult(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    episode: LeaderCompactionEpisode,
    result: LeaderCompactionTurnResult,
    config: LeaderCompactionConfig,
  ): void {
    const applied = applyLeaderCompactionTurnOutcome({
      step,
      episode,
      result,
      config,
      nowMs: this.now(),
    });
    this.setState(agent.id, applied.state);
    if (!applied.failure) {
      this.options.logger.info(
        {
          agentId: agent.id,
          step,
          next: applied.state.phase === "waiting" ? applied.state.step : applied.state.phase,
          ...(applied.state.phase === "waiting" && applied.state.step === "restore"
            ? {
                compactedFromTokens: applied.state.episode.compactedFromTokens,
                compactedToTokens: applied.state.episode.compactedToTokens,
              }
            : {}),
        },
        "Leader compaction finished a step",
      );
      return;
    }
    if (applied.failure.kind === "busy") {
      // Not a failure of anything: the agent is working, and the step waits for it to stop.
      return;
    }
    this.options.logger.warn(
      {
        agentId: agent.id,
        step,
        reason: describeFailure(applied.failure),
        gaveUp: applied.gaveUp,
        retryAt:
          applied.state.phase === "backoff" ? new Date(applied.state.untilMs).toISOString() : null,
      },
      applied.gaveUp
        ? "Leader compaction gave up"
        : "Leader compaction step did not take; will retry",
    );
    if (applied.gaveUp) {
      void this.pushGaveUp(agent, step, applied.failure, config);
    }
  }

  private async pushGaveUp(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    failure: LeaderCompactionStepFailure,
    config: LeaderCompactionConfig,
  ): Promise<void> {
    const label = agent.title?.trim() || "A leader";
    try {
      await this.options.pushNotificationSender.send({
        title: "Could not compact a leader's context",
        body:
          `${label} is over ${formatTokens(config.prepareAtTokens)} tokens of context. The ` +
          `${step} step did not take after ${config.maxAttempts} tries (${describeFailure(failure)}). ` +
          "It keeps running at its current size until it is compacted by hand.",
        data: {
          serverId: this.options.serverId,
          agentId: agent.id,
          reason: "leader_compaction_gave_up",
        },
      });
    } catch (error) {
      this.options.logger.warn({ err: error }, "Leader compaction: push notification failed");
    }
  }
}
