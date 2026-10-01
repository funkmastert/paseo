import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentManager, StallSweepAgentSummary } from "./agent/agent-manager.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent/agent-timeline-store-types.js";
import {
  BACKGROUND_WAIT_LIVE,
  BACKGROUND_WAIT_PROMPT_MARK,
  BACKGROUND_WAIT_QUIET_MS,
  BACKGROUND_WAIT_READ_ROWS,
  MAX_BACKGROUND_WAIT_RESUMES_PER_DAY,
  buildBackgroundWaitPrompt,
  buildExternalWaitPrompt,
  findBackgroundShells,
  findBackgroundWait,
  findExternalWait,
  readFinalMessage,
  readFinalTurnWork,
  type BackgroundWaitClass,
} from "./agent/background-wait.js";
import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "./agent/account-failover-detector.js";
import {
  LOOP_WATCH_CONSECUTIVE,
  LOOP_WATCH_FLOOR,
  LOOP_WATCH_MAX_PER_SWEEP,
  LOOP_WATCH_QUIET_MS,
  STALL_JUDGMENT_READ_ROWS,
  decideStallAction,
  describeStallAction,
  findLoop,
  newestIsRunningTool,
  type LoopMatch,
  type StallJudge,
  type StallJudgment,
  type StallJudgmentAction,
  type StallJudgmentBranch,
} from "./agent/stall-judgment.js";
import type { StallJudgmentSummary, StallMeasurementLine } from "./agent/stall-judgment-log.js";
import { pacedResume, unpacedResume, type PaceResume } from "./agent/resume-pacer.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { isLimitShapedError } from "./agent/account-failover-detector.js";
import { formatSystemNotificationPrompt, sendPromptToAgent } from "./agent/agent-prompt.js";
import { formatDuration } from "./agent/done-janitor-detector.js";
import { attributeProcessTrees, type AgentProcessTree } from "./agent/process-attribution.js";
import { withRecentCpuPercent, type CpuRateMemory } from "./agent/process-cpu-rate.js";
import type { ProcessSampleRow } from "./agent/process-sampler.js";
import {
  hasShownActivitySince,
  newestActivityAtMs,
  notStalledReason,
  recordCpuSample,
  recordUsage,
  type CpuSignal,
  type StallAgentView,
  type StallSignals,
  type UsageSignal,
} from "./agent/stall-detector.js";
import type { ProviderHealth } from "./agent-done-janitor.js";
import { MonitorModeLog } from "./monitor-mode-log.js";
import {
  resolveStalledAgentSweepConfig,
  type RemediationConfig,
  type ResolvedStalledAgentSweepConfig,
} from "./remediation/config.js";
import type {
  RemediationObservation,
  RemediationSink,
  RemedyAttempt,
  RemedyState,
  WorktreeSnapshotResult,
  WorktreeSnapshotter,
} from "./remediation/contract.js";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * After a nudge, activity this soon after it is the nudge itself (its prompt row, the turn
 * starting), not the agent resuming. An agent that answers and stops inside it leaves `running`,
 * which closes the episode anyway.
 */
const NUDGE_SETTLE_MS = 2 * 60_000;
const MONITOR_NAME = "stalled-agent-sweep";
const DAY_MS = 24 * 60 * 60_000;

export type StallNudgeResult =
  | { kind: "sent"; via: "replace" | "reload" }
  | { kind: "failed"; error: string };

export type StallHandoffResult =
  | { kind: "handed-off"; lastError: string }
  /** The turn ended on its own before the cancel reached it. */
  | { kind: "not-running" }
  | { kind: "failed"; error: string };

/** Everything the sweep touches, as seams. Production wiring is in bootstrap.ts. */
export interface StallSweepDependencies {
  listAgents(): StallSweepAgentSummary[];
  /** Never throws; an empty list means `ps` failed. */
  sampleProcesses(): Promise<ProcessSampleRow[]>;
  getProviderHealth(provider: string): Promise<ProviderHealth>;
  snapshotter: WorktreeSnapshotter;
  /** Sends `prompt` as it is (already in its envelope), replacing the stuck run. */
  nudgeAgent(input: { agentId: string; prompt: string }): Promise<StallNudgeResult>;
  /** Cancels the stuck turn so it leaves a limit-shaped `lastError` for account failover. */
  handOffToFailover(agentId: string): Promise<StallHandoffResult>;
  /**
   * The newest `limit` timeline rows, oldest first; null when the agent is not loaded. The stall
   * judgment and the background-wait rule read it. Absent: neither runs.
   */
  readRecentActivity?(agentId: string, limit: number): readonly AgentTimelineRow[] | null;
  /** The agent's first prompt, for the judgment's `assignment`. */
  readAssignment?(agentId: string): string | null;
  /** Feature 10's JEV judgment (docs/jev.md). Absent: today's behaviour. */
  judgeStall?: StallJudge;
  /** The agent's `lastError`: an idle agent whose last turn failed is not waiting on anything. */
  readLastError?(agentId: string): string | undefined;
  /**
   * Starts a turn on an idle agent that ended its turn waiting on background work. Never
   * interrupts: an agent that is no longer idle is skipped. Absent: the rule is off.
   */
  resumeIdleAgent?(input: { agentId: string; prompt: string }): Promise<IdleResumeResult>;
  /** Appends a line to the stall judgment's measurement file. */
  recordMeasurement?(line: StallMeasurementLine): void;
  /** Agents a schedule or heartbeat still targets: it will wake them. Absent: none. */
  listScheduledAgentIds?(): Promise<ReadonlySet<string>>;
  /** Restart recovery has claimed the agent and is about to resume it. Absent: none. */
  isClaimedByRestartRecovery?(agentId: string): boolean;
  /**
   * The built-in provider whose client runs the agent (`claude` for every Claude account). Only
   * Claude's process tree is attributable; the background-wait rule skips the rest when it finds
   * no tree. Absent: the agent's provider id.
   */
  readSessionFamily?(agentId: string): string | undefined;
}

export type IdleResumeResult =
  | { kind: "sent" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export interface AgentStallSweepOptions {
  dependencies: StallSweepDependencies;
  sink: RemediationSink;
  readRemediationConfig: () => RemediationConfig | undefined;
  logger: Logger;
  sweepIntervalMs?: number;
  now?: () => number;
  /** Tests only: production takes `BACKGROUND_WAIT_LIVE`. */
  backgroundWaitLive?: boolean;
}

export interface StallSweepReportEntry {
  agentId: string;
  action:
    | "nudged"
    | "handed-off"
    | "cannot-nudge"
    | "would-nudge"
    | "would-hand-off"
    | "deferred"
    | "still-stalled"
    | "resumed"
    /** Feature 10: JEV judged it progressing with a tool call running; one more window first. */
    | "held"
    /** The loop watch put the agent on the ladder (or would have, in shadow). */
    | "looping"
    /** An idle agent waiting on background work nothing will wake it for got a resume prompt. */
    | "resumed-idle"
    | "would-resume-idle";
  detail: string;
}

export interface StallSweepReport {
  dryRun: boolean;
  entries: StallSweepReportEntry[];
}

interface StallEpisode {
  remedy: RemedyState;
  attempts: RemedyAttempt[];
  snapshot: WorktreeSnapshotResult | null;
  /** The one action this episode gets. Null until it is taken. */
  acted: { kind: "nudge" | "handoff"; atMs: number } | null;
  /** The nudge or handoff failed; nothing more is tried this episode. */
  exhausted: boolean;
  /** A dry run or disabled sweep logs what it would do once per episode. */
  reportedInactiveMode: boolean;
  quietForMs: number;
  health: ProviderHealth;
  /** Feature 10: set once the episode has been judged, whatever came back. Asked once. */
  judgment: { callId: string | null; summary: StallJudgmentSummary | null } | null;
  /** A `progressing` hold: no action before `untilMs`. At most once per episode. */
  hold: { startedAtMs: number; untilMs: number } | null;
  /** Asks the ladder for a person before an agent; the ladder decides whether to honour it. */
  personFirst: { reason: string; confidence: number } | null;
}

interface LoopWatchState {
  /** The repeat the prefilter matched last sweep. */
  signature: string | null;
  /** Consecutive sweeps JEV judged this repeat `looping` at or over the floor. */
  consecutive: number;
  /** After `progressing`, not asked again for this repeat until `untilMs`. */
  quiet: { signature: string; untilMs: number } | null;
  /** The open `looping-agent` episode. Not `applied`: a shadow that only recorded it. */
  reported: { atMs: number; step: string; count: number; applied: boolean } | null;
}

interface AgentStallMemory {
  firstSeenRunningAtMs: number;
  usage: UsageSignal;
  cpu: CpuSignal;
  episode: StallEpisode | null;
  /** The last summary seen, so an episode can still be closed once the agent is gone. */
  agent: StallSweepAgentSummary;
  loop: LoopWatchState | null;
}

interface IdleWaitMemory {
  /** `lastActivityAt` when last checked: an unchanged agent is not read again. */
  checkedActivityAt: string | null;
  /** Resume times, for the per-day cap. */
  resumes: number[];
  /** A `resumed` or `would-resume` line whose outcome is recorded at the next idle check. */
  pendingOutcome: PendingOutcome | null;
}

interface PendingOutcome {
  atMs: number;
  /** The final message's last row: what came after it is the outcome. */
  seq: number;
  waitClass: BackgroundWaitClass;
  resumed: boolean;
}

interface IdleWaitCandidate {
  agent: StallSweepAgentSummary;
  quietForMs: number;
  waitClass: BackgroundWaitClass;
  quote: string;
  /** Own work: what the final turn launched. */
  launched: string[];
  /** External wait: what it waits on. */
  target: string | null;
  seq: number;
}

interface StallCandidate {
  agent: StallSweepAgentSummary;
  memory: AgentStallMemory;
  quietForMs: number;
  health: ProviderHealth;
}

/**
 * Finds agents stuck in `running` on a live daemon (no timeline, token or process-tree activity)
 * and gets them moving: a snapshot and one resume nudge when their account is usable, a handoff
 * to account failover when it is at its cap. Every stall goes on the remediation ladder, which
 * owns the agent and the push if the nudge does not take. The usual monitor shape: an unref'd
 * timer, config re-read every sweep, no overlapping sweeps, memory that a restart only makes
 * slower to act. See docs/stalled-agents.md.
 */
export class AgentStallSweep {
  private readonly options: AgentStallSweepOptions;
  private readonly deps: StallSweepDependencies;
  private readonly now: () => number;
  private readonly modeLog: MonitorModeLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private cpuRateMemory: CpuRateMemory | undefined;
  private readonly memory = new Map<string, AgentStallMemory>();
  private readonly idleWaits = new Map<string, IdleWaitMemory>();
  private readonly backgroundWaitLive: boolean;

  constructor(options: AgentStallSweepOptions) {
    this.options = options;
    this.deps = options.dependencies;
    this.now = options.now ?? Date.now;
    this.backgroundWaitLive = options.backgroundWaitLive ?? BACKGROUND_WAIT_LIVE;
    this.modeLog = new MonitorModeLog(options.logger);
  }

  start(): void {
    if (this.timer) return;
    this.reportMode();
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Stalled-agent sweep failed");
      });
    }, this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
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
    const config = resolveStalledAgentSweepConfig(this.options.readRemediationConfig());
    this.modeLog.report([
      { monitor: MONITOR_NAME, enabled: config.enabled, dryRun: config.dryRun },
    ]);
  }

  /** Runs one sweep; null when another sweep is in flight. */
  async tick(): Promise<StallSweepReport | null> {
    if (this.sweepInFlight) return null;
    this.sweepInFlight = true;
    try {
      return await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<StallSweepReport> {
    this.reportMode();
    const config = resolveStalledAgentSweepConfig(this.options.readRemediationConfig());
    const nowMs = this.now();
    const report: StallSweepReport = { dryRun: config.dryRun, entries: [] };

    const agents = this.deps.listAgents();
    const running = agents.filter((agent) => agent.lifecycle === "running" && !agent.internal);
    const runningIds = new Set(running.map((agent) => agent.id));

    // Anything that left `running`, or the daemon, is no longer stalled.
    for (const [agentId, memory] of this.memory) {
      if (runningIds.has(agentId)) continue;
      this.memory.delete(agentId);
      const latest = agents.find((agent) => agent.id === agentId) ?? memory.agent;
      if (memory.episode) {
        await this.closeEpisode(report, latest, memory.episode, "left running");
      }
      if (memory.loop?.reported) await this.closeLoop(latest, memory.loop, "left running");
    }
    const idleWaits = await this.findIdleWaits(agents, config, nowMs);
    if (running.length === 0 && idleWaits.length === 0) return report;

    const idleChildren = idleChildrenOf(agents, idleWaits);
    const sample = await this.sampleProcessTrees(
      [
        ...runningIds,
        ...idleWaits.map((wait) => wait.agent.id),
        ...[...idleChildren.values()].flat().map((child) => child.id),
      ],
      nowMs,
    );
    if (!sample) {
      // Without the process tree a long build is indistinguishable from a stall; wait for `ps`.
      this.options.logger.warn("Stalled-agent sweep: no process sample; skipping this sweep");
      return report;
    }

    const healthByProvider = new Map<string, Promise<ProviderHealth>>();
    const readHealth = (provider: string) => {
      let health = healthByProvider.get(provider);
      if (!health) {
        health = this.deps.getProviderHealth(provider);
        healthByProvider.set(provider, health);
      }
      return health;
    };

    const candidates: StallCandidate[] = [];
    for (const agent of running) {
      const memory = this.observeSignals(agent, nowMs, config, {
        tree: sample.trees.get(agent.id),
        previousCpu: sample.previousCpu,
      });
      const candidate = await this.evaluate({ report, agent, memory, config, nowMs, readHealth });
      if (candidate) candidates.push(candidate);
    }

    // Longest stalled first: the budget goes to the agents that have waited longest.
    candidates.sort((a, b) => b.quietForMs - a.quietForMs);
    let budget = config.maxNudgesPerSweep;
    for (const candidate of candidates) {
      if (await this.handleCandidate(report, candidate, config, budget > 0)) budget -= 1;
    }
    await this.watchLoops(
      report,
      running,
      new Set(candidates.map((candidate) => candidate.agent.id)),
      nowMs,
    );
    await this.resumeIdleWaits({
      report,
      waits: idleWaits,
      idleChildren,
      sample,
      config,
      nowMs,
      budget,
      readHealth,
    });
    return report;
  }

  /** This sweep's process trees, CPU as a rate since the last sample; null when `ps` failed. */
  private async sampleProcessTrees(
    agentIds: string[],
    nowMs: number,
  ): Promise<{
    trees: Map<string, AgentProcessTree>;
    previousCpu: CpuRateMemory | undefined;
    rows: ProcessSampleRow[];
  } | null> {
    const rows = await this.deps.sampleProcesses();
    if (rows.length === 0) return null;
    const previousCpu = this.cpuRateMemory;
    const cpu = withRecentCpuPercent(rows, previousCpu, nowMs);
    this.cpuRateMemory = cpu.memory;
    const { agentTrees } = attributeProcessTrees(cpu.rows, agentIds);
    return {
      trees: new Map(agentTrees.map((tree) => [tree.agentId, tree])),
      previousCpu,
      rows: cpu.rows,
    };
  }

  /**
   * Continues an episode whose action was taken, closes one that no longer holds, and returns
   * the agent as a candidate when it is stalled and not yet acted on.
   */
  private async evaluate(input: {
    report: StallSweepReport;
    agent: StallSweepAgentSummary;
    memory: AgentStallMemory;
    config: ResolvedStalledAgentSweepConfig;
    nowMs: number;
    readHealth: (provider: string) => Promise<ProviderHealth>;
  }): Promise<StallCandidate | null> {
    const { report, agent, memory, config, nowMs } = input;
    const view = toView(agent);
    const signals = toSignals(memory);
    const quietForMs = nowMs - newestActivityAtMs(view, signals);
    const episode = memory.episode;

    if (episode?.acted) {
      // Resumed means the agent did something after the nudge; the stall thresholds no longer
      // apply. A permission or the janitor's question hands it to someone else.
      const settledAtMs = episode.acted.atMs + NUDGE_SETTLE_MS;
      const handedOver = view.pendingPermissionCount > 0 || view.quietTurn;
      if (handedOver || hasShownActivitySince(view, signals, settledAtMs)) {
        memory.episode = null;
        await this.closeEpisode(report, agent, episode, "shows activity again");
        return null;
      }
      episode.quietForMs = quietForMs;
      report.entries.push({
        agentId: agent.id,
        action: "still-stalled",
        detail: `no activity since the ${episode.acted.kind}`,
      });
      await this.observe(agent, episode, config, true);
      return null;
    }

    const minThresholdMs = Math.min(config.stallMinutes, config.deadAccountStallMinutes) * 60_000;
    const reason = notStalledReason({ view, signals, nowMs, thresholdMs: minThresholdMs });
    const health = reason === null ? await input.readHealth(agent.provider) : null;
    const thresholdMs =
      (health?.askable === false ? config.deadAccountStallMinutes : config.stallMinutes) * 60_000;
    if (health === null || quietForMs < thresholdMs) {
      if (episode) {
        memory.episode = null;
        await this.closeEpisode(report, agent, episode, "shows activity again");
      }
      return null;
    }
    return { agent, memory, quietForMs, health };
  }

  /** Opens or continues the episode and takes its one action if it can; true when it spent budget. */
  private async handleCandidate(
    report: StallSweepReport,
    candidate: StallCandidate,
    config: ResolvedStalledAgentSweepConfig,
    hasBudget: boolean,
  ): Promise<boolean> {
    const episode = (candidate.memory.episode ??= newEpisode(candidate));
    episode.quietForMs = candidate.quietForMs;
    episode.health = candidate.health;
    let spent = false;
    if (episode.exhausted) {
      // Its one attempt failed; the ladder has it.
    } else if (!config.enabled || config.dryRun) {
      this.reportInactiveMode(report, candidate, episode, config);
    } else if (!hasBudget) {
      episode.remedy = "live";
      report.entries.push({
        agentId: candidate.agent.id,
        action: "deferred",
        detail: "this sweep's nudge budget is spent; next sweep",
      });
    } else {
      episode.remedy = "live";
      const judged = await this.judgeCandidate(report, candidate, episode, config);
      if (judged.kind !== "hold") {
        await this.act(
          report,
          candidate,
          episode,
          config,
          judged.kind === "nudge" ? judged.line : null,
        );
        spent = true;
      }
    }
    await this.observe(candidate.agent, episode, config, true);
    return spent;
  }

  /**
   * Feature 10: what this episode's one judgment changes, asked on the live branch just before the
   * nudge. Only an `answered` judgment changes anything, and only inside what the sweep already
   * does: one more window before the nudge, a line in it, a person first on the ladder. A capped
   * account's handoff is never judged: failover owns it.
   */
  private async judgeCandidate(
    report: StallSweepReport,
    candidate: StallCandidate,
    episode: StallEpisode,
    config: ResolvedStalledAgentSweepConfig,
  ): Promise<StallJudgmentAction> {
    const { agent } = candidate;
    const nowMs = this.now();
    if (episode.hold) {
      if (nowMs < episode.hold.untilMs) {
        report.entries.push({
          agentId: agent.id,
          action: "held",
          detail: `a tool call is still running and JEV judged it progressing; nudging after ${new Date(episode.hold.untilMs).toISOString()}`,
        });
        return { kind: "hold" };
      }
      // Held once; now act as today even if JEV would say the same.
      return { kind: "today" };
    }
    const judge = this.deps.judgeStall;
    if (episode.judgment || !judge || !candidate.health.askable || !judge.isActive()) {
      return { kind: "today" };
    }
    const rows = this.readActivity(agent.id, STALL_JUDGMENT_READ_ROWS);
    if (!rows) return { kind: "today" };

    const judgment = await judge.judge({
      agentId: agent.id,
      branch: "candidate",
      title: agent.title,
      assignment: this.readAssignment(agent.id),
      quietMinutes: candidate.quietForMs / 60_000,
      rows,
    });
    const would = decideStallAction({
      answer: judgment.kind === "judged" ? judgment.answer : null,
      newestIsRunningTool: newestIsRunningTool(rows),
      alreadyHeld: false,
      repeatedStep: findLoop(rows)?.step ?? null,
    });
    const applied = judgment.kind === "judged" && judgment.applied;
    const action: StallJudgmentAction = applied ? would : { kind: "today" };
    episode.judgment = { callId: judgment.callId, summary: summarizeJudgment(judgment) };
    if (action.kind === "hold") {
      episode.hold = { startedAtMs: nowMs, untilMs: nowMs + config.stallMinutes * 60_000 };
      report.entries.push({
        agentId: agent.id,
        action: "held",
        detail: `a tool call is still running and JEV judged it progressing; one more ${config.stallMinutes}-minute window`,
      });
    }
    if (action.kind === "nudge") episode.personFirst = action.personFirst;
    this.recordJudgment({
      agent,
      branch: "candidate",
      episodeKey: stallEpisodeKey(agent.id),
      judgment,
      action: describeStallAction(action),
      wouldAction: describeStallAction(would),
      quietForMs: candidate.quietForMs,
    });
    this.options.logger.info(
      {
        agentId: agent.id,
        callId: judgment.callId,
        judgment: episode.judgment.summary,
        reason: judgment.kind === "none" ? judgment.reason : null,
        action: action.kind,
        would: would.kind,
      },
      "Stalled-agent sweep: judged a stall",
    );
    return action;
  }

  /** One JEV judgment's decision note and measurement line. */
  private recordJudgment(input: {
    agent: StallSweepAgentSummary;
    branch: StallJudgmentBranch;
    episodeKey: string;
    judgment: StallJudgment;
    action: string;
    wouldAction: string;
    quietForMs: number;
  }): void {
    const { agent, judgment } = input;
    const summary = summarizeJudgment(judgment);
    if (judgment.callId !== null) {
      this.deps.judgeStall?.record({
        agentId: agent.id,
        callId: judgment.callId,
        feature: "stallJudgment",
        question:
          input.branch === "candidate"
            ? "What is this stalled agent doing?"
            : "Is this running agent looping?",
        verdict: describeVerdict(judgment),
        confidence: summary?.confidence ?? null,
        action: summary?.applied ? input.action : `would have: ${input.wouldAction}`,
        applied: summary?.applied === true,
      });
    }
    this.measure({
      type: "judgment",
      at: new Date(this.now()).toISOString(),
      branch: input.branch,
      agentId: agent.id,
      episodeKey: input.episodeKey,
      callId: judgment.callId,
      judgment: summary,
      reason: judgment.kind === "none" ? judgment.reason : null,
      action: input.action,
      wouldAction: input.wouldAction,
      costUsd: judgment.costUsd,
      quietMinutes: Math.floor(input.quietForMs / 60_000),
    });
  }

  private measure(line: StallMeasurementLine): void {
    try {
      this.deps.recordMeasurement?.(line);
    } catch {
      // Measurement never breaks a sweep.
    }
  }

  private readActivity(agentId: string, limit: number): readonly AgentTimelineRow[] | null {
    try {
      return this.deps.readRecentActivity?.(agentId, limit) ?? null;
    } catch {
      return null;
    }
  }

  private readAssignment(agentId: string): string | null {
    try {
      return this.deps.readAssignment?.(agentId) ?? null;
    } catch {
      return null;
    }
  }

  // ─── The loop watch (feature 10) ───────────────────────────────────────────────────────────

  /**
   * Running agents that are not stall candidates, checked for a repeat in code; JEV is asked only
   * when the prefilter matches. Two `looping` answers in a row put the agent on the ladder as a
   * `looping-agent` notice for the digest. Nothing interrupts an agent on the loop watch's say-so.
   */
  private async watchLoops(
    report: StallSweepReport,
    running: StallSweepAgentSummary[],
    candidateIds: ReadonlySet<string>,
    nowMs: number,
  ): Promise<void> {
    const judge = this.deps.judgeStall;
    if (!judge || !this.deps.readRecentActivity) return;
    const watching = judge.isActive() && judge.loopWatchEnabled();
    let asked = 0;
    for (const agent of running) {
      const memory = this.memory.get(agent.id);
      // A stall is the candidate branch's; a permission or the janitor's question is someone else's.
      if (!memory || candidateIds.has(agent.id) || memory.episode) continue;
      if (!watching && !memory.loop?.reported) continue;
      if (agent.pendingPermissionCount > 0 || agent.quietTurn || agent.turnQueued) continue;
      const mayAsk = watching && asked < LOOP_WATCH_MAX_PER_SWEEP;
      if (await this.watchLoop({ report, agent, memory, judge, mayAsk, nowMs })) asked += 1;
    }
  }

  /** One agent's loop watch; true when it asked JEV. */
  private async watchLoop(input: {
    report: StallSweepReport;
    agent: StallSweepAgentSummary;
    memory: AgentStallMemory;
    judge: StallJudge;
    mayAsk: boolean;
    nowMs: number;
  }): Promise<boolean> {
    const { agent, memory, nowMs } = input;
    const rows = this.readActivity(agent.id, STALL_JUDGMENT_READ_ROWS);
    if (!rows) return false;
    const loop = (memory.loop ??= { signature: null, consecutive: 0, quiet: null, reported: null });
    const match = findLoop(rows);
    await this.followRepeat(agent, loop, match);
    if (!match) return false;
    if (loop.reported) {
      // Reported: the ladder hears it every sweep, and JEV is not asked again for this repeat.
      if (loop.reported.applied) {
        await this.options.sink.observe(buildLoopObservation(agent, loop.reported, true));
      }
      return false;
    }
    const quiet = loop.quiet?.signature === match.signature && nowMs < (loop.quiet?.untilMs ?? 0);
    if (!input.mayAsk || quiet) return false;

    const quietForMs = nowMs - newestActivityAtMs(toView(agent), toSignals(memory));
    const judgment = await input.judge.judge({
      agentId: agent.id,
      branch: "loop-watch",
      title: agent.title,
      assignment: this.readAssignment(agent.id),
      quietMinutes: quietForMs / 60_000,
      rows,
    });
    const { would, reported } = this.advanceLoop(loop, match, judgment, nowMs);
    const applied = judgment.kind === "judged" && judgment.applied;
    this.recordJudgment({
      agent,
      branch: "loop-watch",
      episodeKey: loopEpisodeKey(agent.id),
      judgment,
      action: applied ? would : "nothing",
      wouldAction: would,
      quietForMs,
    });
    if (reported) await this.reportLoop(input.report, agent, reported, nowMs);
    return true;
  }

  /** A repeat that stopped or changed ends the count, and the episode if one is open. */
  private async followRepeat(
    agent: StallSweepAgentSummary,
    loop: LoopWatchState,
    match: LoopMatch | null,
  ): Promise<void> {
    if (!match || match.signature !== loop.signature) {
      loop.consecutive = 0;
      if (loop.reported) {
        await this.closeLoop(agent, loop, match ? "the repeat changed" : "the repeat stopped");
      }
    }
    loop.signature = match?.signature ?? null;
  }

  private async reportLoop(
    report: StallSweepReport,
    agent: StallSweepAgentSummary,
    reported: NonNullable<LoopWatchState["reported"]>,
    nowMs: number,
  ): Promise<void> {
    report.entries.push({
      agentId: agent.id,
      action: "looping",
      detail: `${reported.step} x${reported.count}${reported.applied ? "" : " (shadow)"}`,
    });
    this.measure({
      type: "loop-reported",
      at: new Date(nowMs).toISOString(),
      agentId: agent.id,
      episodeKey: loopEpisodeKey(agent.id),
      applied: reported.applied,
      step: reported.step,
      count: reported.count,
    });
    if (reported.applied) {
      await this.options.sink.observe(buildLoopObservation(agent, reported, true));
    }
  }

  /**
   * Moves the loop watch on by one judgment. Returns what it would do, in words, and the episode
   * it opened, if it opened one.
   */
  private advanceLoop(
    loop: LoopWatchState,
    match: LoopMatch,
    judgment: StallJudgment,
    nowMs: number,
  ): { would: string; reported: LoopWatchState["reported"] } {
    if (judgment.kind !== "judged") return { would: "nothing", reported: null };
    const { activity, confidence } = judgment.answer;
    if (activity === "looping" && confidence >= LOOP_WATCH_FLOOR) {
      loop.consecutive += 1;
      if (loop.consecutive < LOOP_WATCH_CONSECUTIVE) {
        return { would: "wait for a second looping answer", reported: null };
      }
      loop.reported = {
        atMs: nowMs,
        step: match.step,
        count: match.count,
        applied: judgment.applied,
      };
      return {
        would: "report looping-agent to the ladder for the digest",
        reported: loop.reported,
      };
    }
    // Any other answer leaves this repeat alone for a while: asking again next sweep would get the
    // same answer and spend the control lane away-reply and remediation share.
    loop.consecutive = 0;
    loop.quiet = { signature: match.signature, untilMs: nowMs + LOOP_WATCH_QUIET_MS };
    return { would: "leave it for 30 minutes unless the repeat changes", reported: null };
  }

  private async closeLoop(
    agent: StallSweepAgentSummary,
    loop: LoopWatchState,
    why: string,
  ): Promise<void> {
    const reported = loop.reported;
    loop.reported = null;
    loop.quiet = null;
    if (!reported) return;
    const nowMs = this.now();
    this.measure({
      type: "loop-closed",
      at: new Date(nowMs).toISOString(),
      agentId: agent.id,
      episodeKey: loopEpisodeKey(agent.id),
      why,
      applied: reported.applied,
      minutesOpen: Math.floor((nowMs - reported.atMs) / 60_000),
    });
    if (reported.applied) {
      await this.options.sink.observe(buildLoopObservation(agent, reported, false, why));
    }
  }

  // ─── Idle agents waiting on background work ────────────────────────────────────────────────

  /**
   * Idle agents quiet for `BACKGROUND_WAIT_QUIET_MS` whose final turn is one of the two classes
   * (agent/background-wait.ts), with nothing that would wake them: no provider subagent, Paseo
   * child, schedule or restart-recovery resume. The process check needs `ps` and runs in
   * `resumeIdleWaits`. Records the outcome of an earlier line on the way.
   */
  private async findIdleWaits(
    agents: StallSweepAgentSummary[],
    config: ResolvedStalledAgentSweepConfig,
    nowMs: number,
  ): Promise<IdleWaitCandidate[]> {
    const present = new Set(agents.map((agent) => agent.id));
    for (const agentId of this.idleWaits.keys()) {
      if (!present.has(agentId)) this.idleWaits.delete(agentId);
    }
    if (!config.enabled || !this.deps.readRecentActivity || !this.deps.resumeIdleAgent) return [];
    for (const agent of agents) this.recordOutcome(agent);

    const protectedParents = this.findProtectedParents(agents);
    const quiet = agents.flatMap((agent) => {
      const quietForMs = idleQuietForMs(agent, protectedParents, nowMs);
      if (quietForMs === null) return [];
      if (this.idleWaits.get(agent.id)?.checkedActivityAt === agent.lastActivityAt) return [];
      if (this.isClaimedByRecovery(agent.id)) return [];
      return [{ agent, quietForMs }];
    });
    if (quiet.length === 0) return [];
    const scheduled = await this.listScheduledAgentIds();
    // Cannot tell which agents a schedule wakes: look again next sweep.
    if (!scheduled) return [];

    const waits: IdleWaitCandidate[] = [];
    for (const { agent, quietForMs } of quiet) {
      // A schedule or heartbeat wakes it; the next check is after it does.
      const candidate = scheduled.has(agent.id) ? null : this.readIdleWait(agent, quietForMs);
      if (candidate) waits.push(candidate);
      else this.markIdleChecked(agent);
    }
    return waits;
  }

  /**
   * Parents something will wake, keyed by every id they answer to: each parent label is followed
   * through `migrated-to` to the successor that carries its work (docs/account-failover.md). A
   * child wakes its parent while it runs, while restart recovery is about to resume it, and while
   * a provider subagent it started runs; an idle child with a live shell is checked after `ps`.
   */
  private findProtectedParents(agents: readonly StallSweepAgentSummary[]): Set<string> {
    const successors = successorsOf(agents);
    const parents = new Set<string>();
    for (const agent of agents) {
      const parentId = getParentAgentIdFromLabels(agent.labels);
      if (parentId === null) continue;
      const wakes =
        agent.lifecycle === "running" ||
        agent.busy ||
        agent.runningProviderSubagentCount > 0 ||
        this.isClaimedByRecovery(agent.id);
      if (!wakes) continue;
      for (const id of followSuccessors(parentId, successors)) parents.add(id);
    }
    return parents;
  }

  private isClaimedByRecovery(agentId: string): boolean {
    try {
      return this.deps.isClaimedByRestartRecovery?.(agentId) === true;
    } catch {
      // Cannot tell: leave it to recovery.
      return true;
    }
  }

  private async listScheduledAgentIds(): Promise<ReadonlySet<string> | null> {
    try {
      return (await this.deps.listScheduledAgentIds?.()) ?? new Set();
    } catch {
      return null;
    }
  }

  /** The agent's final turn as one of the two classes, or null when it is neither. */
  private readIdleWait(
    agent: StallSweepAgentSummary,
    quietForMs: number,
  ): IdleWaitCandidate | null {
    try {
      // A failed last turn is not a wait, and a limit failure is account failover's: a prompt row
      // would re-date it.
      if (this.deps.readLastError?.(agent.id)) return null;
    } catch {
      return null;
    }
    const rows = this.readActivity(agent.id, BACKGROUND_WAIT_READ_ROWS);
    const message = rows ? readFinalMessage(rows) : null;
    if (!rows || !message) return null;
    const work = readFinalTurnWork(rows);
    // A wakeup, schedule or heartbeat it set up will wake it.
    if (work.watcher) return null;
    const wait = findBackgroundWait(message.text);
    const external = findExternalWait(message.text);
    const base = { agent, quietForMs, seq: message.seq };
    if (work.launched.length > 0 && (wait ?? external)) {
      const quote = (wait ?? external)?.quote ?? "";
      return { ...base, waitClass: "own-work", quote, launched: work.launched, target: null };
    }
    if (work.launched.length === 0 && external) {
      return {
        ...base,
        waitClass: "external-wait",
        quote: external.quote,
        launched: [],
        target: external.target,
      };
    }
    return null;
  }

  private markIdleChecked(agent: StallSweepAgentSummary): IdleWaitMemory {
    const memory = this.idleWaits.get(agent.id) ?? {
      checkedActivityAt: null,
      resumes: [],
      pendingOutcome: null,
    };
    memory.checkedActivityAt = agent.lastActivityAt;
    this.idleWaits.set(agent.id, memory);
    return memory;
  }

  /**
   * Records what came of a `resumed` or `would-resume` line once the agent is idle again after
   * new activity: whether the next turn did tool work or waited again, and how long until it went
   * idle. Measured for both, so the rule's precision can be read before `BACKGROUND_WAIT_LIVE`
   * is flipped: a would-resume the agent sat on is a resume it needed.
   */
  private recordOutcome(agent: StallSweepAgentSummary): void {
    const memory = this.idleWaits.get(agent.id);
    const pending = memory?.pendingOutcome;
    if (!memory || !pending) return;
    if (agent.lifecycle !== "idle" || agent.busy) return;
    const lastActivityAtMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : Number.NaN;
    if (!Number.isFinite(lastActivityAtMs) || lastActivityAtMs <= pending.atMs) return;
    memory.pendingOutcome = null;
    const rows = (this.readActivity(agent.id, BACKGROUND_WAIT_READ_ROWS) ?? []).filter(
      (row) => row.seq > pending.seq,
    );
    const firstPrompt = rows.find((row) => row.item.type === "user_message")?.item;
    const final = readFinalMessage(rows);
    this.measure({
      type: "background-wait-outcome",
      at: new Date(this.now()).toISOString(),
      agentId: agent.id,
      waitClass: pending.waitClass,
      resumed: pending.resumed,
      woke: describeWake(firstPrompt),
      toolWork: rows.some((row) => row.item.type === "tool_call"),
      rewaited:
        final !== null &&
        (findBackgroundWait(final.text) !== null || findExternalWait(final.text) !== null),
      minutesToNextIdle: Math.floor((lastActivityAtMs - pending.atMs) / 60_000),
    });
  }

  /**
   * Records each idle wait with nothing left running under it, and resumes it when the rule is
   * live (`BACKGROUND_WAIT_LIVE`, and not a dry run). Live: one prompt per final message, at most
   * `MAX_BACKGROUND_WAIT_RESUMES_PER_DAY` per agent, out of the sweep's remaining nudge budget.
   */
  private async resumeIdleWaits(input: {
    report: StallSweepReport;
    waits: IdleWaitCandidate[];
    idleChildren: ReadonlyMap<string, StallSweepAgentSummary[]>;
    sample: { trees: Map<string, AgentProcessTree>; rows: ProcessSampleRow[] };
    config: ResolvedStalledAgentSweepConfig;
    nowMs: number;
    budget: number;
    readHealth: (provider: string) => Promise<ProviderHealth>;
  }): Promise<void> {
    const { report, sample, config, nowMs } = input;
    const resume = this.deps.resumeIdleAgent;
    if (!resume) return;
    const live = this.backgroundWaitLive && !config.dryRun;
    let remaining = input.budget;
    for (const wait of input.waits) {
      const { agent } = wait;
      const tree = sample.trees.get(agent.id);
      if (!tree && this.sessionFamilyOf(agent) !== "claude") {
        // Codex's app-server and OpenCode's shared server carry no agent id, so nothing under
        // them can be seen. Claude's root always can: no tree means no process.
        this.markIdleChecked(agent);
        continue;
      }
      // Still running under it, or under an idle child of it: the wait is real. Next sweep.
      const liveShells = [agent, ...(input.idleChildren.get(agent.id) ?? [])].some((owner) => {
        const rootPid = sample.trees.get(owner.id)?.pids[0];
        return rootPid !== undefined && findBackgroundShells(sample.rows, rootPid).length > 0;
      });
      if (liveShells) continue;
      // A resume into a capped account fails at once and hands failover an agent nobody needed
      // to run. Checked again next sweep.
      if ((await input.readHealth(agent.provider)).askable === false) continue;

      const line = (action: string, detail: string | null) =>
        this.measure({
          type: "background-wait",
          at: new Date(nowMs).toISOString(),
          agentId: agent.id,
          waitClass: wait.waitClass,
          action,
          quietMinutes: Math.floor(wait.quietForMs / 60_000),
          quote: wait.quote,
          launched: wait.launched,
          target: wait.target,
          detail,
        });
      const pending = (resumed: boolean): PendingOutcome => ({
        atMs: nowMs,
        seq: wait.seq,
        waitClass: wait.waitClass,
        resumed,
      });
      if (!live) {
        this.markIdleChecked(agent).pendingOutcome = pending(false);
        report.entries.push({
          agentId: agent.id,
          action: "would-resume-idle",
          detail: `${wait.waitClass}: ${wait.quote}`,
        });
        line("would-resume", null);
        continue;
      }
      if (remaining <= 0) continue;
      const memory = this.markIdleChecked(agent);
      memory.resumes = memory.resumes.filter((at) => at > nowMs - DAY_MS);
      if (memory.resumes.length >= MAX_BACKGROUND_WAIT_RESUMES_PER_DAY) {
        line("capped", `${memory.resumes.length} resumes in the last day`);
        this.options.logger.info(
          { agentId: agent.id, resumes: memory.resumes.length },
          "Stalled-agent sweep: an idle agent is waiting on background work again; not resuming it",
        );
        continue;
      }
      remaining -= 1;
      const prompt = formatSystemNotificationPrompt(
        wait.waitClass === "own-work"
          ? buildBackgroundWaitPrompt({
              quietForMs: wait.quietForMs,
              quote: wait.quote,
              launched: wait.launched,
            })
          : buildExternalWaitPrompt({
              quietForMs: wait.quietForMs,
              quote: wait.quote,
              target: wait.target ?? "it",
            }),
      );
      let result: IdleResumeResult;
      try {
        result = await resume({ agentId: agent.id, prompt });
      } catch (error) {
        result = { kind: "failed", error: errorMessage(error) };
      }
      if (result.kind === "sent") {
        memory.resumes.push(nowMs);
        memory.pendingOutcome = pending(true);
        report.entries.push({
          agentId: agent.id,
          action: "resumed-idle",
          detail: `${wait.waitClass}: ${wait.quote}`,
        });
      }
      line(result.kind === "sent" ? "resumed" : result.kind, describeIdleResume(result));
      this.options.logger.info(
        {
          agentId: agent.id,
          waitClass: wait.waitClass,
          quietForMs: wait.quietForMs,
          result: result.kind,
        },
        "Stalled-agent sweep: resumed an idle agent nothing would wake",
      );
    }
  }

  private sessionFamilyOf(agent: StallSweepAgentSummary): string {
    try {
      return this.deps.readSessionFamily?.(agent.id) ?? agent.provider;
    } catch {
      return agent.provider;
    }
  }

  private observeSignals(
    agent: StallSweepAgentSummary,
    nowMs: number,
    config: ResolvedStalledAgentSweepConfig,
    process: {
      tree: { cpuPercent: number; pids: number[] } | undefined;
      previousCpu: CpuRateMemory | undefined;
    },
  ): AgentStallMemory {
    const existing = this.memory.get(agent.id);
    const memory: AgentStallMemory = existing ?? {
      firstSeenRunningAtMs: nowMs,
      usage: recordUsage(undefined, agent.usageFingerprint, nowMs),
      cpu: { cpuBusyAtMs: null, idleCpuSamples: 0 },
      episode: null,
      agent,
      loop: null,
    };
    if (existing) memory.usage = recordUsage(existing.usage, agent.usageFingerprint, nowMs);
    memory.agent = agent;
    // No attributable process is an idle reading, as in the resource monitor: nothing is running
    // that could be doing the work. A tree whose root is new this sweep carries ps's lifetime
    // average and proves nothing either way.
    const rootPid = process.tree?.pids[0];
    const sample = process.tree
      ? {
          cpuPercent: process.tree.cpuPercent,
          rateBased: rootPid !== undefined && process.previousCpu?.has(rootPid) === true,
        }
      : { cpuPercent: 0, rateBased: process.previousCpu !== undefined };
    memory.cpu = recordCpuSample(memory.cpu, sample, config.idleCpuPercent, nowMs);
    this.memory.set(agent.id, memory);
    return memory;
  }

  private async act(
    report: StallSweepReport,
    candidate: StallCandidate,
    episode: StallEpisode,
    config: ResolvedStalledAgentSweepConfig,
    judgmentLine: string | null,
  ): Promise<void> {
    const { agent } = candidate;
    const { logger } = this.options;
    const capped = !candidate.health.askable;

    const snapshot = config.snapshot
      ? await this.deps.snapshotter.snapshot({
          cwd: agent.cwd,
          reason: `stalled agent ${agent.id} before a ${capped ? "failover handoff" : "resume nudge"}`,
        })
      : null;
    episode.snapshot = snapshot;
    episode.attempts.push(describeSnapshot(snapshot, this.now()));

    if (capped) {
      const result = await this.deps.handOffToFailover(agent.id);
      const at = new Date(this.now()).toISOString();
      if (result.kind === "failed") {
        episode.exhausted = true;
        episode.remedy = "none";
        episode.attempts.push({
          remedy: "handoff",
          outcome: "failed",
          detail: `could not cancel the stuck turn for account failover: ${result.error}`,
          at,
        });
        report.entries.push({ agentId: agent.id, action: "cannot-nudge", detail: result.error });
      } else {
        episode.acted = { kind: "handoff", atMs: this.now() };
        episode.attempts.push({
          remedy: "handoff",
          outcome: result.kind === "handed-off" ? "acted" : "nothing-to-do",
          detail:
            result.kind === "handed-off"
              ? `canceled the stuck turn with a usage-limit error so account failover moves it off ${agent.provider}`
              : "the turn ended on its own before the cancel",
          at,
        });
        report.entries.push({ agentId: agent.id, action: "handed-off", detail: agent.provider });
      }
      logger.info(
        { agentId: agent.id, provider: agent.provider, result: result.kind },
        "Stalled-agent sweep: handed a stalled agent on a capped account to account failover",
      );
      return;
    }

    const prompt = formatSystemNotificationPrompt(
      buildStallNudgePrompt({
        quietForMs: candidate.quietForMs,
        provider: agent.provider,
        snapshot,
        snapshotsEnabled: config.snapshot,
        judgmentLine,
      }),
    );
    const result = await this.deps.nudgeAgent({ agentId: agent.id, prompt });
    const at = new Date(this.now()).toISOString();
    if (result.kind === "failed") {
      episode.exhausted = true;
      episode.remedy = "none";
      episode.attempts.push({
        remedy: "nudge",
        outcome: "failed",
        detail: `could not replace the stuck run or reload the session: ${result.error}`,
        at,
      });
      report.entries.push({ agentId: agent.id, action: "cannot-nudge", detail: result.error });
    } else {
      episode.acted = { kind: "nudge", atMs: this.now() };
      episode.attempts.push({
        remedy: "nudge",
        outcome: "acted",
        detail:
          result.via === "reload"
            ? "reloaded the session and sent one resume prompt"
            : "replaced the stuck run with one resume prompt",
        at,
      });
      report.entries.push({ agentId: agent.id, action: "nudged", detail: result.via });
    }
    logger.info(
      {
        agentId: agent.id,
        provider: agent.provider,
        quietForMs: candidate.quietForMs,
        result: result.kind,
        snapshot: snapshot?.kind ?? "off",
      },
      "Stalled-agent sweep: nudged a stalled agent",
    );
  }

  private reportInactiveMode(
    report: StallSweepReport,
    candidate: StallCandidate,
    episode: StallEpisode,
    config: ResolvedStalledAgentSweepConfig,
  ): void {
    episode.remedy = config.enabled ? "dry-run" : "disabled";
    const action = candidate.health.askable ? "would-nudge" : "would-hand-off";
    const detail = `stalled for ${formatDuration(candidate.quietForMs)} (${episode.remedy})`;
    report.entries.push({ agentId: candidate.agent.id, action, detail });
    if (episode.reportedInactiveMode) return;
    episode.reportedInactiveMode = true;
    this.options.logger.info(
      {
        agentId: candidate.agent.id,
        action,
        remedy: episode.remedy,
        quietForMs: candidate.quietForMs,
      },
      "Stalled-agent sweep (not acting)",
    );
  }

  private async closeEpisode(
    report: StallSweepReport,
    agent: StallSweepAgentSummary,
    episode: StallEpisode,
    why: string,
  ): Promise<void> {
    report.entries.push({ agentId: agent.id, action: "resumed", detail: why });
    const config = resolveStalledAgentSweepConfig(this.options.readRemediationConfig());
    const nowMs = this.now();
    const sinceActMs = episode.acted ? nowMs - episode.acted.atMs : null;
    this.measure({
      type: "episode-closed",
      at: new Date(nowMs).toISOString(),
      branch: "candidate",
      agentId: agent.id,
      episodeKey: stallEpisodeKey(agent.id),
      why,
      acted: episode.acted?.kind ?? null,
      minutesAfterAct: sinceActMs === null ? null : Math.floor(sinceActMs / 60_000),
      pastRecheck: sinceActMs !== null && sinceActMs >= config.recheckMinutes * 60_000,
      held: episode.hold !== null,
      closedDuringHold: episode.hold !== null && episode.acted === null,
      judgment: episode.judgment?.summary ?? null,
      personFirst: episode.personFirst !== null,
    });
    await this.observe(agent, episode, config, false, why);
  }

  private async observe(
    agent: StallSweepAgentSummary,
    episode: StallEpisode,
    config: ResolvedStalledAgentSweepConfig,
    active: boolean,
    closedBecause?: string,
  ): Promise<void> {
    await this.options.sink.observe(
      buildStallObservation({ agent, episode, config, active, closedBecause }),
    );
  }
}

function newEpisode(candidate: StallCandidate): StallEpisode {
  return {
    remedy: "live",
    attempts: [],
    snapshot: null,
    acted: null,
    exhausted: false,
    reportedInactiveMode: false,
    quietForMs: candidate.quietForMs,
    health: candidate.health,
    judgment: null,
    hold: null,
    personFirst: null,
  };
}

function toView(agent: StallSweepAgentSummary): StallAgentView {
  const lastActivityAtMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : Number.NaN;
  return {
    lifecycle: agent.lifecycle,
    internal: agent.internal,
    pendingPermissionCount: agent.pendingPermissionCount,
    quietTurn: agent.quietTurn,
    turnQueued: agent.turnQueued === true,
    lastActivityAtMs: Number.isFinite(lastActivityAtMs) ? lastActivityAtMs : null,
    runningSubagentActivityAtMs: agent.runningSubagentActivityAt
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value)),
  };
}

function toSignals(memory: AgentStallMemory): StallSignals {
  return {
    firstSeenRunningAtMs: memory.firstSeenRunningAtMs,
    usageChangedAtMs: memory.usage.usageChangedAtMs,
    cpuBusyAtMs: memory.cpu.cpuBusyAtMs,
    idleCpuSamples: memory.cpu.idleCpuSamples,
  };
}

function describeSnapshot(snapshot: WorktreeSnapshotResult | null, nowMs: number): RemedyAttempt {
  const at = new Date(nowMs).toISOString();
  if (!snapshot) {
    return { remedy: "snapshot", outcome: "skipped", detail: "snapshots are off", at };
  }
  switch (snapshot.kind) {
    case "snapshotted":
      return {
        remedy: "snapshot",
        outcome: "acted",
        detail: `saved ${snapshot.dirtyFiles} changed file(s) and ${snapshot.unpushedCommits} unpushed commit(s) to ${snapshot.ref} at ${snapshot.commit}`,
        at,
      };
    case "nothing-at-risk":
      return {
        remedy: "snapshot",
        outcome: "nothing-to-do",
        detail: "the worktree had nothing uncommitted or unpushed",
        at,
      };
    case "failed":
      return { remedy: "snapshot", outcome: "failed", detail: snapshot.error, at };
  }
}

function describeSnapshotForAgent(
  snapshot: WorktreeSnapshotResult | null,
  snapshotsEnabled: boolean,
): string {
  if (!snapshotsEnabled || !snapshot) return "No snapshot of your worktree was taken.";
  switch (snapshot.kind) {
    case "snapshotted":
      return `Before this, it saved your worktree's uncommitted and unpushed work to ${snapshot.ref} (commit ${snapshot.commit}) without touching your checkout, index or HEAD.`;
    case "nothing-at-risk":
      return "Your worktree had nothing uncommitted or unpushed, so there was nothing to snapshot.";
    case "failed":
      return `It tried to snapshot your worktree first and could not: ${snapshot.error}.`;
  }
}

/** The one resume prompt a stalled agent on a usable account gets, before its envelope. */
export function buildStallNudgePrompt(input: {
  quietForMs: number;
  provider: string;
  snapshot: WorktreeSnapshotResult | null;
  snapshotsEnabled: boolean;
  /** Feature 10: one line from the stall judgment, when an answered judgment adds one. */
  judgmentLine?: string | null;
}): string {
  const minutes = Math.floor(input.quietForMs / 60_000);
  return [
    `The Paseo daemon saw no activity from you for ${minutes} minutes while your turn was still running, and your account (${input.provider}) is healthy, so it stopped the stalled turn and sent this message instead.`,
    describeSnapshotForAgent(input.snapshot, input.snapshotsEnabled),
    "Resume from where you left off. If you are waiting on something (a person, another agent, a build, a service), say what you are waiting on.",
    input.judgmentLine ?? null,
  ]
    .filter((paragraph): paragraph is string => Boolean(paragraph))
    .join("\n\n");
}

function agentName(agent: StallSweepAgentSummary): string {
  return agent.title?.trim() ? `"${agent.title.trim()}"` : `agent ${agent.id.slice(0, 8)}`;
}

function buildStallObservation(input: {
  agent: StallSweepAgentSummary;
  episode: StallEpisode;
  config: ResolvedStalledAgentSweepConfig;
  active: boolean;
  closedBecause?: string;
}): RemediationObservation {
  const { agent, episode, config, active } = input;
  const name = agentName(agent);
  const capped = !episode.health.askable;
  const accountLine = episode.health.askable
    ? `Its account (${agent.provider}) is usable.`
    : `Its account (${agent.provider}) is not usable: ${episode.health.reason}.`;
  const summary = active
    ? `${name} has sat in running for ${formatDuration(episode.quietForMs)} with no timeline, token or CPU activity. ${accountLine}`
    : `${name} ${input.closedBecause ?? "is no longer stalled"}.`;
  const snapshotRef = episode.snapshot?.kind === "snapshotted" ? episode.snapshot.ref : null;
  const evidence = [
    `agent: ${agent.id} (${agent.provider})`,
    `cwd: ${agent.cwd}`,
    `last activity the daemon holds: ${agent.lastActivityAt ?? "none"}`,
    `running provider subagents: ${agent.runningProviderSubagentCount}`,
    accountLine,
    snapshotRef ? `snapshot: ${snapshotRef}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const recovery = snapshotRef
    ? `A snapshot of its worktree exists at ${snapshotRef}.`
    : "No snapshot of its worktree exists, so do not discard anything in it.";
  // A `progressing` hold moves the nudge later; the ladder adds it to the grace, an override's
  // included, so its recheck still starts from the nudge.
  const holdMs = episode.hold ? episode.hold.untilMs - episode.hold.startedAtMs : 0;
  return {
    key: stallEpisodeKey(agent.id),
    kind: "stalled-agent",
    active,
    remedy: episode.remedy,
    title: `Stalled agent: ${name}`,
    summary,
    evidence,
    attempts: [...episode.attempts],
    graceMs: config.recheckMinutes * 60_000,
    ...(holdMs > 0 ? { holdMs } : {}),
    level: "alert",
    escalation: {
      task: [
        `Agent ${agent.id} (${name}) is stuck in running despite ${capped ? "a handoff to account failover" : "a resume nudge"}.`,
        `Check its process tree, the provider's logs and its account (${agent.provider}).`,
        `Recover it without losing work. ${recovery}`,
        "If you cannot recover it, say what it needs.",
      ].join(" "),
      cwd: agent.cwd,
      taskClass: "standard",
      ...(episode.personFirst ? { personFirst: episode.personFirst } : {}),
    },
    link: { agentId: agent.id, workspaceId: agent.workspaceId },
  };
}

function stallEpisodeKey(agentId: string): string {
  return `stalled-agent:${agentId}`;
}

function loopEpisodeKey(agentId: string): string {
  return `looping-agent:${agentId}`;
}

function describeVerdict(judgment: StallJudgment): string {
  if (judgment.kind === "none") return judgment.reason;
  return `${judgment.answer.activity} (${judgment.answer.confidence.toFixed(2)})`;
}

/** What started the turn after a background-wait line: the resume, another prompt, or itself. */
function describeWake(firstPrompt: AgentTimelineItem | undefined): "resume" | "prompt" | "self" {
  if (firstPrompt?.type !== "user_message") return "self";
  return BACKGROUND_WAIT_PROMPT_MARK.test(firstPrompt.text) ? "resume" : "prompt";
}

function describeIdleResume(result: IdleResumeResult): string | null {
  switch (result.kind) {
    case "sent":
      return null;
    case "skipped":
      return result.reason;
    case "failed":
      return result.error;
  }
}

/**
 * How long an idle agent has been quiet, when nothing may wake it: idle and quiet past
 * `BACKGROUND_WAIT_QUIET_MS`, not busy, not internal, no permission or janitor question, no
 * provider subagent, no child that wakes it, and not retired by account failover (its successor
 * carries the work). Null otherwise.
 */
function idleQuietForMs(
  agent: StallSweepAgentSummary,
  protectedParents: ReadonlySet<string>,
  nowMs: number,
): number | null {
  if (agent.lifecycle !== "idle" || agent.internal || agent.busy || agent.quietTurn) return null;
  if (agent.pendingPermissionCount > 0 || agent.turnQueued) return null;
  if (agent.runningProviderSubagentCount > 0 || protectedParents.has(agent.id)) return null;
  if (agent.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL]) return null;
  const lastActivityAtMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : Number.NaN;
  if (!Number.isFinite(lastActivityAtMs)) return null;
  const quietForMs = nowMs - lastActivityAtMs;
  return quietForMs >= BACKGROUND_WAIT_QUIET_MS ? quietForMs : null;
}

/** Each retired agent's `migrated-to` successor. */
function successorsOf(agents: readonly StallSweepAgentSummary[]): Map<string, string> {
  const successors = new Map<string, string>();
  for (const agent of agents) {
    const successor = agent.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL];
    if (successor) successors.set(agent.id, successor);
  }
  return successors;
}

/** `agentId` and every successor down its `migrated-to` chain. */
function followSuccessors(agentId: string, successors: ReadonlyMap<string, string>): string[] {
  const chain: string[] = [];
  let current: string | undefined = agentId;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    current = successors.get(current);
  }
  return chain;
}

/** Each idle wait's idle children, through `migrated-to`: their live shells count as its own. */
function idleChildrenOf(
  agents: readonly StallSweepAgentSummary[],
  waits: readonly IdleWaitCandidate[],
): Map<string, StallSweepAgentSummary[]> {
  const waitIds = new Set(waits.map((wait) => wait.agent.id));
  const successors = successorsOf(agents);
  const children = new Map<string, StallSweepAgentSummary[]>();
  for (const agent of agents) {
    const parentId = getParentAgentIdFromLabels(agent.labels);
    if (parentId === null || agent.lifecycle !== "idle") continue;
    for (const id of followSuccessors(parentId, successors)) {
      if (!waitIds.has(id)) continue;
      const list = children.get(id) ?? [];
      list.push(agent);
      children.set(id, list);
    }
  }
  return children;
}

function summarizeJudgment(judgment: StallJudgment): StallJudgmentSummary | null {
  return judgment.kind === "judged"
    ? {
        activity: judgment.answer.activity,
        confidence: judgment.answer.confidence,
        applied: judgment.applied,
      }
    : null;
}

/**
 * The loop watch's report (docs/jev.md, "The loop watch"): no remedy, no agent, a `notice` a person
 * gets in the digest. The ladder closes it when the repeat stops.
 */
function buildLoopObservation(
  agent: StallSweepAgentSummary,
  reported: { step: string; count: number },
  active: boolean,
  closedBecause?: string,
): RemediationObservation {
  const name = agentName(agent);
  return {
    key: loopEpisodeKey(agent.id),
    kind: "looping-agent",
    active,
    remedy: "none",
    title: `Looping agent: ${name}`,
    summary: active
      ? `${name} repeated ${reported.step} ${reported.count} times in its last tool calls, and JEV judged it looping on two sweeps in a row. Nothing interrupted it.`
      : `${name}: ${closedBecause ?? "the repeat stopped"}.`,
    evidence: [
      `agent: ${agent.id} (${agent.provider})`,
      `cwd: ${agent.cwd}`,
      `repeated: ${reported.step} x${reported.count}`,
    ].join("\n"),
    attempts: [],
    graceMs: 0,
    level: "notice",
    link: { agentId: agent.id, workspaceId: agent.workspaceId },
  };
}

// ─── Production wiring ───────────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The production nudge: send the prompt through the one send path, which replaces the stuck run.
 * When the cancel inside that replace is refused (a dead session never settles), reload the
 * session and send again. Not a quiet turn: the resumed work finishing is a real finish.
 */
export async function nudgeStalledAgent(
  deps: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger: Logger;
    /**
     * The daemon's shared ResumePacer: a sweep that finds several stalled agents after a bad hour
     * restarts them a few a minute. The sweep waits, and skips ticks while it does.
     */
    paceResume?: PaceResume;
  },
  input: { agentId: string; prompt: string },
): Promise<StallNudgeResult> {
  const paceResume = deps.paceResume ?? unpacedResume;
  return await paceResume(
    pacedResume(input.agentId, deps.agentManager.getAgent(input.agentId)?.labels, "stall-nudge"),
    () => nudgeNow(deps, input),
  );
}

async function nudgeNow(
  deps: { agentManager: AgentManager; agentStorage: AgentStorage; logger: Logger },
  input: { agentId: string; prompt: string },
): Promise<StallNudgeResult> {
  const { agentManager, agentStorage, logger } = deps;
  const send = () =>
    sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: input.agentId,
      prompt: input.prompt,
      messageId: randomUUID(),
      // The one daemon prompt that replaces a turn on purpose: the turn is dead (no activity for
      // stallMinutes, an idle process tree), and a steer would join it or wait behind it forever.
      // Idle CPU is also why no background workflow is lost.
      activeTurnBehavior: "interrupt",
      unarchive: false,
      logger,
    });
  try {
    await send();
    return { kind: "sent", via: "replace" };
  } catch (replaceError) {
    logger.warn(
      { err: replaceError, agentId: input.agentId },
      "Stalled-agent sweep: replacing the stuck run failed; reloading the session",
    );
    try {
      await agentManager.reloadAgentSession(input.agentId);
      await send();
      return { kind: "sent", via: "reload" };
    } catch (reloadError) {
      return {
        kind: "failed",
        error: `replace: ${errorMessage(replaceError)}; reload: ${errorMessage(reloadError)}`,
      };
    }
  }
}

/** The production handoff: an `account-capped` cancel, checked for the error failover reads. */
export async function handOffStalledAgentToFailover(
  agentManager: Pick<AgentManager, "cancelAgentRun" | "getAgent">,
  agentId: string,
): Promise<StallHandoffResult> {
  try {
    const result = await agentManager.cancelAgentRun(agentId, "account-capped");
    if (result.status === "not_running") return { kind: "not-running" };
    if (result.status === "refused") {
      return { kind: "failed", error: "the provider session did not acknowledge the cancel" };
    }
    const lastError = agentManager.getAgent(agentId)?.lastError;
    if (!isLimitShapedError(lastError)) {
      return { kind: "failed", error: "the cancel settled but left no usage-limit error" };
    }
    return { kind: "handed-off", lastError };
  } catch (error) {
    return { kind: "failed", error: errorMessage(error) };
  }
}

/**
 * The production resume for an idle agent waiting on background work: one prompt through the one
 * send path, paced like a stall nudge. It steers rather than interrupts, so an agent that started
 * a turn in the meantime is never cut off; one that is no longer idle, or is archived, is skipped.
 * Not a quiet turn: the resumed work finishing is a real finish.
 */
export async function resumeIdleAgentWaitingOnBackground(
  deps: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger: Logger;
    paceResume?: PaceResume;
  },
  input: { agentId: string; prompt: string },
): Promise<IdleResumeResult> {
  const { agentManager, agentStorage, logger } = deps;
  const paceResume = deps.paceResume ?? unpacedResume;
  return await paceResume(
    pacedResume(input.agentId, agentManager.getAgent(input.agentId)?.labels, "background-wait"),
    async (): Promise<IdleResumeResult> => {
      if (agentManager.getAgent(input.agentId)?.lifecycle !== "idle") {
        return { kind: "skipped", reason: "no longer idle" };
      }
      try {
        const record = await agentStorage.get(input.agentId);
        if (record?.archivedAt) return { kind: "skipped", reason: "archived" };
        // A turn that started during the read would get this prompt steered into it.
        if (agentManager.getAgent(input.agentId)?.lifecycle !== "idle") {
          return { kind: "skipped", reason: "no longer idle" };
        }
        await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId: input.agentId,
          prompt: input.prompt,
          messageId: randomUUID(),
          activeTurnBehavior: "steer",
          unarchive: false,
          logger,
        });
        return { kind: "sent" };
      } catch (error) {
        return { kind: "failed", error: errorMessage(error) };
      }
    },
  );
}
