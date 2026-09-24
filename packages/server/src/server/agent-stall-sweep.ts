import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { AgentManager, StallSweepAgentSummary } from "./agent/agent-manager.js";
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
}

export interface AgentStallSweepOptions {
  dependencies: StallSweepDependencies;
  sink: RemediationSink;
  readRemediationConfig: () => RemediationConfig | undefined;
  logger: Logger;
  sweepIntervalMs?: number;
  now?: () => number;
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
    | "resumed";
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
}

interface AgentStallMemory {
  firstSeenRunningAtMs: number;
  usage: UsageSignal;
  cpu: CpuSignal;
  episode: StallEpisode | null;
  /** The last summary seen, so an episode can still be closed once the agent is gone. */
  agent: StallSweepAgentSummary;
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

  constructor(options: AgentStallSweepOptions) {
    this.options = options;
    this.deps = options.dependencies;
    this.now = options.now ?? Date.now;
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
      if (memory.episode) {
        const latest = agents.find((agent) => agent.id === agentId) ?? memory.agent;
        await this.closeEpisode(report, latest, memory.episode, "left running");
      }
    }
    if (running.length === 0) return report;

    const sample = await this.sampleProcessTrees([...runningIds], nowMs);
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
    return report;
  }

  /** This sweep's process trees, CPU as a rate since the last sample; null when `ps` failed. */
  private async sampleProcessTrees(
    agentIds: string[],
    nowMs: number,
  ): Promise<{
    trees: Map<string, AgentProcessTree>;
    previousCpu: CpuRateMemory | undefined;
  } | null> {
    const rows = await this.deps.sampleProcesses();
    if (rows.length === 0) return null;
    const previousCpu = this.cpuRateMemory;
    const cpu = withRecentCpuPercent(rows, previousCpu, nowMs);
    this.cpuRateMemory = cpu.memory;
    const { agentTrees } = attributeProcessTrees(cpu.rows, agentIds);
    return { trees: new Map(agentTrees.map((tree) => [tree.agentId, tree])), previousCpu };
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
      await this.act(report, candidate, episode, config);
      spent = true;
    }
    await this.observe(candidate.agent, episode, config, true);
    return spent;
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
  };
}

function toView(agent: StallSweepAgentSummary): StallAgentView {
  const lastActivityAtMs = agent.lastActivityAt ? Date.parse(agent.lastActivityAt) : Number.NaN;
  return {
    lifecycle: agent.lifecycle,
    internal: agent.internal,
    pendingPermissionCount: agent.pendingPermissionCount,
    quietTurn: agent.quietTurn,
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
}): string {
  const minutes = Math.floor(input.quietForMs / 60_000);
  return [
    `The Paseo daemon saw no activity from you for ${minutes} minutes while your turn was still running, and your account (${input.provider}) is healthy, so it stopped the stalled turn and sent this message instead.`,
    describeSnapshotForAgent(input.snapshot, input.snapshotsEnabled),
    "Resume from where you left off. If you are waiting on something (a person, another agent, a build, a service), say what you are waiting on.",
  ].join("\n\n");
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
  return {
    key: `stalled-agent:${agent.id}`,
    kind: "stalled-agent",
    active,
    remedy: episode.remedy,
    title: `Stalled agent: ${name}`,
    summary,
    evidence,
    attempts: [...episode.attempts],
    graceMs: config.recheckMinutes * 60_000,
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
    },
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
