import type { TokenBurnAlert } from "@getpaseo/protocol/agent-types";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import {
  buildAccountUsagePressureNotificationPayload,
  buildBatchedTokenBurnNotificationPayload,
  buildSpendGovernorNotificationPayload,
  buildTokenBurnNotificationPayload,
  type SpendGovernorStage,
} from "@getpaseo/protocol/token-burn-notification";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { resolveAccountPoolEntries } from "./agent/account-pool-providers.js";
import { NULL_REMEDIATION_SINK, type RemediationSink } from "./remediation/contract.js";
import {
  evaluateTokenBurn,
  type TokenBurnMonitorConfig as DetectorConfig,
} from "./agent/token-burn-detector.js";
import {
  planSpendGovernorActions,
  type SpendGovernorAction,
  type SpendGovernorConfig as GovernorDecisionConfig,
} from "./agent/spend-governor.js";
import type { NotifyLevel } from "./notify-policy/levels.js";
import type { PushNotificationSender, PushSendMeta } from "./push/index.js";
import { MonitorModeLog } from "./monitor-mode-log.js";
import type { ModelDivergenceMonitorSettings } from "./agent-model-divergence-monitor.js";
import type {
  UsageHistorySampler,
  UsageHistorySettings,
} from "./usage-history/usage-history-sampler.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
// Measured, not chosen: a healthy Opus agent doing ordinary tool work on this machine sustains
// 100-200K weighted tokens/min, because the weighted rate is mostly a readout of context size
// times request frequency. Three samples of one agent reading source files: 205K, 181K, 106K
// per minute, 448K cumulative over its first four minutes — and it tripped the old 50,000
// default on its third sweep, doing nothing wrong. 400,000 sits at roughly twice the measured
// healthy peak. The rate leg is a coarse smoke alarm and nothing more: the spend governor
// below never acts on it, because an agent's rate says how big its context is, not whether
// the work is worth doing. See docs/token-burn.md.
const DEFAULT_RATE_PER_MINUTE = 400_000;
const DEFAULT_SUSTAINED_MINUTES = 3;
// The total leg ships off. A flat global threshold cannot separate an expensive agent doing
// real work from a runaway — docs/token-burn.md measures healthy agents on both sides of every
// line — so at 5,000,000 it fired on four of Tyler's agents at once, all idle, all legitimate,
// all already finished. What discriminates is the spend governor's budget-relative `notify`,
// which knows what the task was declared to be worth. Set `totalTokens` to opt back in.
const DEFAULT_TOTAL_TOKENS: number | null = null;
const DEFAULT_BREACH_BATCH_THRESHOLD = 3;
// Governor defaults. Off unless turned on, and every stage past `notify` off even then, so
// enabling it can only ever start reporting. Fractions are multiples of the task's budget:
// warn before it runs out, act at it, stop it well past it.
const DEFAULT_NOTIFY_AT_FRACTION = 0.75;
const DEFAULT_DOWNGRADE_AT_FRACTION = 1;
const DEFAULT_STOP_FAN_OUT_AT_FRACTION = 1;
const DEFAULT_PAUSE_AT_FRACTION = 1.5;
const DEFAULT_ACCOUNT_PRESSURE_USED_PCT = 90;

/**
 * `notify` and `downgrade` are automation acting on the agent and telling it what happened —
 * nothing for a person to do, so they are a ledger record. `pause` and `stopFanOut` leave an
 * agent stopped until someone raises its budget, so they still need a person. A dry run changed
 * nothing either way.
 */
function governorNotifyLevel(stage: SpendGovernorStage, dryRun: boolean): NotifyLevel {
  if (dryRun) return "record";
  return stage === "pause" || stage === "stopFanOut" ? "alert" : "record";
}

export interface SpendGovernorStageSettings {
  enabled?: boolean;
  atFraction?: number;
}

export interface SpendGovernorSettings {
  enabled?: boolean;
  dryRun?: boolean;
  defaultBudgetTokens?: number | null;
  downgradeToModel?: string | null;
  notify?: SpendGovernorStageSettings;
  downgrade?: SpendGovernorStageSettings;
  stopFanOut?: SpendGovernorStageSettings;
  pause?: SpendGovernorStageSettings;
}

export interface AccountPressureSettings {
  enabled?: boolean;
  usedPct?: number;
}

export interface TokenBurnMonitorConfig {
  enabled?: boolean;
  ratePerMinute?: number;
  sustainedMinutes?: number;
  totalTokens?: number;
  scope?: "all" | "topLevelOnly";
  breachBatchThreshold?: number;
  /** Opt-in enforcement ladder (agent/spend-governor.ts). Off unless this says otherwise. */
  governor?: SpendGovernorSettings;
  /** Opt-in report-only account usage leg. Off unless this says otherwise. */
  accountPressure?: AccountPressureSettings;
  /** Read by AgentModelDivergenceMonitor, which shares this config block. */
  modelDivergence?: ModelDivergenceMonitorSettings;
  /** Read by the usage-history sampler this monitor calls; recording is on unless disabled. */
  usageHistory?: UsageHistorySettings;
}

interface AgentTokenBurnMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentTokenBurnMonitorOptions {
  agentManager: Pick<
    AgentManager,
    | "listAgentsForTokenBurnMonitor"
    | "getTokenBurnMonitorState"
    | "setTokenBurnMonitorState"
    | "setTokenBurnAlert"
    | "clearTokenBurnAlert"
    | "getSpendGovernorState"
    | "setSpendGovernorState"
    | "setAgentModel"
    | "cancelAgentRun"
  >;
  agentStorage: Pick<AgentStorage, "get">;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  /**
   * Delivers ONE system-authored message into a running agent's conversation, the same narrow
   * injection AgentResourceMonitor takes for the same reason (see its doc comment). This is the
   * governor's agent-facing channel for all four stages: they are all mid-session events, and
   * the create-time channel — `providerOptions.appendSystemPrompt` — is folded into the SDK
   * options when the query is built, so changing it would mean restarting the session and
   * losing the very turn being governed.
   */
  sendSystemMessageToAgent: (agentId: string, body: string) => Promise<void>;
  /** Provider usage windows for the report-only account-pressure leg. Null when unreadable. */
  readProviderUsage?: () => Promise<readonly ProviderUsage[] | null>;
  /**
   * Where the account-pool-exhausted condition is reported. The ladder owns the person-facing
   * push for it; absent, it is observed by no one (docs/remediation.md).
   */
  remediationSink?: RemediationSink;
  /**
   * Records account usage windows and per-agent weighted spend once per sweep, so the daemon can
   * say how fast a window is filling (docs/usage-history.md). Rides this loop rather than adding
   * one. Absent, nothing is recorded.
   */
  usageHistory?: Pick<UsageHistorySampler, "sample">;
  /**
   * Model ids an agent's provider can actually be set to, so `downgrade` never moves an agent
   * onto a model that provider has never heard of. `downgradeToModel` is one global string and
   * the fleet is not one provider. Absent — a monitor built without it — skips the check and
   * behaves as it did before, which is what the tests that predate it rely on.
   */
  listProviderModels?: (provider: string) => Promise<readonly string[]>;
  readDaemonConfig: () => {
    tokenBurnMonitor?: TokenBurnMonitorConfig;
    /** Read for `resolveAccountPoolEntries`, to detect when the pool cannot route at all. */
    providers?: Record<string, unknown>;
  };
  logger: AgentTokenBurnMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface ResolvedAccountPressureConfig {
  enabled: boolean;
  usedPct: number;
}

interface ResolvedTokenBurnMonitorConfig extends DetectorConfig {
  scope: "all" | "topLevelOnly";
  breachBatchThreshold: number;
  governor: GovernorDecisionConfig;
  accountPressure: ResolvedAccountPressureConfig;
}

function resolveStage(
  settings: SpendGovernorStageSettings | undefined,
  defaults: { enabled: boolean; atFraction: number },
): { enabled: boolean; atFraction: number } {
  return {
    enabled: settings?.enabled ?? defaults.enabled,
    atFraction: settings?.atFraction ?? defaults.atFraction,
  };
}

function resolveGovernorConfig(
  settings: SpendGovernorSettings | undefined,
): GovernorDecisionConfig {
  return {
    enabled: settings?.enabled ?? false,
    dryRun: settings?.dryRun ?? false,
    defaultBudgetTokens: settings?.defaultBudgetTokens ?? null,
    downgradeToModel: settings?.downgradeToModel ?? null,
    // `notify` is the only stage on by default once the governor itself is on: turning the
    // governor on should start telling you things, never start changing things.
    notify: resolveStage(settings?.notify, {
      enabled: true,
      atFraction: DEFAULT_NOTIFY_AT_FRACTION,
    }),
    downgrade: resolveStage(settings?.downgrade, {
      enabled: false,
      atFraction: DEFAULT_DOWNGRADE_AT_FRACTION,
    }),
    stopFanOut: resolveStage(settings?.stopFanOut, {
      enabled: false,
      atFraction: DEFAULT_STOP_FAN_OUT_AT_FRACTION,
    }),
    pause: resolveStage(settings?.pause, {
      enabled: false,
      atFraction: DEFAULT_PAUSE_AT_FRACTION,
    }),
  };
}

function resolveConfig(config: TokenBurnMonitorConfig | undefined): ResolvedTokenBurnMonitorConfig {
  return {
    ratePerMinute: config?.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE,
    sustainedMinutes: config?.sustainedMinutes ?? DEFAULT_SUSTAINED_MINUTES,
    totalTokens: config?.totalTokens ?? DEFAULT_TOTAL_TOKENS,
    scope: config?.scope ?? "all",
    breachBatchThreshold: config?.breachBatchThreshold ?? DEFAULT_BREACH_BATCH_THRESHOLD,
    governor: resolveGovernorConfig(config?.governor),
    accountPressure: {
      enabled: config?.accountPressure?.enabled ?? false,
      usedPct: config?.accountPressure?.usedPct ?? DEFAULT_ACCOUNT_PRESSURE_USED_PCT,
    },
  };
}

const MINUTE_MS = 60_000;

/**
 * Identifies one usage cycle by its reset time, to the minute. Anthropic's `resets_at` carries
 * microsecond noise that changes on every fetch (`...:59.961495`, then `...:59.961514`, then
 * `...:00.027709` for the same window), so keying on the raw string made every 5-minute usage
 * refresh look like a new cycle: the 2026-09-22 daemon log has 14 consecutive "nearly exhausted"
 * pushes, five minutes apart, for windows that had not reset. Rounding to the nearest minute
 * absorbs the noise and still tells a 5-hour or 7-day cycle from the next one.
 */
function usageCycleKey(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return resetsAt;
  return new Date(Math.round(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

/** The threshold the breach crossed, for the badge. `total` only fires when one is configured. */
function buildTokenBurnAlert(
  trigger: "rate" | "total",
  config: ResolvedTokenBurnMonitorConfig,
  nowMs: number,
): TokenBurnAlert {
  return {
    trigger,
    ...(trigger === "rate" ? { ratePerMinute: config.ratePerMinute } : {}),
    ...(trigger === "total" && config.totalTokens !== null
      ? { totalTokens: config.totalTokens }
      : {}),
    firstBreachedAt: new Date(nowMs).toISOString(),
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

/**
 * What the agent itself is told. Every stage names the number, the budget, and what it should
 * do differently — an agent told only that something changed goes looking for the cause, and
 * that search is the expense this whole feature exists to prevent.
 */
function formatGovernorMessage(action: SpendGovernorAction): string {
  const pct = Math.round((action.spentTokens / action.budgetTokens) * 100);
  const spend =
    `${formatTokens(action.spentTokens)} of this task's ` +
    `${formatTokens(action.budgetTokens)} weighted-token budget (${pct}%)`;
  const head = `Bozeo spend governor: you have used ${spend}.`;
  switch (action.stage) {
    case "notify":
      return (
        `${head} Start wrapping up: finish the step you are on, skip anything optional, and ` +
        "do not open new lines of investigation. If the task genuinely needs more than its " +
        "budget, say so in your next message instead of spending it."
      );
    case "downgrade":
      return (
        `${head} Your model has been changed to ${action.targetModel} for the rest of this ` +
        "task. Nothing else changed — your conversation, files, and tools are intact, and you " +
        "did nothing wrong. Finish the remaining work; do not re-verify what you already did."
      );
    case "stopFanOut":
      return (
        `${head} create_agent is now refused for you, so you cannot delegate any more work. ` +
        "This is a budget cap, not a broken tool — retrying it will keep failing. Finish what " +
        "is left yourself, or stop and report what remains."
      );
    case "pause":
      return (
        `${head} This turn is being ended and a human has been notified. Do not start more ` +
        "work. When someone resumes you, they will have raised the budget or narrowed the " +
        "task — read their message before continuing."
      );
  }
}

function inScope(agent: TokenBurnMonitorAgentSummary, scope: "all" | "topLevelOnly"): boolean {
  if (agent.internal) return false;
  if (scope === "topLevelOnly" && agent.isDelegated) return false;
  return true;
}

interface Breach {
  agentId: string;
  workspaceId: string | undefined;
  trigger: TokenBurnAlert["trigger"];
  tokenRate: number | undefined;
  totalTokens: number | undefined;
}

/**
 * Daemon-side, absolute-threshold safety net — distinct from the client-side relative badge
 * (recentTokenRate). Runs on its own unref'd 60s timer, mirroring AgentTitleTracker's shape:
 * a fresh config read each tick (live-toggleable, see daemon-config-store.ts's tokenBurnMonitor
 * treatment) and no persisted state of its own — everything it tracks lives on the live
 * ManagedAgent (agent-manager.ts) and disappears with the agent.
 *
 * See docs/plans/2026-09-12-006-feat-token-burn-monitor-plan.md.
 */
export class AgentTokenBurnMonitor {
  private readonly agentManager: AgentTokenBurnMonitorOptions["agentManager"];
  private readonly agentStorage: Pick<AgentStorage, "get">;
  private readonly pushNotificationSender: PushNotificationSender;
  private readonly serverId: string;
  private readonly sendSystemMessageToAgent: AgentTokenBurnMonitorOptions["sendSystemMessageToAgent"];
  private readonly readProviderUsage: AgentTokenBurnMonitorOptions["readProviderUsage"];
  private readonly usageHistory: AgentTokenBurnMonitorOptions["usageHistory"];
  private readonly listProviderModels: AgentTokenBurnMonitorOptions["listProviderModels"];
  private readonly readDaemonConfig: AgentTokenBurnMonitorOptions["readDaemonConfig"];
  private readonly remediationSink: RemediationSink;
  private readonly logger: AgentTokenBurnMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Account-pressure legs that have already reported, keyed `providerId:windowId` and valued by
   * the window's `resetsAt`. A window that resets gets a fresh warning; one that keeps sitting
   * at 94% does not re-warn every 60 seconds for the rest of the week.
   */
  private reportedAccountWindows = new Map<string, string>();
  /** Whether the account-pool-exhausted episode is currently open (docs/remediation.md). */
  private poolExhaustedEpisodeOpen = false;
  private sweepInFlight = false;
  private readonly modeLog: MonitorModeLog;

  constructor(options: AgentTokenBurnMonitorOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.pushNotificationSender = options.pushNotificationSender;
    this.serverId = options.serverId;
    this.sendSystemMessageToAgent = options.sendSystemMessageToAgent;
    this.readProviderUsage = options.readProviderUsage;
    this.usageHistory = options.usageHistory;
    this.listProviderModels = options.listProviderModels;
    this.readDaemonConfig = options.readDaemonConfig;
    this.remediationSink = options.remediationSink ?? NULL_REMEDIATION_SINK;
    this.logger = options.logger;
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
        this.logger.error({ err: error }, "Token burn monitor sweep failed");
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

  async tick(): Promise<void> {
    // The governor awaits real work per action — a steer into an agent, a model change, a turn
    // cancellation — so a slow sweep can outlive the 60s interval. Overlapping sweeps would
    // plan against stale fired-stage state and could pause an agent twice.
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** Logs the mode this monitor reads from its config, once per change (monitor-mode-log.ts). */
  reportMode(): void {
    const rawConfig = this.readDaemonConfig().tokenBurnMonitor;
    const enabled = rawConfig?.enabled !== false;
    const config = resolveConfig(rawConfig);
    this.modeLog.report([
      { monitor: "token-burn", enabled },
      {
        monitor: "spend-governor",
        enabled: enabled && config.governor.enabled,
        dryRun: config.governor.dryRun,
      },
      { monitor: "account-pressure", enabled: enabled && config.accountPressure.enabled },
    ]);
  }

  private async sweep(): Promise<void> {
    this.reportMode();
    const rawConfig = this.readDaemonConfig().tokenBurnMonitor;
    if (rawConfig?.enabled === false) {
      return;
    }
    const config = resolveConfig(rawConfig);
    const nowMs = this.now();
    const agents = this.agentManager.listAgentsForTokenBurnMonitor(nowMs);
    await this.usageHistory?.sample({ nowMs, agents });
    // Account pressure is a machine-level leg: it matters with zero live agents, so it runs
    // before the per-agent early return, the way AgentResourceMonitor's swap leg does.
    await this.reportAccountPressure(config.accountPressure);
    if (agents.length === 0) {
      return;
    }

    const breaches: Breach[] = [];
    const governorActions: Array<{
      agent: TokenBurnMonitorAgentSummary;
      action: SpendGovernorAction;
    }> = [];

    for (const agent of agents) {
      if (!inScope(agent, config.scope)) {
        continue;
      }
      // Planned inside the same loop as the threshold legs but acted on after it: an action
      // steers into an agent or cancels its turn, and doing that mid-loop would interleave
      // provider round-trips with the rest of the sweep's bookkeeping.
      const plan = planSpendGovernorActions({
        agent: {
          id: agent.id,
          labels: agent.labels,
          totalTokens: agent.totalTokens,
          isRunning: agent.isRunning,
          model: agent.model,
        },
        config: config.governor,
        previousState: this.agentManager.getSpendGovernorState(agent.id),
      });
      this.agentManager.setSpendGovernorState(agent.id, plan.nextState);
      for (const action of plan.actions) {
        governorActions.push({ agent, action });
      }

      const previousState = this.agentManager.getTokenBurnMonitorState(agent.id);
      const result = evaluateTokenBurn({
        // The trailing-window rate keeps reading high for up to five minutes after an agent's
        // last request, so only a running agent may breach the rate leg — an idle agent that
        // just finished a heavy turn is not "burning". The total leg is gated the same way for
        // a different reason: an agent that has stopped cannot spend any more, so an alert
        // about what it already spent names nothing anyone can do.
        tokenRate: agent.isRunning ? agent.tokenRate : undefined,
        totalTokens: agent.isRunning ? agent.totalTokens : undefined,
        config,
        previousState,
      });
      this.agentManager.setTokenBurnMonitorState(agent.id, result.nextState);

      const justRearmed = previousState?.rateFired === true && !result.nextState.rateFired;
      if (justRearmed) {
        this.agentManager.clearTokenBurnAlert(agent.id);
      }

      if (!result.trigger) {
        continue;
      }

      const alert = buildTokenBurnAlert(result.trigger, config, nowMs);
      this.agentManager.setTokenBurnAlert(agent.id, alert);
      breaches.push({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        trigger: result.trigger,
        tokenRate: agent.tokenRate,
        totalTokens: agent.totalTokens,
      });
    }

    await this.performGovernorActions(governorActions, config.governor.dryRun);

    if (breaches.length === 0) {
      return;
    }

    if (breaches.length > config.breachBatchThreshold) {
      await this.sendPush(
        buildBatchedTokenBurnNotificationPayload({
          serverId: this.serverId,
          breaches: breaches.map((breach) => ({
            agentId: breach.agentId,
            workspaceId: breach.workspaceId,
          })),
        }),
        { level: "notice" },
      );
      return;
    }

    for (const breach of breaches) {
      const record = await this.agentStorage.get(breach.agentId).catch(() => null);
      await this.sendPush(
        buildTokenBurnNotificationPayload({
          serverId: this.serverId,
          workspaceId: breach.workspaceId,
          agentId: breach.agentId,
          agentTitle: record?.title ?? null,
          trigger: breach.trigger,
          ratePerMinute: breach.tokenRate,
          totalTokens: breach.totalTokens,
        }),
        // A fast agent is usually a busy one. The per-agent alert on the row still shows it.
        { level: "notice" },
      );
    }
  }

  /**
   * Performs the ladder. Each action is independent: one that throws is logged and the rest
   * still run, because a failed downgrade must not stop the pause behind it. Ordering within
   * one agent is the ladder's own (spend-governor.ts's SPEND_GOVERNOR_STAGES), so an agent
   * that crosses several thresholds in one sweep is told, downgraded, cut off, and paused in
   * that order rather than paused before it is ever told why.
   */
  private async performGovernorActions(
    planned: ReadonlyArray<{ agent: TokenBurnMonitorAgentSummary; action: SpendGovernorAction }>,
    dryRun: boolean,
  ): Promise<void> {
    for (const { agent, action } of planned) {
      if (action.redelivery) {
        // The stage already happened and was already pushed, on a sweep where the agent was
        // idle and could not be steered. Only the message is outstanding: perform nothing,
        // push nothing again, just say the thing it never heard.
        await this.tellAgent(action.agentId, formatGovernorMessage(action));
        this.logger.info(
          {
            agentId: action.agentId,
            stage: action.stage,
            budgetTokens: action.budgetTokens,
            spentTokens: Math.round(action.spentTokens),
          },
          "Spend governor told a resumed agent about a stage it missed",
        );
        continue;
      }
      if (dryRun) {
        this.logger.info(
          {
            dryRun: true,
            agentId: action.agentId,
            stage: action.stage,
            budgetTokens: action.budgetTokens,
            spentTokens: Math.round(action.spentTokens),
            ...(action.targetModel ? { targetModel: action.targetModel } : {}),
          },
          "Spend governor would act on an over-budget agent",
        );
      } else {
        try {
          if (!(await this.applyGovernorAction(action, agent))) {
            // Skipped, not failed, and already logged with its reason. No success log and no
            // push: a notification announcing a downgrade that did not happen is worse than
            // silence, because it is the only record most people ever read.
            continue;
          }
        } catch (error) {
          this.logger.warn(
            { err: error, agentId: action.agentId, stage: action.stage },
            "Spend governor action failed",
          );
          continue;
        }
        this.logger.info(
          {
            agentId: action.agentId,
            stage: action.stage,
            budgetTokens: action.budgetTokens,
            spentTokens: Math.round(action.spentTokens),
            ...(action.targetModel ? { targetModel: action.targetModel } : {}),
          },
          "Spend governor acted on an over-budget agent",
        );
      }

      const record = await this.agentStorage.get(action.agentId).catch(() => null);
      await this.sendPush(
        buildSpendGovernorNotificationPayload({
          serverId: this.serverId,
          ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
          agentId: action.agentId,
          agentTitle: record?.title ?? null,
          stage: action.stage,
          budgetTokens: action.budgetTokens,
          spentTokens: action.spentTokens,
          dryRun,
          ...(action.targetModel ? { detail: action.targetModel } : {}),
        }),
        { level: governorNotifyLevel(action.stage, dryRun) },
      );
    }
  }

  /** True when the stage was performed. False when it was deliberately skipped and logged. */
  private async applyGovernorAction(
    action: SpendGovernorAction,
    agent: TokenBurnMonitorAgentSummary,
  ): Promise<boolean> {
    const isRunning = agent.isRunning;
    const body = formatGovernorMessage(action);
    switch (action.stage) {
      case "notify":
      case "stopFanOut":
        // stopFanOut needs no daemon-side act beyond the state the planner already wrote —
        // `create_agent` reads it (agent-manager.ts's getSpendFanOutDenial). Telling the agent
        // up front is what stops it from burning a retry loop discovering the refusal.
        //
        // Only while it is mid-turn, though. These two stages can fire on an idle agent, and
        // the steer path starts a fresh turn for one (agent-prompt.ts's fallback) — spending
        // tokens to tell an agent it is out of tokens, on the exact agent already over budget.
        // An idle agent gets the push and the live alert, and for stopFanOut the `create_agent`
        // refusal itself, which arrives at the only moment it changes anything.
        if (isRunning) {
          await this.tellAgent(action.agentId, body);
        }
        return true;
      case "downgrade":
        // Only reached for a running agent: spend-governor.ts defers this stage otherwise.
        // `setAgentModel` on a live session calls the SDK's `query.setModel()`, which applies
        // from the next API request in the same turn: the request already in flight finishes
        // on the old model, the conversation is untouched, and no session restart happens. The
        // notice goes out after the change so it is true when the agent reads it.
        if (!(await this.providerOffersModel(agent.provider, action.targetModel))) {
          this.logger.warn(
            {
              agentId: action.agentId,
              provider: agent.provider,
              targetModel: action.targetModel,
            },
            "Spend governor skipped a downgrade: the target model is not in this agent's provider catalog",
          );
          return false;
        }
        await this.agentManager.setAgentModel(action.agentId, action.targetModel ?? null);
        await this.tellAgent(action.agentId, body);
        return true;
      case "pause":
        // Steer first, cancel second. The other order leaves an idle agent, and steering into
        // an idle agent starts a fresh turn (agent-prompt.ts's fallback) — spending tokens to
        // say it is over budget. This way the reason lands in the transcript for whoever
        // resumes it, and then the turn ends.
        await this.tellAgent(action.agentId, body);
        // Flag it before the cancel, not after. `cancelReason` is log-only and the governor has
        // no `attentionReason` of its own, so without this a paused agent is indistinguishable
        // in the app from one that finished its turn normally — a push notification and then
        // nothing to find. The alert is what agent-state-bucket.ts already treats as
        // attention-worthy. Before rather than after because an agent whose cancel failed is
        // still over budget and still worth a human's eye, so the flag is true either way.
        this.agentManager.setTokenBurnAlert(action.agentId, {
          trigger: "total",
          totalTokens: action.budgetTokens,
          budgetTokens: action.budgetTokens,
          spentTokens: action.spentTokens,
          governorStage: action.stage,
          firstBreachedAt: new Date(this.now()).toISOString(),
        });
        await this.agentManager.cancelAgentRun(action.agentId, "spend-governor");
        return true;
    }
  }

  /**
   * Whether this provider will accept the model `downgrade` wants to move to. `downgradeToModel`
   * is one global string and the fleet is not one provider, so without this a Codex agent that
   * carried a budget label was handed a Claude model id — `setAgentModel` validates nothing, it
   * just sets it.
   *
   * An unreadable catalog counts as no. The cost of skipping a downgrade is that an agent keeps
   * running on the model it was already on; the cost of guessing wrong is an agent set to a
   * model its provider has never heard of, which is the failure this whole review class is
   * about. Silence is the safe direction here, and it is logged either way.
   */
  private async providerOffersModel(
    provider: string,
    targetModel: string | undefined,
  ): Promise<boolean> {
    if (!targetModel || !this.listProviderModels) return true;
    try {
      return (await this.listProviderModels(provider)).includes(targetModel);
    } catch (error) {
      this.logger.warn(
        { err: error, provider, targetModel },
        "Spend governor could not read a provider's models; leaving the agent's model alone",
      );
      return false;
    }
  }

  /** The agent's own channel. A failure here never aborts the action it describes. */
  private async tellAgent(agentId: string, body: string): Promise<void> {
    try {
      await this.sendSystemMessageToAgent(agentId, body);
    } catch (error) {
      this.logger.warn(
        { err: error, agentId },
        "Failed to steer spend-governor message into agent",
      );
    }
  }

  /**
   * Report-only, by design. The daemon can see a provider's usage windows directly, but acting
   * on them here would fight two things that already own the decision: the account pool plugin
   * routes new agents away from a hot account, so refusing a caller's `create_agent` would
   * block a child that would have been placed on a healthy account anyway; and
   * AccountFailoverMonitor already migrates agents off an account at 100%. What nothing does
   * today is say so before the wall — which is the whole value here. See
   * docs/account-failover.md.
   */
  private async reportAccountPressure(config: ResolvedAccountPressureConfig): Promise<void> {
    if (!config.enabled || !this.readProviderUsage) {
      // Evidence is dropped when the leg is off, so turning it back on warns afresh rather
      // than staying silent about a window that crossed while nobody was watching.
      this.reportedAccountWindows.clear();
      await this.closePoolExhaustedEpisode();
      return;
    }
    const usage = await this.readProviderUsage().catch((error: unknown) => {
      this.logger.warn({ err: error }, "Failed to read provider usage for account pressure");
      return null;
    });
    if (!usage) {
      return;
    }

    const stillHot = new Map<string, string>();
    for (const provider of usage) {
      for (const window of provider.windows) {
        const usedPct = window.usedPct;
        if (typeof usedPct !== "number" || usedPct < config.usedPct) {
          continue;
        }
        const key = `${provider.providerId}:${window.id}`;
        const cycle = usageCycleKey(window.resetsAt);
        stillHot.set(key, cycle);
        if (this.reportedAccountWindows.get(key) === cycle) {
          continue;
        }
        // The push names the account; the log did not, which left a week of warnings
        // unattributable after the fact.
        this.logger.info(
          {
            providerId: provider.providerId,
            windowId: window.id,
            usedPct,
            thresholdPct: config.usedPct,
            resetsAt: window.resetsAt,
          },
          "Account pressure: usage window is over the warning threshold",
        );
        await this.sendPush(
          buildAccountUsagePressureNotificationPayload({
            serverId: this.serverId,
            providerId: provider.providerId,
            displayName: provider.displayName,
            windowLabel: window.label,
            usedPct,
            resetsAt: window.resetsAt,
          }),
          // The pool routes new work off a hot account and failover migrates agents already on
          // one, so a single account nearing its cap is the pool's problem, not a person's — a
          // ledger record rather than a push. The pool-cannot-route-at-all condition below is
          // the one that still needs a person.
          { level: "record", dedupeKey: `account-pressure:${key}` },
        );
      }
    }
    // Only windows still over threshold are remembered, so one that drops back under and
    // climbs again inside the same cycle warns a second time.
    this.reportedAccountWindows = stillHot;

    await this.reportPoolExhaustion(usage, config);
  }

  /**
   * The condition neither the pool nor failover can fix: every account the pool could route to
   * is over threshold, so there is nowhere left to move work. Reported to the ladder rather than
   * pushed directly — `remedy: "none"` and no `escalation`, since an agent would need an account
   * to do anything either. The ladder still dedupes it to one push per episode.
   */
  private async reportPoolExhaustion(
    usage: readonly ProviderUsage[],
    config: ResolvedAccountPressureConfig,
  ): Promise<void> {
    const usageByProvider = new Map(usage.map((provider) => [provider.providerId, provider]));
    const poolEntries = resolveAccountPoolEntries(this.readDaemonConfig().providers).filter(
      (entry) => entry.enabled,
    );
    const candidateIds =
      poolEntries.length > 0
        ? poolEntries.map((entry) => entry.providerId)
        : [...usageByProvider.keys()];

    const capped: Array<{
      providerId: string;
      usedPct: number;
      windowLabel: string;
      resetsAt: string | null | undefined;
    }> = [];
    let allCapped = candidateIds.length > 0;
    for (const providerId of candidateIds) {
      const provider = usageByProvider.get(providerId);
      const hotWindow = provider?.windows
        .filter((window) => typeof window.usedPct === "number" && window.usedPct >= config.usedPct)
        .sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0];
      if (!hotWindow) {
        allCapped = false;
        continue;
      }
      capped.push({
        providerId,
        usedPct: hotWindow.usedPct as number,
        windowLabel: hotWindow.label,
        resetsAt: hotWindow.resetsAt,
      });
    }

    if (!allCapped) {
      await this.closePoolExhaustedEpisode();
      return;
    }

    this.poolExhaustedEpisodeOpen = true;
    const evidence = capped
      .map(
        (row) =>
          `- ${row.providerId}: ${row.usedPct}% of ${row.windowLabel}` +
          (row.resetsAt ? `, resets ${row.resetsAt}` : ""),
      )
      .join("\n");
    await this.remediationSink.observe({
      key: "account-pool-exhausted",
      kind: "account-pool-exhausted",
      active: true,
      remedy: "none",
      title: "No Claude account can take new work",
      summary: `Every account the pool could route to is at or above ${config.usedPct}% of a usage window.`,
      evidence,
      level: "urgent",
    });
  }

  private async closePoolExhaustedEpisode(): Promise<void> {
    if (!this.poolExhaustedEpisodeOpen) {
      return;
    }
    this.poolExhaustedEpisodeOpen = false;
    await this.remediationSink.observe({
      key: "account-pool-exhausted",
      kind: "account-pool-exhausted",
      active: false,
      remedy: "none",
      title: "No Claude account can take new work",
      summary: "At least one pool account has budget again.",
      level: "urgent",
    });
  }

  private async sendPush(
    payload: {
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
    meta: PushSendMeta,
  ): Promise<void> {
    try {
      await this.pushNotificationSender.send(payload, meta);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send token-burn push notification");
    }
  }
}
