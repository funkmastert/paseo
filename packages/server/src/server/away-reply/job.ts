import type { Logger } from "pino";

import type { AgentManager, IdleTurnOutcome } from "../agent/agent-manager.js";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import {
  respondToAgentPermission,
  type PermissionResponseAgentManager,
} from "../agent/permission-response.js";
import { jevConfigSection } from "../jev/config.js";
import type { JevOutcome, JevService } from "../jev/contract.js";
import { MonitorModeLog } from "../monitor-mode-log.js";
import { readRawConfig } from "../session/doctor/facts.js";
import type { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { resolveAwayReplyConfig, type ResolvedAwayReplyConfig } from "./config.js";
import {
  AWAY_REPLY_GUARD,
  awayReplyMarker,
  buildAwayReplyContext,
  buildAwayReplyRequest,
  formatAwayReply,
  mapAwayReplyAnswers,
  replyBodyText,
  threadText,
  type AwayReplyChoice,
  type AwayReplyContext,
  type AwayReplyDecision,
} from "./decision.js";
import {
  AUTO_REPLIED_AT_LABEL,
  AUTO_REPLY_STREAK_LABEL,
  detectWaiting,
  leaderSkipReason,
  tylerMessagedSince,
  type AwayReplyAgentView,
  type WaitingEpisode,
} from "./detect.js";
import { findExcludedAction, isReadOnlyPermission, TYLER_ONLY_CATEGORIES } from "./safety.js";

/**
 * Feature 14, the away auto-reply (docs/jev.md, "Feature 14: away auto-reply"). Every sweep finds
 * leaders that have waited on Tyler past the threshold, asks JEV one block of typed questions
 * about each, and sends at most one templated, marked reply per waiting episode. The usual monitor
 * shape: an unref'd timer, config re-read every sweep, no overlapping sweeps.
 *
 * The hard rules live here and in `safety.ts`, not in JEV: the deterministic exclusion, one reply
 * per episode, two in a row at most without Tyler writing, the daily caps, and never a turn into a
 * running agent.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
/** JEV calls are serialized; five seconds each at most. */
const MAX_EVALUATIONS_PER_SWEEP = 3;
/** Replies in a row with no message from Tyler in between. A hard rule, not config. */
export const MAX_CONSECUTIVE_AUTO_REPLIES = 2;
const TIMELINE_TAIL_ROWS = 200;
const MONITOR_NAME = "away-reply";
const CALL_SITE = "away-reply.evaluate";
const DECISION_QUESTION = "Does this wait need Tyler, and what should be said?";

/**
 * Nothing was sent and the reason can pass, so the next sweep may ask again. Anything else spends
 * the episode's one evaluation.
 */
const RETRYABLE_UNAVAILABLE = new Set([
  "no-key",
  "disabled",
  "feature-disabled",
  "daily-budget",
  "key-rejected",
  "circuit-open",
  "saturated",
  "config-unreadable",
]);

export interface AwayReplyDependencies {
  /** Live agents only. */
  listAgents(): Promise<AwayReplyAgentView[]>;
  /** The newest timeline rows, oldest first; null when the agent is not loaded. */
  readTimelineTail(agentId: string, limit: number): readonly AgentTimelineRow[] | null;
  listPinnedWorkspaceIds(): Promise<ReadonlySet<string>>;
  /** Starts a turn only on an idle agent; null, having sent nothing, otherwise. */
  startTurnIfIdle(agentId: string, text: string): Promise<IdleTurnOutcome> | null;
  /** The app's own path for answering a pending request. */
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
  /** The agent's existing attention flag, raised with no push. */
  raiseAttention(agentId: string): Promise<void>;
}

export interface AwayReplyJobOptions {
  dependencies: AwayReplyDependencies;
  jev: Pick<JevService, "decide" | "isActive" | "checkScope" | "decisions">;
  readConfig: () => ResolvedAwayReplyConfig;
  logger: Logger;
  sweepIntervalMs?: number;
  now?: () => number;
}

export type AwayReplyAction = "replied" | "would-reply" | "no-reply" | "skipped" | "not-sent";

export interface AwayReplyReportEntry {
  agentId: string;
  episode: WaitingEpisode["kind"];
  action: AwayReplyAction;
  reason: string;
  callId: string | null;
  /** The exact text sent (or that a dry run would send), for a reply with text. */
  text: string | null;
}

export interface AwayReplyReport {
  dryRun: boolean;
  entries: AwayReplyReportEntry[];
}

interface DailyCounts {
  day: string;
  total: number;
  perAgent: Map<string, number>;
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function labelTimeMs(labels: Record<string, string>): number | null {
  const raw = labels[AUTO_REPLIED_AT_LABEL];
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Auto-replies since Tyler last wrote to this agent. Tyler writing resets it to zero. */
export function currentStreak(
  labels: Record<string, string>,
  rows: readonly AgentTimelineRow[],
): number {
  const lastAt = labelTimeMs(labels);
  if (lastAt === null) return 0;
  if (tylerMessagedSince(rows, lastAt)) return 0;
  const streak = Number.parseInt(labels[AUTO_REPLY_STREAK_LABEL] ?? "", 10);
  return Number.isFinite(streak) && streak > 0 ? streak : 1;
}

/** JEV's answers mapped to a choice; any other outcome is no reply, which is today's behaviour. */
function decisionFor(
  context: AwayReplyContext,
  outcome: JevOutcome,
  config: ResolvedAwayReplyConfig,
): AwayReplyDecision {
  if (outcome.kind === "answered" || outcome.kind === "shadow") {
    return mapAwayReplyAnswers(context, outcome.answers, config);
  }
  return {
    choice: {
      kind: "none",
      reason: `jev-${outcome.kind}-${outcome.reason}`,
      raiseAttention: false,
    },
    verdicts: [],
    confidence: null,
  };
}

function verdictSummary(decision: AwayReplyDecision, outcome: JevOutcome): string {
  if (decision.verdicts.length > 0) return decision.verdicts.join(", ");
  if (outcome.kind === "unavailable" || outcome.kind === "failed") {
    return `${outcome.kind}: ${outcome.reason}`;
  }
  return "no answer";
}

function planActionId(context: AwayReplyContext): string | undefined {
  const actions = context.episode.request?.actions ?? [];
  const allow = actions.filter((action) => action.behavior === "allow");
  return (
    allow.find((action) => action.variant === "primary")?.id ??
    allow.find((action) => action.intent === "implement")?.id ??
    allow[0]?.id
  );
}

export class AwayReplyJob {
  private readonly options: AwayReplyJobOptions;
  private readonly deps: AwayReplyDependencies;
  private readonly now: () => number;
  private readonly modeLog: MonitorModeLog;
  /** A restart does not mean Tyler is back or away: every wait restarts its clock at boot. */
  private readonly bootMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  /** Episodes whose one evaluation is spent. */
  private readonly evaluated = new Set<string>();
  /** The last skip reason logged per episode, so a skip is logged once, not every sweep. */
  private readonly loggedSkips = new Map<string, string>();
  private daily: DailyCounts;
  private pinnedWorkspaceIds: ReadonlySet<string> = new Set();

  constructor(options: AwayReplyJobOptions) {
    this.options = options;
    this.deps = options.dependencies;
    this.now = options.now ?? Date.now;
    this.modeLog = new MonitorModeLog(options.logger);
    this.bootMs = this.now();
    this.daily = { day: localDay(this.bootMs), total: 0, perAgent: new Map() };
  }

  start(): void {
    if (this.timer) return;
    this.reportMode();
    const timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Away auto-reply sweep failed");
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
    const config = this.options.readConfig();
    this.modeLog.report([
      { monitor: MONITOR_NAME, enabled: config.enabled, dryRun: config.dryRun },
    ]);
  }

  /** Runs one sweep; null when another sweep is in flight. */
  async tick(): Promise<AwayReplyReport | null> {
    if (this.sweepInFlight) return null;
    this.sweepInFlight = true;
    try {
      return await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<AwayReplyReport> {
    const config = this.options.readConfig();
    this.reportMode();
    const report: AwayReplyReport = { dryRun: config.dryRun, entries: [] };
    // No key, a switch off, a spent budget or an open circuit: today's behaviour, and no reads.
    if (!config.enabled || !this.options.jev.isActive("awayReply")) return report;

    const nowMs = this.now();
    this.rollDay(nowMs);
    const agents = await this.deps.listAgents();
    const pinnedWorkspaceIds = config.skipPinnedWorkspaces
      ? await this.deps.listPinnedWorkspaceIds()
      : new Set<string>();
    this.pinnedWorkspaceIds = pinnedWorkspaceIds;
    const liveKeys = new Set<string>();
    let evaluations = 0;

    for (const agent of agents) {
      if (
        leaderSkipReason(agent, agents, {
          pinnedWorkspaceIds,
          skipPinnedWorkspaces: config.skipPinnedWorkspaces,
        })
      ) {
        continue;
      }
      const rows = this.deps.readTimelineTail(agent.id, TIMELINE_TAIL_ROWS) ?? [];
      const detection = detectWaiting(agent, rows);
      if (!detection.waiting) continue;
      const episode = detection.episode;
      liveKeys.add(episode.key);
      const waitedFromMs = Math.max(episode.waitingSinceMs, this.bootMs);
      if (nowMs - waitedFromMs < config.thresholdMinutes * 60_000) continue;
      if (this.evaluated.has(episode.key)) continue;
      if (evaluations >= MAX_EVALUATIONS_PER_SWEEP) continue;

      const entry = await this.consider(agent, episode, rows, config, nowMs);
      if (entry.spentEvaluation) evaluations += 1;
      if (entry.entry) report.entries.push(entry.entry);
    }

    for (const key of this.evaluated) if (!liveKeys.has(key)) this.evaluated.delete(key);
    for (const key of this.loggedSkips.keys()) if (!liveKeys.has(key)) this.loggedSkips.delete(key);
    return report;
  }

  /**
   * The hard limits: one reply per episode, two in a row without Tyler, the daily caps, and the
   * code half of the read-only rule. `final` means the episode cannot pass later.
   */
  private limitReason(
    agent: AwayReplyAgentView,
    episode: WaitingEpisode,
    streak: number,
    config: ResolvedAwayReplyConfig,
  ): { reason: string; final: boolean } | null {
    const repliedAt = labelTimeMs(agent.labels);
    if (repliedAt !== null && repliedAt >= episode.waitingSinceMs) {
      return { reason: "already-replied", final: true };
    }
    if (streak >= MAX_CONSECUTIVE_AUTO_REPLIES) {
      return { reason: "consecutive-limit", final: false };
    }
    if ((this.daily.perAgent.get(agent.id) ?? 0) >= config.maxRepliesPerAgentPerDay) {
      return { reason: "agent-daily-cap", final: false };
    }
    if (this.daily.total >= config.maxRepliesPerDay) return { reason: "daily-cap", final: false };
    if (episode.kind !== "permission") return null;
    if (!config.approveReadOnlyPermissions) return { reason: "permissions-off", final: false };
    if (!episode.request || !isReadOnlyPermission(episode.request)) {
      return { reason: "not-read-only", final: true };
    }
    return null;
  }

  private rollDay(nowMs: number): void {
    const day = localDay(nowMs);
    if (this.daily.day !== day) this.daily = { day, total: 0, perAgent: new Map() };
  }

  /** The gates that need no JEV call, then the call, then the reply. */
  private async consider(
    agent: AwayReplyAgentView,
    episode: WaitingEpisode,
    rows: readonly AgentTimelineRow[],
    config: ResolvedAwayReplyConfig,
    nowMs: number,
  ): Promise<{ entry: AwayReplyReportEntry | null; spentEvaluation: boolean }> {
    const skip = (reason: string, final: boolean) => {
      if (final) this.evaluated.add(episode.key);
      return { entry: this.logSkip(episode, reason, config), spentEvaluation: false };
    };

    const streak = currentStreak(agent.labels, rows);
    const limited = this.limitReason(agent, episode, streak, config);
    if (limited) return skip(limited.reason, limited.final);

    const built = buildAwayReplyContext(episode);
    if (!built.ok) return skip(built.reason, true);
    const context = built.context;

    const hit = findExcludedAction(threadText(context));
    if (hit) {
      if (TYLER_ONLY_CATEGORIES.has(hit.category) && episode.kind === "turn-ended") {
        await this.raiseAttention(agent.id, config);
      }
      return skip(`excluded-${hit.category}`, true);
    }

    const scope = { cwds: [agent.cwd], agentIds: [agent.id] };
    if ((await this.options.jev.checkScope(scope)) === "excluded") {
      return skip("d7-excluded", true);
    }

    const request = buildAwayReplyRequest(context);
    const outcome = await this.options.jev.decide({
      feature: "awayReply",
      callSite: CALL_SITE,
      state: request.state,
      questions: request.questions,
      scope,
      subject: { agentId: agent.id },
    });
    if (outcome.kind === "unavailable" && RETRYABLE_UNAVAILABLE.has(outcome.reason)) {
      // Nothing was sent and the reason can pass: ask again next sweep.
      return skip(`jev-unavailable-${outcome.reason}`, false);
    }
    this.evaluated.add(episode.key);

    const decision = decisionFor(context, outcome, config);
    const dryRun = config.dryRun || outcome.kind === "shadow";
    const entry = await this.act(agent, context, decision, outcome, {
      dryRun,
      streak,
      nowMs,
      config,
    });
    return { entry, spentEvaluation: true };
  }

  private async act(
    agent: AwayReplyAgentView,
    context: AwayReplyContext,
    decision: AwayReplyDecision,
    outcome: JevOutcome,
    run: { dryRun: boolean; streak: number; nowMs: number; config: ResolvedAwayReplyConfig },
  ): Promise<AwayReplyReportEntry> {
    const { episode } = context;
    const choice = decision.choice;
    if (choice.kind === "none") {
      if (choice.raiseAttention && !run.dryRun) await this.raiseAttention(agent.id, run.config);
      return this.finish(episode, outcome, decision, {
        action: "no-reply",
        reason: choice.reason,
        text: null,
        applied: false,
        config: run.config,
      });
    }

    const text = this.replyText(context, choice, run.config);
    if (run.dryRun) {
      return this.finish(episode, outcome, decision, {
        action: "would-reply",
        reason: this.replyReason(choice),
        text,
        applied: false,
        config: run.config,
      });
    }

    const notSent = await this.deliver(context, choice, text, run.config);
    if (notSent) {
      return this.finish(episode, outcome, decision, {
        action: "not-sent",
        reason: notSent,
        text: null,
        applied: false,
        config: run.config,
      });
    }

    this.daily.total += 1;
    this.daily.perAgent.set(agent.id, (this.daily.perAgent.get(agent.id) ?? 0) + 1);
    await this.deps
      .setLabels(agent.id, {
        [AUTO_REPLIED_AT_LABEL]: new Date(run.nowMs).toISOString(),
        [AUTO_REPLY_STREAK_LABEL]: String(run.streak + 1),
      })
      .catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, agentId: agent.id },
          "away-reply: label write failed",
        );
      });
    return this.finish(episode, outcome, decision, {
      action: "replied",
      reason: this.replyReason(choice),
      text,
      applied: true,
      config: run.config,
    });
  }

  private replyReason(choice: Exclude<AwayReplyChoice, { kind: "none" }>): string {
    return choice.kind === "approve-permission" ? "approve-read-only-permission" : choice.body.kind;
  }

  private replyText(
    context: AwayReplyContext,
    choice: Exclude<AwayReplyChoice, { kind: "none" }>,
    config: ResolvedAwayReplyConfig,
  ): string | null {
    if (choice.kind === "approve-permission") return null;
    return formatAwayReply(choice.body, context.episode.kind, config.thresholdMinutes);
  }

  /**
   * Sends the reply through the path that cannot touch a running turn. Returns why nothing was
   * sent, or null when it was.
   */
  private async deliver(
    context: AwayReplyContext,
    choice: Exclude<AwayReplyChoice, { kind: "none" }>,
    text: string | null,
    config: ResolvedAwayReplyConfig,
  ): Promise<string | null> {
    const { episode } = context;
    // The JEV call took time: Tyler may have answered, or the thread moved on. Re-read, and send
    // only if this is still the same wait.
    const agents = await this.deps.listAgents();
    const fresh = agents.find((agent) => agent.id === episode.agentId);
    if (!fresh) return "agent-gone";
    const skipReason = leaderSkipReason(fresh, agents, {
      pinnedWorkspaceIds: this.pinnedWorkspaceIds,
      skipPinnedWorkspaces: config.skipPinnedWorkspaces,
    });
    if (skipReason) return skipReason;
    const again = detectWaiting(
      fresh,
      this.deps.readTimelineTail(fresh.id, TIMELINE_TAIL_ROWS) ?? [],
    );
    if (!again.waiting || again.episode.key !== episode.key) return "thread-moved";

    try {
      if (episode.kind === "turn-ended") {
        if (!text) return "no-text";
        const started = this.deps.startTurnIfIdle(episode.agentId, text);
        if (!started) return "not-idle";
        void started.catch((error: unknown) => {
          this.options.logger.warn(
            { err: error, agentId: episode.agentId },
            "away-reply: turn failed",
          );
        });
        return null;
      }
      const request = episode.request;
      if (!request) return "no-request";
      const response = this.permissionResponse(context, choice, text, config);
      if (!response) return "no-response";
      await this.deps.respondToPermission(episode.agentId, request.id, response);
      return null;
    } catch (error) {
      this.options.logger.warn(
        { err: error, agentId: episode.agentId },
        "away-reply: delivery failed",
      );
      return "delivery-failed";
    }
  }

  private permissionResponse(
    context: AwayReplyContext,
    choice: Exclude<AwayReplyChoice, { kind: "none" }>,
    text: string | null,
    config: ResolvedAwayReplyConfig,
  ): AgentPermissionResponse | null {
    const request = context.episode.request;
    if (!request) return null;
    if (choice.kind === "approve-permission") {
      return context.episode.kind === "permission" ? { behavior: "allow" } : null;
    }
    if (context.episode.kind === "question" && context.question && text) {
      // The app's question card answers the same way: the request's input, plus answers by header.
      return {
        behavior: "allow",
        updatedInput: { ...request.input, answers: { [context.question.header]: text } },
      };
    }
    if (context.episode.kind === "plan" && context.planText && choice.body.kind === "keep-going") {
      const note = `${awayReplyMarker(config.thresholdMinutes)} ${replyBodyText(choice.body, "plan")} ${AWAY_REPLY_GUARD}`;
      return {
        behavior: "allow",
        selectedActionId: planActionId(context),
        updatedInput: { ...request.input, plan: `${context.planText}\n\n${note}` },
      };
    }
    return null;
  }

  private async raiseAttention(agentId: string, config: ResolvedAwayReplyConfig): Promise<void> {
    if (config.dryRun) return;
    await this.deps.raiseAttention(agentId).catch(() => undefined);
  }

  private logSkip(
    episode: WaitingEpisode,
    reason: string,
    config: ResolvedAwayReplyConfig,
  ): AwayReplyReportEntry | null {
    if (this.loggedSkips.get(episode.key) === reason) return null;
    this.loggedSkips.set(episode.key, reason);
    this.options.logger.info(
      {
        agentId: episode.agentId,
        episode: episode.kind,
        action: "skipped",
        reason,
        dryRun: config.dryRun,
      },
      "away-reply",
    );
    return {
      agentId: episode.agentId,
      episode: episode.kind,
      action: "skipped",
      reason,
      callId: null,
      text: null,
    };
  }

  /** The one structured line, and the decision record, for an episode JEV was asked about. */
  private finish(
    episode: WaitingEpisode,
    outcome: JevOutcome,
    decision: AwayReplyDecision,
    result: {
      action: AwayReplyAction;
      reason: string;
      text: string | null;
      applied: boolean;
      config: ResolvedAwayReplyConfig;
    },
  ): AwayReplyReportEntry {
    const waitedMinutes = Math.round((this.now() - episode.waitingSinceMs) / 60_000);
    const choice = decision.choice;
    const optionId =
      choice.kind === "reply" && choice.body.kind !== "keep-going" ? choice.body.optionId : null;
    this.options.logger.info(
      {
        agentId: episode.agentId,
        episode: episode.kind,
        waitedMinutes,
        action: result.action,
        reason: result.reason,
        optionId,
        outcome: outcome.kind,
        callId: outcome.callId,
        verdicts: decision.verdicts,
        dryRun: result.config.dryRun,
      },
      "away-reply",
    );
    const verdict = verdictSummary(decision, outcome);
    this.options.jev.decisions.record({
      agentId: episode.agentId,
      callId: outcome.callId,
      feature: "awayReply",
      question: DECISION_QUESTION,
      verdict,
      confidence: decision.confidence,
      action: this.describeAction(result),
      applied: result.applied,
    });
    return {
      agentId: episode.agentId,
      episode: episode.kind,
      action: result.action,
      reason: result.reason,
      callId: outcome.callId,
      text: result.text,
    };
  }

  private describeAction(result: { action: AwayReplyAction; reason: string }): string {
    switch (result.action) {
      case "replied":
        return `replied on Tyler's behalf (${result.reason})`;
      case "would-reply":
        return `would reply (${result.reason}); dry run, nothing sent`;
      case "not-sent":
        return `no reply sent: ${result.reason}`;
      default:
        return `no reply: ${result.reason}`;
    }
  }
}

export interface CreateAwayReplyJobInput {
  agentManager: Pick<
    AgentManager,
    | "listAgentsForDoneJanitor"
    | "getAgent"
    | "fetchTimeline"
    | "startTurnIfIdle"
    | "setLabels"
    | "markAgentUnread"
  > &
    PermissionResponseAgentManager;
  agentStorage: Pick<AgentStorage, "list">;
  workspaceRegistry: Pick<FileBackedWorkspaceRegistry, "list">;
  jev: JevService;
  paseoHome: string;
  logger: Logger;
  sweepIntervalMs?: number;
}

/** Production wiring, kept here so bootstrap only starts and stops it. */
export function createAwayReplyJob(input: CreateAwayReplyJobInput): AwayReplyJob {
  const { agentManager } = input;
  const logger = input.logger.child({ module: "away-reply" });
  return new AwayReplyJob({
    dependencies: {
      listAgents: async () => {
        const stored = await input.agentStorage.list();
        const archivedAt = new Map(stored.map((record) => [record.id, record.archivedAt ?? null]));
        return agentManager.listAgentsForDoneJanitor().map((summary) => ({
          id: summary.id,
          provider: summary.provider,
          cwd: summary.cwd,
          workspaceId: summary.workspaceId,
          internal: summary.internal,
          lifecycle: summary.lifecycle,
          busy: summary.busy,
          labels: summary.labels,
          runningProviderSubagentCount: summary.runningProviderSubagentCount,
          pendingPermissions:
            summary.pendingPermissionCount > 0
              ? [...(agentManager.getAgent(summary.id)?.pendingPermissions.values() ?? [])]
              : [],
          archivedAt: archivedAt.get(summary.id) ?? null,
        }));
      },
      readTimelineTail: (agentId, limit) => {
        try {
          return agentManager.fetchTimeline(agentId, { direction: "tail", limit }).rows;
        } catch {
          return null;
        }
      },
      listPinnedWorkspaceIds: async () =>
        new Set(
          (await input.workspaceRegistry.list())
            .filter((workspace) => workspace.pinnedAt)
            .map((workspace) => workspace.workspaceId),
        ),
      startTurnIfIdle: (agentId, text) => agentManager.startTurnIfIdle(agentId, text),
      respondToPermission: (agentId, requestId, response) =>
        respondToAgentPermission({ agentManager, agentId, requestId, response, logger }),
      setLabels: (agentId, labels) => agentManager.setLabels(agentId, labels),
      raiseAttention: (agentId) => agentManager.markAgentUnread(agentId),
    },
    jev: input.jev,
    readConfig: () =>
      resolveAwayReplyConfig(
        (
          jevConfigSection(readRawConfig(input.paseoHome).rawConfig) as
            | Record<string, unknown>
            | undefined
        )?.["awayReply"],
      ),
    logger,
    sweepIntervalMs: input.sweepIntervalMs,
  });
}
