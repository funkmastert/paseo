import type { TokenBurnAlert } from "@getpaseo/protocol/agent-types";
import {
  buildBatchedTokenBurnNotificationPayload,
  buildTokenBurnNotificationPayload,
} from "@getpaseo/protocol/token-burn-notification";
import type { AgentManager, TokenBurnMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  evaluateTokenBurn,
  type TokenBurnMonitorConfig as DetectorConfig,
} from "./agent/token-burn-detector.js";
import type { PushNotificationSender } from "./push/index.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_RATE_PER_MINUTE = 50_000;
const DEFAULT_SUSTAINED_MINUTES = 3;
const DEFAULT_TOTAL_TOKENS = 5_000_000;
const DEFAULT_BREACH_BATCH_THRESHOLD = 3;

export interface TokenBurnMonitorConfig {
  enabled?: boolean;
  ratePerMinute?: number;
  sustainedMinutes?: number;
  totalTokens?: number;
  scope?: "all" | "topLevelOnly";
  breachBatchThreshold?: number;
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
  >;
  agentStorage: Pick<AgentStorage, "get">;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  readDaemonConfig: () => { tokenBurnMonitor?: TokenBurnMonitorConfig };
  logger: AgentTokenBurnMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface ResolvedTokenBurnMonitorConfig extends DetectorConfig {
  scope: "all" | "topLevelOnly";
  breachBatchThreshold: number;
}

function resolveConfig(config: TokenBurnMonitorConfig | undefined): ResolvedTokenBurnMonitorConfig {
  return {
    ratePerMinute: config?.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE,
    sustainedMinutes: config?.sustainedMinutes ?? DEFAULT_SUSTAINED_MINUTES,
    totalTokens: config?.totalTokens ?? DEFAULT_TOTAL_TOKENS,
    scope: config?.scope ?? "all",
    breachBatchThreshold: config?.breachBatchThreshold ?? DEFAULT_BREACH_BATCH_THRESHOLD,
  };
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
  private readonly readDaemonConfig: () => { tokenBurnMonitor?: TokenBurnMonitorConfig };
  private readonly logger: AgentTokenBurnMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentTokenBurnMonitorOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.pushNotificationSender = options.pushNotificationSender;
    this.serverId = options.serverId;
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

    for (const agent of agents) {
      if (!inScope(agent, config.scope)) {
        continue;
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
