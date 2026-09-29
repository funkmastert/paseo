import path from "node:path";
import type { Logger } from "pino";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import { ACCOUNT_FAILOVER_MIGRATED_TO_LABEL } from "../agent/account-failover-detector.js";
import type { AgentManager, AgentOperatorSignal, IdleTurnOutcome } from "../agent/agent-manager.js";
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
import { AwayReplyDecisionFile } from "./decision-file.js";
import {
  AWAY_REPLY_OPT_OUT_LABEL,
  detectWaiting,
  leaderSkipReason,
  type AwayReplyAgentView,
  type WaitingEpisode,
} from "./detect.js";
import { presenceSkipReason, type AwayReplyPresence } from "./presence.js";
import {
  findCompanyMarker,
  findExcludedAction,
  isReadOnlyPermission,
  normalizeForScan,
  TYLER_ONLY_CATEGORIES,
  type ReadScope,
} from "./safety.js";
import { AwayReplyState, type AwayReplyFollowUp } from "./state.js";
import { holdReason, isHoldMessage, readThread, replyTextHash } from "./thread.js";

/**
 * Feature 14, the away auto-reply (docs/jev.md, "Feature 14: away auto-reply"). Every sweep finds
 * leaders that have waited on Tyler past the threshold while he is away, asks JEV one block of
 * typed questions about each, and sends at most one templated, marked reply per waiting episode.
 * The usual monitor shape: an unref'd timer, config re-read every sweep, no overlapping sweeps.
 *
 * It acts as Tyler, so when in doubt it does nothing. The hard rules live here, in `safety.ts` and
 * in `thread.ts`, not in JEV: presence, Tyler's own "stop" or "wait", a cancelled turn, the
 * deterministic exclusion over the whole thread since he last wrote, company code, one reply per
 * episode, two in a row at most without him, the daily caps, and never a turn into a running
 * agent. Their state is the daemon's (`state.ts`), not agent labels. It starts in dry run (D6):
 * every decision, with the exact text it would have sent, goes to `decision-file.ts`.
 */

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
/** JEV calls are serialized; five seconds each at most. */
const MAX_EVALUATIONS_PER_SWEEP = 3;
/** Replies in a row with no message from Tyler in between. A hard rule, not config. */
export const MAX_CONSECUTIVE_AUTO_REPLIES = 2;
/** Enough to reach back to Tyler's last message in a long turn; past it, nothing is answered. */
const TIMELINE_TAIL_ROWS = 1000;
/** A follow-up with no word from Tyler this long after the decision is closed as such. */
const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60_000;
const MONITOR_NAME = "away-reply";
const CALL_SITE = "away-reply.evaluate";
const DECISION_QUESTION = "Does this wait need Tyler, and what should be said?";
export const AWAY_REPLY_STATE_FILE = "away-reply-state.json";

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
  /** The agent's existing attention flag, raised with no push. */
  raiseAttention(agentId: string): Promise<void>;
  /** The connected app clients and Tyler's availability mode. Null or a throw counts as present. */
  readPresence(): AwayReplyPresence | null;
}

export interface AwayReplyJobOptions {
  dependencies: AwayReplyDependencies;
  jev: Pick<JevService, "decide" | "isActive" | "checkScope" | "decisions">;
  readConfig: () => ResolvedAwayReplyConfig;
  state: AwayReplyState;
  decisionFile: AwayReplyDecisionFile;
  /** For `~` in a read-only tool's path. */
  homeDir: string | null;
  /** The agent manager's operator signals; unsubscribed on `stop`. */
  subscribeOperatorSignals?: (listener: (signal: AgentOperatorSignal) => void) => () => void;
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

function timestampMs(row: AgentTimelineRow): number {
  const parsed = Date.parse(row.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** When the agent's latest turn started: its newest user message, or 0 when the tail has none. */
function latestTurnStartMs(rows: readonly AgentTimelineRow[]): number {
  const row = rows.findLast((entry) => entry.item.type === "user_message");
  return row ? timestampMs(row) : 0;
}

const APPROVE =
  /^\s*(?:yes|yep|yeah|ok(?:ay)?|sure|go(?:\s+ahead)?|proceed|continue|keep\s+going|lgtm|sounds\s+good|do\s+it|approved?)\b/i;
const OPTION_ALONE = /^\s*(?:option\s+)?\(?([a-z]|\d{1,2})\)?\s*[.!)]?\s*$/i;
const OPTION_NAMED =
  /\b(?:option|go\s+with|pick|choose|use|let'?s\s+(?:go\s+with|do))\s+(?:option\s+)?\(?([a-z]|\d{1,2})\)?(?=[\s.,!)]|$)/i;

/** The option Tyler's own message picks, `approve`, `hold`, or null. Never his text. */
export function readTylerChoice(text: string, optionIds: readonly string[]): string | null {
  const plain = normalizeForScan(text);
  for (const pattern of [OPTION_ALONE, OPTION_NAMED]) {
    const raw = pattern.exec(plain)?.[1];
    if (!raw) continue;
    const id = /^\d+$/.test(raw) ? String(Number(raw)) : raw.toUpperCase();
    if (optionIds.includes(id)) return id;
  }
  if (isHoldMessage(plain)) return "hold";
  if (APPROVE.test(plain)) return "approve";
  return null;
}

function choiceKind(choice: AwayReplyChoice): string {
  if (choice.kind === "reply") return choice.body.kind;
  return choice.kind;
}

function sameChoice(would: AwayReplyFollowUp["would"], tyler: string | null): boolean | null {
  if (tyler === null) return null;
  switch (would.kind) {
    case "option":
    case "recommendation":
      return tyler === would.optionId;
    case "keep-going":
    case "approve-permission":
      return tyler === "approve";
    default:
      return null;
  }
}

export class AwayReplyJob {
  private readonly options: AwayReplyJobOptions;
  private readonly deps: AwayReplyDependencies;
  private readonly state: AwayReplyState;
  private readonly decisionFile: AwayReplyDecisionFile;
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
  private pinnedWorkspaceIds: ReadonlySet<string> = new Set();
  private unsubscribe: (() => void) | null;

  constructor(options: AwayReplyJobOptions) {
    this.options = options;
    this.deps = options.dependencies;
    this.state = options.state;
    this.decisionFile = options.decisionFile;
    this.now = options.now ?? Date.now;
    this.modeLog = new MonitorModeLog(options.logger);
    this.bootMs = this.now();
    // From construction, not `start`: a message Tyler sends before the first sweep still counts.
    this.unsubscribe =
      options.subscribeOperatorSignals?.((signal) => this.onOperatorSignal(signal)) ?? null;
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
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once the state and decision-file writes queued so far have landed. */
  async flush(): Promise<void> {
    await Promise.all([this.state.flush(), this.decisionFile.flush()]);
  }

  reportMode(): void {
    const config = this.options.readConfig();
    this.modeLog.report([
      { monitor: MONITOR_NAME, enabled: config.enabled, dryRun: config.dryRun },
    ]);
  }

  /**
   * The agent manager's word on who acted: Tyler at an app client, or a cancelled turn. Recorded
   * at once, so a restart right after cannot lose it.
   */
  onOperatorSignal(signal: AgentOperatorSignal): void {
    this.state.recordSignal(signal);
    if (signal.kind !== "human-permission-response") return;
    for (const followUp of this.state.followUps()) {
      if (followUp.agentId !== signal.agentId || followUp.requestId !== signal.requestId) continue;
      this.writeFollowUp(followUp, {
        outcome: "tyler-answered-request",
        atMs: signal.at.getTime(),
        tyler: this.readTylerResponse(followUp, signal.response),
      });
    }
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
    this.state.rollDay(nowMs);
    const agents = await this.deps.listAgents();
    this.syncRecords(agents);
    this.resolveFollowUps(nowMs);
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
        }) ||
        this.state.agent(agent.id).optedOutAt !== null
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

      const entry = await this.consider(agent, agents, episode, rows, config, nowMs);
      if (entry.spentEvaluation) evaluations += 1;
      if (entry.entry) report.entries.push(entry.entry);
    }

    for (const key of this.evaluated) if (!liveKeys.has(key)) this.evaluated.delete(key);
    for (const key of this.loggedSkips.keys()) if (!liveKeys.has(key)) this.loggedSkips.delete(key);
    this.state.prune(new Set(agents.map((agent) => agent.id)));
    return report;
  }

  /** Failover successors take their predecessors' records; opt-out labels become sticky. */
  private syncRecords(agents: readonly AwayReplyAgentView[]): void {
    for (const agent of agents) {
      const successor = agent.labels[ACCOUNT_FAILOVER_MIGRATED_TO_LABEL];
      if (successor) this.state.inherit(agent.id, successor);
      if (AWAY_REPLY_OPT_OUT_LABEL in agent.labels) this.state.recordOptOut(agent.id);
    }
  }

  /** Why Tyler counts as present, or null. A presence read that fails counts as present. */
  private presenceReason(agentId: string, config: ResolvedAwayReplyConfig): string | null {
    let presence: AwayReplyPresence | null;
    try {
      presence = this.deps.readPresence();
    } catch {
      presence = null;
    }
    if (!presence) return "presence-unknown";
    return presenceSkipReason({
      presence,
      agentId,
      nowMs: this.now(),
      thresholdMinutes: config.thresholdMinutes,
    });
  }

  /**
   * The hard limits: one reply per episode, two in a row without Tyler, the daily caps, whether
   * Tyler is around, and whether this wait is one he left on purpose. `final` means the episode
   * cannot pass later.
   */
  private limitReason(
    agent: AwayReplyAgentView,
    episode: WaitingEpisode,
    rows: readonly AgentTimelineRow[],
    config: ResolvedAwayReplyConfig,
  ): { reason: string; final: boolean } | null {
    if (!this.state.isUsable()) return { reason: "state-unreadable", final: false };
    const record = this.state.agent(agent.id);
    if (record.answered.includes(episode.key)) return { reason: "already-replied", final: true };
    if (record.streak >= MAX_CONSECUTIVE_AUTO_REPLIES) {
      return { reason: "consecutive-limit", final: false };
    }
    if (this.state.dailyCount(agent.id) >= config.maxRepliesPerAgentPerDay) {
      return { reason: "agent-daily-cap", final: false };
    }
    if (this.state.dailyTotal() >= config.maxRepliesPerDay) {
      return { reason: "daily-cap", final: false };
    }
    const present = this.presenceReason(agent.id, config);
    if (present) return { reason: present, final: false };
    if (episode.kind === "turn-ended") {
      // Tyler opened it after it finished, and left it.
      if (!agent.requiresAttention) return { reason: "tyler-read-thread", final: true };
      // Stopped, by Tyler, the spend governor or anything else: not finished, not waiting.
      if (record.lastCanceledAt !== null && record.lastCanceledAt >= latestTurnStartMs(rows)) {
        return { reason: `turn-canceled-${record.lastCancelReason ?? "unknown"}`, final: true };
      }
    }
    if (episode.kind === "permission" && !config.approveReadOnlyPermissions) {
      return { reason: "permissions-off", final: false };
    }
    return null;
  }

  private readScope(agent: AwayReplyAgentView): ReadScope {
    return { cwd: agent.cwd, home: this.options.homeDir };
  }

  /** The gates that need no JEV call, then the call, then the reply. */
  private async consider(
    agent: AwayReplyAgentView,
    agents: readonly AwayReplyAgentView[],
    episode: WaitingEpisode,
    rows: readonly AgentTimelineRow[],
    config: ResolvedAwayReplyConfig,
    nowMs: number,
  ): Promise<{ entry: AwayReplyReportEntry | null; spentEvaluation: boolean }> {
    const skip = (reason: string, final: boolean) => {
      if (final) this.evaluated.add(episode.key);
      return { entry: this.logSkip(agent, episode, reason, config), spentEvaluation: false };
    };

    const limited = this.limitReason(agent, episode, rows, config);
    if (limited) return skip(limited.reason, limited.final);

    const record = this.state.agent(agent.id);
    const read = readThread(rows, {
      humanMessageIds: new Set(record.humanMessageIds),
      sentHashes: new Set(record.sentHashes),
    });
    if (!read.ok) return skip(read.reason, true);
    const hold = holdReason(read.thread);
    if (hold) return skip(hold, true);

    const built = buildAwayReplyContext(episode, read.thread, this.readScope(agent));
    if (!built.ok) return skip(built.reason, true);
    const context = built.context;
    const scanned = threadText(context);

    // Company code: the leader's cwd, its children's, or any mention in the thread.
    const childCwds = agents
      .filter((other) => getParentAgentIdFromLabels(other.labels) === agent.id)
      .map((other) => other.cwd);
    const company = findCompanyMarker([agent.cwd, ...childCwds, scanned].join("\n"));
    if (company) return skip("company-code", true);

    if (
      episode.kind === "permission" &&
      (!episode.request || !isReadOnlyPermission(episode.request, context.readScope))
    ) {
      return skip("not-read-only", true);
    }

    const hit = findExcludedAction(scanned);
    if (hit) {
      if (TYLER_ONLY_CATEGORIES.has(hit.category) && episode.kind === "turn-ended") {
        await this.raiseAttention(agent.id, config);
      }
      return skip(`excluded-${hit.category}`, true);
    }

    const scope = { cwds: [agent.cwd, ...childCwds], agentIds: [agent.id] };
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
    const entry = await this.act(agent, context, decision, outcome, { dryRun, nowMs, config });
    return { entry, spentEvaluation: true };
  }

  private async act(
    agent: AwayReplyAgentView,
    context: AwayReplyContext,
    decision: AwayReplyDecision,
    outcome: JevOutcome,
    run: { dryRun: boolean; nowMs: number; config: ResolvedAwayReplyConfig },
  ): Promise<AwayReplyReportEntry> {
    const choice = decision.choice;
    if (choice.kind === "none") {
      if (choice.raiseAttention && !run.dryRun) await this.raiseAttention(agent.id, run.config);
      return this.finish(agent, context, outcome, decision, {
        action: "no-reply",
        reason: choice.reason,
        text: null,
        applied: false,
        dryRun: run.dryRun,
      });
    }

    const text = this.replyText(context, choice, run.config);
    if (run.dryRun) {
      return this.finish(agent, context, outcome, decision, {
        action: "would-reply",
        reason: this.replyReason(choice),
        text,
        applied: false,
        dryRun: true,
      });
    }

    const notSent = await this.deliver(context, choice, text, run.config);
    if (notSent) {
      return this.finish(agent, context, outcome, decision, {
        action: "not-sent",
        reason: notSent,
        text: null,
        applied: false,
        dryRun: false,
      });
    }

    this.state.recordReply(agent.id, {
      at: run.nowMs,
      episodeKey: context.episode.key,
      textHash: context.episode.kind === "turn-ended" && text ? replyTextHash(text) : null,
    });
    return this.finish(agent, context, outcome, decision, {
      action: "replied",
      reason: this.replyReason(choice),
      text,
      applied: true,
      dryRun: false,
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
    // The JEV call took time: Tyler may be back, may have answered, or the thread moved on.
    // Re-read, and send only if this is still the same wait and he is still away.
    const agents = await this.deps.listAgents();
    const fresh = agents.find((agent) => agent.id === episode.agentId);
    if (!fresh) return "agent-gone";
    const skipReason = leaderSkipReason(fresh, agents, {
      pinnedWorkspaceIds: this.pinnedWorkspaceIds,
      skipPinnedWorkspaces: config.skipPinnedWorkspaces,
    });
    if (skipReason) return skipReason;
    const rows = this.deps.readTimelineTail(fresh.id, TIMELINE_TAIL_ROWS) ?? [];
    const again = detectWaiting(fresh, rows);
    if (!again.waiting || again.episode.key !== episode.key) return "thread-moved";
    const limited = this.limitReason(fresh, again.episode, rows, config);
    if (limited) return limited.reason;

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
    if (
      context.episode.kind === "plan" &&
      context.planText &&
      context.resumeActionId &&
      choice.body.kind === "keep-going"
    ) {
      const note = `${awayReplyMarker(config.thresholdMinutes)} ${replyBodyText(choice.body, "plan")} ${AWAY_REPLY_GUARD}`;
      // `implement_resume` puts the leader back in the mode it planned from; `implement` would
      // move a bypass leader to acceptEdits.
      return {
        behavior: "allow",
        selectedActionId: context.resumeActionId,
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
    agent: AwayReplyAgentView,
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
    this.decisionFile.append({
      type: "skip",
      at: new Date(this.now()).toISOString(),
      agentId: episode.agentId,
      title: agent.title,
      episode: episode.kind,
      episodeKey: episode.key,
      dryRun: config.dryRun,
      reason,
    });
    return {
      agentId: episode.agentId,
      episode: episode.kind,
      action: "skipped",
      reason,
      callId: null,
      text: null,
    };
  }

  /** The structured line, the decision record and the decision file, for an evaluated episode. */
  private finish(
    agent: AwayReplyAgentView,
    context: AwayReplyContext,
    outcome: JevOutcome,
    decision: AwayReplyDecision,
    result: {
      action: AwayReplyAction;
      reason: string;
      text: string | null;
      applied: boolean;
      dryRun: boolean;
    },
  ): AwayReplyReportEntry {
    const { episode } = context;
    const nowMs = this.now();
    const waitedMinutes = Math.round((nowMs - episode.waitingSinceMs) / 60_000);
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
        dryRun: result.dryRun,
      },
      "away-reply",
    );
    this.options.jev.decisions.record({
      agentId: episode.agentId,
      callId: outcome.callId,
      feature: "awayReply",
      question: DECISION_QUESTION,
      verdict: verdictSummary(decision, outcome),
      confidence: decision.confidence,
      action: this.describeAction(result),
      applied: result.applied,
    });
    const response =
      episode.kind !== "turn-ended" && choice.kind !== "none"
        ? {
            behavior: "allow" as const,
            selectedActionId: episode.kind === "plan" ? context.resumeActionId : null,
          }
        : null;
    this.decisionFile.append({
      type: "decision",
      at: new Date(nowMs).toISOString(),
      agentId: episode.agentId,
      title: agent.title,
      episode: episode.kind,
      episodeKey: episode.key,
      waitedMinutes,
      dryRun: result.dryRun,
      action: result.action,
      reason: result.reason,
      callId: outcome.callId,
      verdicts: decision.verdicts,
      optionId,
      text: result.text,
      response,
    });
    if (!result.applied) {
      this.state.addFollowUp({
        callId: outcome.callId,
        agentId: episode.agentId,
        episodeKey: episode.key,
        episode: episode.kind,
        decidedAt: nowMs,
        requestId: episode.request?.id ?? null,
        would: { kind: choiceKind(choice), optionId },
        options: context.offered.options.map((option) => ({ id: option.id, label: option.label })),
      });
    }
    return {
      agentId: episode.agentId,
      episode: episode.kind,
      action: result.action,
      reason: result.reason,
      callId: outcome.callId,
      text: result.text,
    };
  }

  /** What Tyler's own answer to a request picked. */
  private readTylerResponse(
    followUp: AwayReplyFollowUp,
    response: AgentPermissionResponse,
  ): string | null {
    if (response.behavior !== "allow") return "deny";
    if (followUp.episode !== "question") return "approve";
    const answers = response.updatedInput?.["answers"];
    if (typeof answers !== "object" || answers === null) return null;
    const given = Object.values(answers as Record<string, unknown>)
      .filter((value): value is string => typeof value === "string")
      .map((value) => normalizeForScan(value).trim().toLowerCase());
    const match = followUp.options.find((option) =>
      given.some((answer) =>
        answer.startsWith(normalizeForScan(option.label).trim().toLowerCase()),
      ),
    );
    return match?.id ?? null;
  }

  /** Closes follow-ups Tyler has since answered by message, or that aged out. */
  private resolveFollowUps(nowMs: number): void {
    for (const followUp of this.state.followUps()) {
      const record = this.state.agent(followUp.agentId);
      if (record.lastHumanAt !== null && record.lastHumanAt > followUp.decidedAt) {
        const humanIds = new Set(record.humanMessageIds);
        const rows = this.deps.readTimelineTail(followUp.agentId, TIMELINE_TAIL_ROWS) ?? [];
        const row = rows.find(
          (entry) =>
            entry.item.type === "user_message" &&
            entry.item.clientMessageId !== undefined &&
            humanIds.has(entry.item.clientMessageId) &&
            timestampMs(entry) > followUp.decidedAt,
        );
        const text = row?.item.type === "user_message" ? row.item.text : null;
        this.writeFollowUp(followUp, {
          outcome: "tyler-message",
          atMs: row ? timestampMs(row) : record.lastHumanAt,
          tyler:
            text === null
              ? null
              : readTylerChoice(
                  text,
                  followUp.options.map((option) => option.id),
                ),
        });
        continue;
      }
      if (nowMs - followUp.decidedAt > FOLLOW_UP_WINDOW_MS) {
        this.writeFollowUp(followUp, { outcome: "no-tyler-action-24h", atMs: nowMs, tyler: null });
      }
    }
  }

  private writeFollowUp(
    followUp: AwayReplyFollowUp,
    result: { outcome: string; atMs: number; tyler: string | null },
  ): void {
    this.state.removeFollowUp(followUp.episodeKey);
    this.decisionFile.append({
      type: "followup",
      at: new Date(this.now()).toISOString(),
      agentId: followUp.agentId,
      episodeKey: followUp.episodeKey,
      callId: followUp.callId,
      outcome: result.outcome,
      minutesAfterDecision: Math.round((result.atMs - followUp.decidedAt) / 60_000),
      would: followUp.would,
      tyler: result.tyler,
      sameChoice: sameChoice(followUp.would, result.tyler),
    });
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
    | "markAgentUnread"
    | "subscribeOperatorSignals"
  > &
    PermissionResponseAgentManager;
  agentStorage: Pick<AgentStorage, "list">;
  workspaceRegistry: Pick<FileBackedWorkspaceRegistry, "list">;
  jev: JevService;
  /** The connected app clients and Tyler's availability mode (the WebSocket server's). */
  readPresence: () => AwayReplyPresence | null;
  paseoHome: string;
  homeDir: string | null;
  logger: Logger;
  sweepIntervalMs?: number;
}

/** Production wiring, kept here so bootstrap only starts and stops it. */
export function createAwayReplyJob(input: CreateAwayReplyJobInput): AwayReplyJob {
  const { agentManager } = input;
  const logger = input.logger.child({ module: "away-reply" });
  const jevDir = path.join(input.paseoHome, "jev");
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
          title: summary.title,
          requiresAttention: summary.requiresAttention,
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
      raiseAttention: (agentId) => agentManager.markAgentUnread(agentId),
      readPresence: input.readPresence,
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
    state: new AwayReplyState({ filePath: path.join(jevDir, AWAY_REPLY_STATE_FILE), logger }),
    decisionFile: new AwayReplyDecisionFile({ dir: jevDir, logger }),
    homeDir: input.homeDir,
    subscribeOperatorSignals: (listener) => agentManager.subscribeOperatorSignals(listener),
    logger,
    sweepIntervalMs: input.sweepIntervalMs,
  });
}
