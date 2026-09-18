import type { TokenBurnAlert } from "@getpaseo/protocol/agent-types";
import {
  buildBatchedTokenBurnNotificationPayload,
  buildSpendGovernorNotificationPayload,
  buildTokenBurnNotificationPayload,
} from "@getpaseo/protocol/token-burn-notification";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  evaluateTokenBurn,
  type TokenBurnMonitorConfig as DetectorConfig,
} from "./agent/token-burn-detector.js";
import {
  planSpendGovernorActions,
  type SpendGovernorAction,
  type SpendGovernorConfig as GovernorDecisionConfig,
} from "./agent/spend-governor.js";
import type { PushNotificationSender } from "./push/index.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_RATE_PER_MINUTE = 50_000;
const DEFAULT_SUSTAINED_MINUTES = 3;
const DEFAULT_TOTAL_TOKENS = 5_000_000;
const DEFAULT_BREACH_BATCH_THRESHOLD = 3;
// Governor defaults. Off unless turned on, and every stage past `notify` off even then, so
// enabling it can only ever start reporting. Fractions are multiples of the task's budget:
// warn before it runs out, act at it, stop it well past it.
const DEFAULT_NOTIFY_AT_FRACTION = 0.75;
const DEFAULT_DOWNGRADE_AT_FRACTION = 1;
const DEFAULT_STOP_FAN_OUT_AT_FRACTION = 1;
const DEFAULT_PAUSE_AT_FRACTION = 1.5;

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

export interface TokenBurnMonitorConfig {
  enabled?: boolean;
  ratePerMinute?: number;
  sustainedMinutes?: number;
  totalTokens?: number;
  scope?: "all" | "topLevelOnly";
  breachBatchThreshold?: number;
  /** Opt-in enforcement ladder (agent/spend-governor.ts). Off unless this says otherwise. */
  governor?: SpendGovernorSettings;
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
  readDaemonConfig: () => { tokenBurnMonitor?: TokenBurnMonitorConfig };
  logger: AgentTokenBurnMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface ResolvedTokenBurnMonitorConfig extends DetectorConfig {
  scope: "all" | "topLevelOnly";
  breachBatchThreshold: number;
  governor: GovernorDecisionConfig;
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
  private readonly readDaemonConfig: () => { tokenBurnMonitor?: TokenBurnMonitorConfig };
  private readonly logger: AgentTokenBurnMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;

  constructor(options: AgentTokenBurnMonitorOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.pushNotificationSender = options.pushNotificationSender;
    this.serverId = options.serverId;
    this.sendSystemMessageToAgent = options.sendSystemMessageToAgent;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
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

  private async sweep(): Promise<void> {
    const rawConfig = this.readDaemonConfig().tokenBurnMonitor;
    if (rawConfig?.enabled === false) {
      return;
    }
    const config = resolveConfig(rawConfig);
    const nowMs = this.now();
    const agents = this.agentManager.listAgentsForTokenBurnMonitor(nowMs);
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
        // just finished a heavy turn is not "burning". The total leg is cumulative and applies
        // regardless of lifecycle.
        tokenRate: agent.isRunning ? agent.tokenRate : undefined,
        totalTokens: agent.totalTokens,
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

      const alert: TokenBurnAlert = {
        trigger: result.trigger,
        ...(result.trigger === "rate" ? { ratePerMinute: config.ratePerMinute } : {}),
        ...(result.trigger === "total" ? { totalTokens: config.totalTokens } : {}),
        firstBreachedAt: new Date(nowMs).toISOString(),
      };
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
          await this.applyGovernorAction(action);
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
      );
    }
  }

  private async applyGovernorAction(action: SpendGovernorAction): Promise<void> {
    const body = formatGovernorMessage(action);
    switch (action.stage) {
      case "notify":
      case "stopFanOut":
        // stopFanOut needs no daemon-side act beyond the state the planner already wrote —
        // `create_agent` reads it (agent-manager.ts's getSpendFanOutDenial). Telling the agent
        // up front is what stops it from burning a retry loop discovering the refusal.
        await this.tellAgent(action.agentId, body);
        return;
      case "downgrade":
        // `setAgentModel` on a live session calls the SDK's `query.setModel()`, which applies
        // from the next API request in the same turn: the request already in flight finishes
        // on the old model, the conversation is untouched, and no session restart happens. The
        // notice goes out after the change so it is true when the agent reads it.
        await this.agentManager.setAgentModel(action.agentId, action.targetModel ?? null);
        await this.tellAgent(action.agentId, body);
        return;
      case "pause":
        // Steer first, cancel second. The other order leaves an idle agent, and steering into
        // an idle agent starts a fresh turn (agent-prompt.ts's fallback) — spending tokens to
        // say it is over budget. This way the reason lands in the transcript for whoever
        // resumes it, and then the turn ends.
        await this.tellAgent(action.agentId, body);
        await this.agentManager.cancelAgentRun(action.agentId);
        return;
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

  private async sendPush(payload: {
    title: string;
    body: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.pushNotificationSender.send(payload);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send token-burn push notification");
    }
  }
}
