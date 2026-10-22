import type {
  AgentManager,
  AgentOperatorSignal,
  IdleTurnOutcome,
  LeaderCompactionAgentSummary,
} from "./agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "./agent/agent-prompt.js";
import {
  LEADER_COMPACTION_MESSAGE_HEADER,
  NO_LEADER_COMPACTION_DEFERRAL,
  applyLeaderCompactionTurnOutcome,
  hasLeaderCompactionPrepareTimedOut,
  leaderCompactionDeferMinutesLeft,
  type LeaderCompactionAction,
  planLeaderCompactionStep,
  resolveLeaderCompactionConfig,
  type LeaderCompactionCarriedPrompt,
  type LeaderCompactionConfig,
  type LeaderCompactionDeferral,
  type LeaderCompactionEpisode,
  type LeaderCompactionPlan,
  type LeaderCompactionSettings,
  type LeaderCompactionState,
  type LeaderCompactionStep,
  type LeaderCompactionStepFailure,
  type LeaderCompactionTiming,
  type LeaderCompactionTrigger,
  type LeaderCompactionTurnApplied,
  type LeaderCompactionTurnResult,
} from "./agent/leader-compaction-planner.js";
import type { LeaderCompactionTimingPort } from "./agent/leader-compaction-timing.js";
import type { PushNotificationSender } from "./push/index.js";
import { MonitorModeLog } from "./monitor-mode-log.js";

/** How long the quiet gate held an episode's start (docs/leader-compaction.md, "Quiet gate"). */
export interface LeaderCompactionQuietHold {
  /** The first sweep the gate held the would-be start. */
  heldFromMs: number;
  /** The sweep the gate let it through and the episode opened. */
  heldUntilMs: number;
}

/**
 * The compaction ledger's view onto each step, added without touching the planner's pure types
 * (docs/insights.md). `totalTokens` is `ActiveManagedAgent.totalTokens` (docs/token-burn.md), the
 * ledger's cost signal. Every call is isolated: an observer that throws is logged, never allowed
 * to stop the step it reports on.
 */
export interface LeaderCompactionEpisodeObserver {
  onStepStarted(input: {
    agentId: string;
    agentTitle: string | null;
    step: LeaderCompactionStep;
    attempt: number;
    trigger: LeaderCompactionTrigger;
    usedTokens: number | undefined;
    totalTokensAtStart: number | undefined;
    atMs: number;
    /** Set on the episode's first step when the quiet gate held its start; null otherwise. */
    quietGate?: LeaderCompactionQuietHold | null;
    /** The human prompts the episode carries so far. */
    carriedPrompts?: readonly LeaderCompactionCarriedPrompt[];
    /** This prepare asks again after the agent deferred, or was refused: same episode. */
    reask?: boolean;
  }): void;
  onStepFinished(input: {
    agentId: string;
    step: LeaderCompactionStep;
    outcome: "completed" | "canceled" | "failed" | "busy" | "notCompacted";
    gaveUp: boolean;
    episodeEnded: "done" | "gaveUp" | null;
    compactedFromTokens: number | null;
    compactedToTokens: number | null;
    noteLength: number | null;
    totalTokensAtStart: number | undefined;
    totalTokensAtEnd: number | undefined;
    atMs: number;
    /** Messages steered into this step's turn: its spend then includes answering them. */
    steeredIn?: number;
    /** The human prompts the episode carries as of this step's end. */
    carriedPrompts?: readonly LeaderCompactionCarriedPrompt[];
    /** What the agent has deferred the episode by so far; null when it has not. */
    deferral?: { count: number; totalMs: number } | null;
  }): void;
  /**
   * The episode stopped without finishing: the planner dropped it (the context shrank on its own,
   * the agent stopped being a candidate) or the leg was turned off. No step is in flight.
   */
  onEpisodeAbandoned?(input: { agentId: string; atMs: number }): void;
}

/** What `startStep` read off the agent as the step began, for the ledger's diff at its end. */
interface StepStartSnapshot {
  totalTokens: number | undefined;
  steersAccepted: number;
  startedAtMs: number;
}

function isOpenPhase(phase: LeaderCompactionState["phase"] | undefined): boolean {
  return phase === "waiting" || phase === "inFlight" || phase === "backoff" || phase === "deferred";
}

/** The episode a state carries, for the phases that carry one. */
function episodeOf(state: LeaderCompactionState): LeaderCompactionEpisode | null {
  return state.phase === "armed" || state.phase === "settled" ? null : state.episode;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/**
 * A restore note is meant to be a page or two. One that ran away is cut rather than replayed
 * whole: it goes back into a context this whole sequence exists to keep small.
 */
const MAX_NOTE_CHARS = 20_000;
/** A carried prompt longer than this is cut the same way: readable without ballooning the step. */
const MAX_PROMPT_CHARS = 2_000;
/** A stuck episode can stay open through hours of retries; keep only the most recent of these. */
const MAX_CARRIED_PROMPTS = 20;

interface LeaderCompactionMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentLeaderCompactionMonitorOptions {
  agentManager: Pick<
    AgentManager,
    "listAgentsForLeaderCompaction" | "startTurnIfIdle" | "subscribeOperatorSignals"
  >;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  readDaemonConfig: () => { leaderCompaction?: LeaderCompactionSettings };
  logger: LeaderCompactionMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
  /**
   * Feature 9's advisor (docs/jev.md, "Feature 9: compaction timing"). Absent: every episode starts
   * at `prepareAtTokens`, and `/compact` goes out with today's text.
   */
  timing?: LeaderCompactionTimingPort;
  /** The compaction ledger (docs/insights.md). Absent: episodes are not recorded anywhere. */
  episodeObserver?: LeaderCompactionEpisodeObserver;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

/** What `prepare` offers the agent on top of the note: whether it may defer, and how far. */
export interface LeaderCompactionPrepareOffer {
  /** Whole minutes the agent may still ask to defer by; 0 when it may not. */
  deferMinutesLeft: number;
  /** Minutes earlier deferrals in this episode already added; 0 on the first ask. */
  deferredMinutes: number;
  /** The agent asked to defer and was refused, so this is the last ask. */
  deferralRefused: boolean;
  /** The agent deferred again after the refusal; this ask is the explicit one before failing. */
  deferralRefusedAgain: boolean;
}

function prepareOfferFor(
  deferral: LeaderCompactionDeferral,
  config: LeaderCompactionConfig,
  usedTokens: number | undefined,
): LeaderCompactionPrepareOffer {
  return {
    deferMinutesLeft: leaderCompactionDeferMinutesLeft(deferral, config, usedTokens),
    deferredMinutes: Math.round(deferral.grantedMs / 60_000),
    deferralRefused: deferral.refused,
    deferralRefusedAgain: deferral.refusalEscalated,
  };
}

function formatMinutes(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * The finish-up window (docs/leader-compaction.md): an agent partway through a step it cannot
 * safely leave finishes just that step before it writes the note. Bounded in time and in scope, so
 * the turn stays the short one the monitor waits for.
 */
function formatFinishUp(config: LeaderCompactionConfig, offer: LeaderCompactionPrepareOffer) {
  if (config.finishUpMs <= 0) {
    return "Do not call tools or start anything new in this turn.";
  }
  const window = formatMinutes(Math.max(1, Math.round(config.finishUpMs / 60_000)));
  return (
    "If you are partway through a step that is unsafe or costly to leave half-done (a merge, " +
    "push, deploy, migration, multi-file edit, or a build or test you are waiting on), finish " +
    `that one step now. Spend at most about ${window} and a few tool calls on it, and start ` +
    "nothing new, not even the step that obviously comes next. If you are not partway through " +
    `such a step, call no tools. ${formatUnfinishedStep(config, offer)}`
  );
}

/** What the agent does with a step it cannot finish in the window: defer it, or say where it stands. */
function formatUnfinishedStep(
  config: LeaderCompactionConfig,
  offer: LeaderCompactionPrepareOffer,
): string {
  const stop =
    "stop where it is safe to stop, and say in the note exactly where it stands and how to resume it.";
  if (offer.deferralRefusedAgain) {
    return `Deferral refused — write the restore note now. If that step is still unfinished, ${stop}`;
  }
  if (offer.deferralRefused) {
    return (
      "You asked to defer this compaction and it cannot be deferred any further. If that step " +
      `is still unfinished, ${stop}`
    );
  }
  if (offer.deferMinutesLeft <= 0) {
    return `If that step cannot finish in that time, ${stop}`;
  }
  return (
    "If that step cannot finish in that time, do not leave it half-done and do not run past " +
    "the limit. Reply with exactly `DEFER <minutes>: <reason>` and nothing else, asking for " +
    `at most ${formatMinutes(offer.deferMinutesLeft)}. The daemon asks you again when the wait ` +
    `is over. Once your context passes ${formatTokens(config.ceilingTokens)} tokens a deferral ` +
    "is refused."
  );
}

/**
 * Step 1. The agent writes its own working state while it still has all of it, including the
 * reasoning compaction will not carry forward. The note is its reply rather than a file: a reply
 * needs no permission and no path, and the daemon reads it straight off the turn. Before that, an
 * agent partway through a critical step may finish just that step, or ask to defer.
 */
export function formatPrepareMessage(
  usedTokens: number,
  config: LeaderCompactionConfig,
  trigger: LeaderCompactionTrigger = { kind: "line" },
  recentPrompt: LeaderCompactionCarriedPrompt | null = null,
  offer: LeaderCompactionPrepareOffer = prepareOfferFor(
    NO_LEADER_COMPACTION_DEFERRAL,
    config,
    usedTokens,
  ),
): string {
  const size = `Your conversation is ${formatTokens(usedTokens)} tokens`;
  const line = formatTokens(config.prepareAtTokens);
  const why =
    trigger.kind === "early"
      ? `${size}. That is under the ${line} line, but ${trigger.reason}, so this is a clean ` +
        "point to compact it."
      : `${size}, over the ${line} line.`;
  const deferred =
    offer.deferredMinutes > 0
      ? ` You deferred this by ${formatMinutes(offer.deferredMinutes)}; it is due now.`
      : "";
  const nextStepBullet = recentPrompt
    ? "- The exact next step. The user also sent you this, possibly not yet done: " +
      `"${truncateAt(recentPrompt.text, MAX_PROMPT_CHARS, "message")}". If it is not done, make ` +
      "answering it the next step."
    : "- The exact next step.";
  return formatSystemNotificationPrompt(
    [
      `${LEADER_COMPACTION_MESSAGE_HEADER} 1 of 3. ${why}${deferred} Every request you make ` +
        "re-reads the whole of it, so at this size each step costs many times what it would " +
        "in a fresh context. The daemon will compact your conversation (Claude Code's " +
        "/compact) as soon as this turn ends. You keep the same agent id, your subagents keep " +
        "running, and their finish notifications still come to you.",
      "Compaction replaces your history with a summary, and your earlier reasoning does not " +
        "survive it. So your final message in this turn must be your restore note, and nothing " +
        "else. The daemon hands it back to you word for word afterwards.",
      formatFinishUp(config, offer),
      [
        "The note covers:",
        "- The goal, and every instruction, rule or constraint the user gave you. Quote them.",
        "- What is done: commits, branches, PRs, files, with ids and paths.",
        "- What is in flight: each subagent id you are waiting on and what it is doing, and any " +
          "step you were finishing and where it stands.",
        "- Decisions made and why, and dead ends not to try again.",
        nextStepBullet,
      ].join("\n"),
      "Keep it under about 1,500 words. Facts over narrative.",
    ].join("\n\n"),
  );
}

/**
 * Step 2. `/compact` takes free-text instructions for its summarizer, which reads the visible
 * conversation only — the note it is told to keep is what carries the reasoning across. A cut
 * point, when JEV gave one in time, says where the live work starts.
 */
export function formatCompactCommand(cutPoint?: string | null): string {
  const base =
    "/compact Keep the most recent assistant message verbatim: it is a restore note written for " +
    "this compaction. Also keep every instruction and constraint the user gave, the ids of " +
    "subagents still in flight, file paths, branches, commits and PR numbers, and the next step.";
  return cutPoint ? `${base} ${cutPoint}` : base;
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

function truncateAt(text: string, max: number, noun: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[${noun} cut at ${max} characters]`;
}

/**
 * The human prompts the leader got from shortly before `prepare` through to the start of
 * `restore` (docs/leader-compaction.md, "Quiet gate and carried prompts"). Null when there were
 * none: a quiet episode quotes nothing rather than saying so.
 */
function formatCarriedPrompts(prompts: readonly LeaderCompactionCarriedPrompt[]): string | null {
  if (prompts.length === 0) return null;
  const quoted = prompts
    .map(
      (prompt) => `<message>\n${truncateAt(prompt.text, MAX_PROMPT_CHARS, "message")}\n</message>`,
    )
    .join("\n");
  return [
    "The user sent you these messages around the compaction:",
    quoted,
    "Check that each one is answered or already in progress. Handle any that is not before you " +
      "carry on from the note.",
  ].join("\n\n");
}

/** Step 3. What happened, why, what did not change, and the note itself. */
export function formatRestoreMessage(episode: LeaderCompactionEpisode): string {
  const noteSection = episode.note
    ? [
        "Your restore note, written by you just before the compaction:",
        `<restore-note>\n${truncateAt(episode.note, MAX_NOTE_CHARS, "note")}\n</restore-note>`,
      ].join("\n\n")
    : "You did not leave a restore note, so the summary above is all that carried over. Check " +
      "the state of your work (git, your subagents) before acting on it.";
  const sections = [
    `${LEADER_COMPACTION_MESSAGE_HEADER} 3 of 3, done. Your conversation was compacted to cut ` +
      `the cost of every request you make: ${describeCompaction(episode)}. Earlier ` +
      "turns are now a summary, and your reasoning from before it is gone, so where the " +
      "summary and the note disagree, trust the note. Nothing else changed: same agent id, " +
      "same workspace, and your subagents are still running and still report to you.",
    noteSection,
    formatCarriedPrompts(episode.carriedPrompts),
    "Carry on from the note's next step. If you were waiting on subagents, there is nothing " +
      "to do now; their finish notifications will wake you. Re-read a file before editing " +
      "it rather than trusting the summary's memory of it.",
  ].filter((section): section is string => section !== null);
  return formatSystemNotificationPrompt(sections.join("\n\n"));
}

function formatStepPrompt(input: {
  step: LeaderCompactionStep;
  episode: LeaderCompactionEpisode;
  config: LeaderCompactionConfig;
  cutPoint: string | null;
  usedTokens: number | undefined;
}): string {
  const { step, episode, config, cutPoint, usedTokens } = input;
  switch (step) {
    case "prepare":
      return formatPrepareMessage(
        episode.triggeredAtTokens,
        config,
        episode.trigger,
        episode.carriedPrompts.at(-1) ?? null,
        prepareOfferFor(episode.deferral, config, usedTokens),
      );
    case "compact":
      return formatCompactCommand(cutPoint);
    case "restore":
      return formatRestoreMessage(episode);
  }
}

function describeDryRunStart(trigger: LeaderCompactionTrigger, startsNow: boolean): string {
  const steps = "prepare, then /compact, then restore";
  if (trigger.kind === "early") {
    return `Leader compaction would start now, early, at a clean break JEV saw: ${steps}`;
  }
  return startsNow
    ? `Leader compaction would start now: ${steps}`
    : `Leader compaction would start at the agent's next idle moment: ${steps}`;
}

function describeFailure(failure: LeaderCompactionStepFailure): string {
  switch (failure.kind) {
    case "canceled":
      return "the turn was cancelled";
    case "timedOut":
      return "the turn was still running when the monitor stopped waiting for it";
    case "failed":
      return `the turn failed: ${failure.error}`;
    case "busy":
      return "the agent started other work first";
    case "notCompacted":
      return failure.usedTokens === undefined
        ? "the context size could not be read afterwards"
        : `the context was still ${formatTokens(failure.usedTokens)} tokens afterwards`;
    case "deferredAfterRefusal":
      return "the agent deferred again after being told the deferral was refused";
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
  /** The `defer` verdict last reported per agent, so a verdict standing over many sweeps logs once. */
  private readonly reportedDeferrals = new Map<string, LeaderCompactionTiming>();
  /** The last `ceilingTokens` value warned about, so a standing misconfiguration logs once. */
  private loggedCeilingTokensTooHigh: number | null = null;
  /** The quiet-gate hold last reported per agent, keyed on when it lifts, for the same reason. */
  private readonly reportedQuietHolds = new Map<string, number>();
  /** The leader's most recent human prompt the daemon has seen (the quiet gate; carried prompts
   * come from the episode itself, appended live below). */
  private readonly lastHumanPrompt = new Map<string, LeaderCompactionCarriedPrompt>();
  /** Turns this monitor started and has not seen end. Tests await them through `settle()`. */
  private readonly turns = new Set<Promise<void>>();
  private readonly unsubscribeOperatorSignals: () => void;
  /** Each in-flight step's start snapshot, for the ledger's cost diff and the prepare bound. */
  private readonly stepStarts = new Map<string, StepStartSnapshot>();
  /**
   * Which turn each agent's step is waiting on. A prepare turn the monitor stopped waiting for
   * keeps running; when it ends, its token is stale and its outcome is dropped.
   */
  private readonly stepTokens = new Map<string, number>();
  /** When the quiet gate first held each agent's would-be episode, while it still holds. */
  private readonly quietHoldSince = new Map<string, number>();
  /** A hold that ended with an episode opening, waiting for that episode's first step to start. */
  private readonly episodeQuietHolds = new Map<string, LeaderCompactionQuietHold>();

  constructor(options: AgentLeaderCompactionMonitorOptions) {
    this.options = options;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.modeLog = new MonitorModeLog(options.logger);
    // From construction, not `start`: a message sent before the first sweep still counts.
    this.unsubscribeOperatorSignals = options.agentManager.subscribeOperatorSignals((signal) =>
      this.onOperatorSignal(signal),
    );
  }

  /**
   * Tracks the leader's most recent human prompt, and carries it into an episode already open —
   * through the start of `restore` (docs/leader-compaction.md): once that turn has started, the
   * message it sent is already built, so anything after it is just a new message.
   */
  private onOperatorSignal(signal: AgentOperatorSignal): void {
    if (signal.kind !== "human-prompt") return;
    const prompt: LeaderCompactionCarriedPrompt = { atMs: signal.at.getTime(), text: signal.text };
    this.lastHumanPrompt.set(signal.agentId, prompt);
    const state = this.states.get(signal.agentId);
    if (!state) return;
    if (state.phase === "armed" || state.phase === "settled") return;
    if (state.phase === "inFlight" && state.step === "restore") return;
    const carriedPrompts = [...state.episode.carriedPrompts, prompt].slice(-MAX_CARRIED_PROMPTS);
    this.states.set(signal.agentId, {
      ...state,
      episode: { ...state.episode, carriedPrompts },
    });
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
    this.unsubscribeOperatorSignals();
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

  /** An episode has started and not ended: its own turns are not the leader's work. */
  isEpisodeOpen(agentId: string): boolean {
    return isOpenPhase(this.states.get(agentId)?.phase);
  }

  /** Dedup/quiet-gate bookkeeping, keyed only on agent id: reclaimed for a dead agent whether or
   * not the monitor is enabled, so turning it off doesn't leave these growing forever. */
  private pruneTrackingMaps(liveIds: ReadonlySet<string>): void {
    for (const agentId of this.reportedDeferrals.keys()) {
      if (!liveIds.has(agentId)) this.reportedDeferrals.delete(agentId);
    }
    for (const agentId of this.reportedQuietHolds.keys()) {
      if (!liveIds.has(agentId)) this.reportedQuietHolds.delete(agentId);
    }
    for (const agentId of this.lastHumanPrompt.keys()) {
      if (!liveIds.has(agentId)) this.lastHumanPrompt.delete(agentId);
    }
    for (const agentId of this.quietHoldSince.keys()) {
      if (!liveIds.has(agentId)) this.quietHoldSince.delete(agentId);
    }
    for (const agentId of this.episodeQuietHolds.keys()) {
      if (!liveIds.has(agentId)) this.episodeQuietHolds.delete(agentId);
    }
    // A gone agent's state can outlive this sweep (an in-flight turn), and so must its token.
    for (const agentId of this.stepTokens.keys()) {
      if (!liveIds.has(agentId) && !this.states.has(agentId)) this.stepTokens.delete(agentId);
    }
  }

  private sweep(): void {
    this.reportMode();
    const settings = this.options.readDaemonConfig().leaderCompaction;
    const agents = this.options.agentManager.listAgentsForLeaderCompaction();
    const liveIds = new Set(agents.map((agent) => agent.id));
    this.pruneTrackingMaps(liveIds);
    if (settings?.enabled !== true) {
      // A turn already started still ends and is applied; everything else starts over when the
      // leg comes back, the same as after a restart.
      const nowMs = this.now();
      for (const [agentId, state] of this.states) {
        if (state.phase === "inFlight") continue;
        this.states.delete(agentId);
        if (isOpenPhase(state.phase)) this.notifyEpisodeAbandoned(agentId, nowMs);
      }
      this.quietHoldSince.clear();
      this.episodeQuietHolds.clear();
      return;
    }
    const config = resolveLeaderCompactionConfig(settings, {
      onCeilingTokensTooHigh: (rawCeilingTokens) => {
        if (this.loggedCeilingTokensTooHigh === rawCeilingTokens) return;
        this.loggedCeilingTokensTooHigh = rawCeilingTokens;
        this.options.logger.warn(
          { ceilingTokens: rawCeilingTokens },
          "Leader compaction: ceilingTokens is close to the CLI's own auto-compact point; " +
            "clamped to 900K for deferral eligibility and wait-ending",
        );
      },
    });
    const nowMs = this.now();
    for (const [agentId, state] of this.states) {
      if (!liveIds.has(agentId) && state.phase !== "inFlight") {
        this.states.delete(agentId);
        if (isOpenPhase(state.phase)) this.notifyEpisodeAbandoned(agentId, nowMs);
      }
    }

    for (const agent of agents) {
      const timing = this.timingFor(agent.id, config);
      this.stopWaitingForOverlongPrepare(agent, config, nowMs);
      const previous = this.states.get(agent.id);
      const plan = planLeaderCompactionStep({
        state: previous,
        agent,
        config,
        nowMs,
        timing,
        lastHumanPrompt: this.lastHumanPrompt.get(agent.id) ?? null,
      });
      this.trackQuietHold(agent.id, previous, plan, nowMs);
      // A sweep, not a step's outcome, closed an open episode: the planner dropped it.
      if (isOpenPhase(previous?.phase) && !isOpenPhase(plan.state.phase)) {
        this.notifyEpisodeAbandoned(agent.id, nowMs);
      }
      this.setState(agent.id, plan.state);
      this.act(agent, plan.action, timing, config);
    }
  }

  /**
   * A `prepare` turn past `prepareTimeoutMinutes` (docs/leader-compaction.md, "Finish-up window").
   * The turn is not cancelled: it may be a deploy the agent is finishing. The monitor stops
   * waiting, counts a failed try, and asks again after the backoff; the turn's own outcome is
   * dropped when it comes.
   */
  private stopWaitingForOverlongPrepare(
    agent: LeaderCompactionAgentSummary,
    config: LeaderCompactionConfig,
    nowMs: number,
  ): void {
    const state = this.states.get(agent.id);
    const start = this.stepStarts.get(agent.id);
    if (state?.phase !== "inFlight" || state.step !== "prepare" || !start) return;
    if (!hasLeaderCompactionPrepareTimedOut(start.startedAtMs, nowMs, config)) return;
    this.stepTokens.set(agent.id, (this.stepTokens.get(agent.id) ?? 0) + 1);
    this.applyResult(agent, "prepare", state.episode, { status: "timedOut" }, config);
  }

  /**
   * Follows the quiet gate for the ledger: from the first sweep it holds a would-be start to the
   * sweep the episode opens. A hold that ends any other way (the trigger went away, a dry run)
   * is dropped, so it can never attach to a later episode.
   */
  private trackQuietHold(
    agentId: string,
    previous: LeaderCompactionState | undefined,
    plan: LeaderCompactionPlan,
    nowMs: number,
  ): void {
    if (plan.action.kind === "quietHold") {
      if (!this.quietHoldSince.has(agentId)) this.quietHoldSince.set(agentId, nowMs);
      return;
    }
    const heldFromMs = this.quietHoldSince.get(agentId);
    this.quietHoldSince.delete(agentId);
    if (!isOpenPhase(plan.state.phase)) {
      this.episodeQuietHolds.delete(agentId);
      return;
    }
    if (heldFromMs !== undefined && !isOpenPhase(previous?.phase)) {
      this.episodeQuietHolds.set(agentId, { heldFromMs, heldUntilMs: nowMs });
    }
  }

  /** Runs one observer call; a ledger failure is logged and never reaches the compaction. */
  private observe(
    agentId: string,
    call: (observer: LeaderCompactionEpisodeObserver) => void,
  ): void {
    const observer = this.options.episodeObserver;
    if (!observer) return;
    try {
      call(observer);
    } catch (error) {
      this.options.logger.warn({ err: error, agentId }, "Compaction ledger observer failed");
    }
  }

  private notifyEpisodeAbandoned(agentId: string, atMs: number): void {
    this.observe(agentId, (observer) => observer.onEpisodeAbandoned?.({ agentId, atMs }));
  }

  private act(
    agent: LeaderCompactionAgentSummary,
    action: LeaderCompactionAction,
    timing: LeaderCompactionTiming | null,
    config: LeaderCompactionConfig,
  ): void {
    switch (action.kind) {
      case "none":
        return;
      case "reportDryRun":
        if (action.trigger.kind === "early") {
          this.options.timing?.noteEarlyStart(agent.id, { dryRun: true });
        }
        this.reportDryRun(
          agent,
          action.usedTokens,
          action.startsNow,
          action.trigger,
          action.recentPrompt,
          config,
        );
        return;
      case "defer":
        // The same verdict stands over every sweep until the next turn; say so once.
        if (timing && this.reportedDeferrals.get(agent.id) !== timing) {
          this.reportedDeferrals.set(agent.id, timing);
          this.options.timing?.noteDefer(agent.id, { dryRun: config.dryRun });
          this.reportDefer(agent, action.usedTokens, action.reason, config);
        }
        return;
      case "quietHold":
        // The same hold stands until it lifts or a new prompt arrives; say so once.
        if (this.reportedQuietHolds.get(agent.id) !== action.quietUntilMs) {
          this.reportedQuietHolds.set(agent.id, action.quietUntilMs);
          this.reportQuietHold(agent, action.usedTokens, action.quietUntilMs, config);
        }
        return;
      case "startTurn":
        if (action.step === "prepare" && action.episode.trigger.kind === "early") {
          this.options.timing?.noteEarlyStart(agent.id, { dryRun: false });
        }
        this.startStep(agent, action.step, action.episode, config);
    }
  }

  /**
   * The advisor's verdict, when it may shape this sweep. A shadow answer acts on nothing, so it
   * shapes only a dry run's would-start.
   */
  private timingFor(
    agentId: string,
    config: LeaderCompactionConfig,
  ): LeaderCompactionTiming | null {
    const verdict = this.options.timing?.verdictFor(agentId) ?? null;
    if (!verdict || !(verdict.live || config.dryRun)) return null;
    return verdict.timing;
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
    trigger: LeaderCompactionTrigger,
    recentPrompt: LeaderCompactionCarriedPrompt | null,
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
        trigger: trigger.kind,
        ...(trigger.kind === "early" ? { reason: trigger.reason } : {}),
        prepareMessage: formatPrepareMessage(usedTokens, config, trigger, recentPrompt),
        compactCommand: formatCompactCommand(),
      },
      describeDryRunStart(trigger, startsNow),
    );
  }

  private reportQuietHold(
    agent: LeaderCompactionAgentSummary,
    usedTokens: number,
    quietUntilMs: number,
    config: LeaderCompactionConfig,
  ): void {
    this.options.logger.info(
      {
        dryRun: config.dryRun,
        agentId: agent.id,
        title: agent.title,
        usedTokens,
        prepareAtTokens: config.prepareAtTokens,
        quietUntil: new Date(quietUntilMs).toISOString(),
      },
      config.dryRun
        ? "Leader compaction would hold: the leader messaged recently"
        : "Leader compaction held: the leader messaged recently",
    );
  }

  private reportDefer(
    agent: LeaderCompactionAgentSummary,
    usedTokens: number,
    reason: string,
    config: LeaderCompactionConfig,
  ): void {
    this.options.logger.info(
      {
        dryRun: config.dryRun,
        agentId: agent.id,
        title: agent.title,
        usedTokens,
        prepareAtTokens: config.prepareAtTokens,
        reason,
      },
      config.dryRun
        ? "Leader compaction would hold: JEV judged the leader mid-way through a multi-step edit"
        : "Leader compaction held: JEV judged the leader mid-way through a multi-step edit",
    );
  }

  private startStep(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    episode: LeaderCompactionEpisode,
    config: LeaderCompactionConfig,
  ): void {
    const cutPoint =
      step === "compact" ? (this.options.timing?.cutPointFor(agent.id) ?? null) : null;
    const prompt = formatStepPrompt({
      step,
      episode,
      config,
      cutPoint,
      usedTokens: agent.contextWindowUsedTokens,
    });
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
        trigger: episode.trigger.kind,
        ...(cutPoint ? { cutPoint } : {}),
      },
      "Leader compaction started a step",
    );
    this.stepStarts.set(agent.id, {
      totalTokens: agent.totalTokens,
      steersAccepted: agent.steersAccepted,
      startedAtMs: this.now(),
    });
    const token = (this.stepTokens.get(agent.id) ?? 0) + 1;
    this.stepTokens.set(agent.id, token);
    const quietGate = this.episodeQuietHolds.get(agent.id) ?? null;
    this.episodeQuietHolds.delete(agent.id);
    this.observe(agent.id, (observer) =>
      observer.onStepStarted({
        agentId: agent.id,
        agentTitle: agent.title ?? null,
        step,
        attempt: episode.attempts + 1,
        trigger: episode.trigger,
        usedTokens: agent.contextWindowUsedTokens,
        totalTokensAtStart: agent.totalTokens,
        atMs: this.now(),
        quietGate,
        carriedPrompts: episode.carriedPrompts,
        reask: episode.deferral.count > 0 || episode.deferral.refused,
      }),
    );
    const tracked = this.finishStep(agent, step, episode, started, config, token).finally(() => {
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
    token: number,
  ): Promise<void> {
    let result: LeaderCompactionTurnResult;
    try {
      result = this.toTurnResult(agent.id, await started);
    } catch (error) {
      result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    if (this.stepTokens.get(agent.id) !== token) {
      this.options.logger.info(
        { agentId: agent.id, step },
        "Leader compaction ignored the outcome of a turn it had stopped waiting for",
      );
      return;
    }
    const after = this.options.agentManager
      .listAgentsForLeaderCompaction()
      .find((candidate) => candidate.id === agent.id);
    this.applyResult(agent, step, episode, result, config, after);
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

  /** Tells the ledger (docs/insights.md) what this step cost and where the episode landed. */
  private notifyStepFinished(
    agentId: string,
    step: LeaderCompactionStep,
    episode: LeaderCompactionEpisode,
    applied: LeaderCompactionTurnApplied,
    after: LeaderCompactionAgentSummary | undefined,
  ): void {
    const start = this.stepStarts.get(agentId);
    this.stepStarts.delete(agentId);
    if (applied.failure?.kind === "busy") {
      return;
    }
    const resultingEpisode = episodeOf(applied.state) ?? episode;
    const steeredIn = start && after ? Math.max(0, after.steersAccepted - start.steersAccepted) : 0;
    this.observe(agentId, (observer) =>
      observer.onStepFinished({
        agentId,
        step,
        // The ledger's outcomes are the wire's (docs/insights.md); a turn the monitor stopped
        // waiting for, or a second deferral after the refusal, is a failed try there.
        outcome:
          applied.failure?.kind === "timedOut" || applied.failure?.kind === "deferredAfterRefusal"
            ? "failed"
            : (applied.failure?.kind ?? "completed"),
        gaveUp: applied.gaveUp,
        episodeEnded:
          applied.state.phase === "settled" && applied.state.reason !== "dryRun"
            ? applied.state.reason
            : null,
        compactedFromTokens: resultingEpisode.compactedFromTokens,
        compactedToTokens: resultingEpisode.compactedToTokens,
        noteLength: resultingEpisode.note?.length ?? null,
        totalTokensAtStart: start?.totalTokens,
        totalTokensAtEnd: after?.totalTokens,
        atMs: this.now(),
        steeredIn,
        carriedPrompts: resultingEpisode.carriedPrompts,
        deferral:
          resultingEpisode.deferral.count > 0
            ? {
                count: resultingEpisode.deferral.count,
                totalMs: resultingEpisode.deferral.grantedMs,
              }
            : null,
      }),
    );
  }

  private applyResult(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    episode: LeaderCompactionEpisode,
    result: LeaderCompactionTurnResult,
    config: LeaderCompactionConfig,
    after?: LeaderCompactionAgentSummary,
  ): void {
    // A prompt sent while this step's turn was running was carried by mutating `this.states`
    // directly (`onOperatorSignal`), not the `episode` this call was started with. Read it back so
    // that carry isn't lost under the outcome built here.
    const live = this.states.get(agent.id);
    const currentEpisode =
      live && live.phase === "inFlight" && live.step === step ? live.episode : episode;
    const applied = applyLeaderCompactionTurnOutcome({
      step,
      episode: currentEpisode,
      result,
      config,
      nowMs: this.now(),
    });
    this.setState(agent.id, applied.state);
    this.notifyStepFinished(agent.id, step, currentEpisode, applied, after);
    if (applied.noteLooksLikeAttemptedDeferral) {
      this.options.logger.warn(
        { agentId: agent.id },
        "Leader compaction: a prepare reply looked like an attempted DEFER but did not parse " +
          "as one; used as the note",
      );
    }
    if (!applied.failure) {
      this.onStepSucceeded(agent, step, currentEpisode, applied.state);
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
        trigger: episode.trigger.kind,
        reason: describeFailure(applied.failure),
        gaveUp: applied.gaveUp,
        retryAt:
          applied.state.phase === "backoff" ? new Date(applied.state.untilMs).toISOString() : null,
      },
      applied.gaveUp
        ? "Leader compaction gave up"
        : "Leader compaction step did not take; will retry",
    );
    // An early start was optional: the leader is under the line, and the line starts the next
    // episode. Only the line's own give-up needs a person, and only for a leader: a delegated
    // agent (scope `all`) is left to the CLI's own compaction.
    if (applied.gaveUp && episode.trigger.kind === "line" && !agent.isDelegated) {
      void this.pushGaveUp(agent, step, applied.failure, config);
    }
  }

  private onStepSucceeded(
    agent: LeaderCompactionAgentSummary,
    step: LeaderCompactionStep,
    before: LeaderCompactionEpisode,
    state: LeaderCompactionState,
  ): void {
    if (step === "prepare") {
      if (state.phase === "waiting" && state.step === "compact") {
        // Asked now, used if the answer is back by the sweep that sends /compact.
        this.options.timing?.requestCutPoint(agent.id);
      }
      this.logDeferralOutcome(agent, before, state);
    }
    this.options.logger.info(
      {
        agentId: agent.id,
        step,
        next: state.phase === "waiting" ? state.step : state.phase,
        ...(state.phase === "waiting" && state.step === "restore"
          ? {
              compactedFromTokens: state.episode.compactedFromTokens,
              compactedToTokens: state.episode.compactedToTokens,
            }
          : {}),
      },
      "Leader compaction finished a step",
    );
  }

  /** Says so when a prepare reply asked to defer: granted, or refused and asked once more. */
  private logDeferralOutcome(
    agent: LeaderCompactionAgentSummary,
    before: LeaderCompactionEpisode,
    state: LeaderCompactionState,
  ): void {
    if (state.phase === "deferred") {
      this.options.logger.info(
        {
          agentId: agent.id,
          minutes: Math.round(
            (state.episode.deferral.grantedMs - before.deferral.grantedMs) / 60_000,
          ),
          totalMinutes: Math.round(state.episode.deferral.grantedMs / 60_000),
          reason: state.episode.deferral.lastReason,
          resumesAt: new Date(state.untilMs).toISOString(),
        },
        "Leader compaction deferred at the agent's request",
      );
    } else if (
      state.phase === "waiting" &&
      state.step === "prepare" &&
      state.episode.deferral.refused &&
      !before.deferral.refused
    ) {
      this.options.logger.info({ agentId: agent.id }, "Leader compaction deferral refused");
    } else if (
      state.phase === "waiting" &&
      state.step === "prepare" &&
      state.episode.deferral.refusalEscalated &&
      !before.deferral.refusalEscalated
    ) {
      this.options.logger.info(
        { agentId: agent.id },
        "Leader compaction deferral refused again; asked once more before failing the step",
      );
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
      await this.options.pushNotificationSender.send(
        {
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
        },
        // `alert`: the retries are spent, and only a person can compact the leader now.
        { level: "alert" },
      );
    } catch (error) {
      this.options.logger.warn({ err: error }, "Leader compaction: push notification failed");
    }
  }
}
