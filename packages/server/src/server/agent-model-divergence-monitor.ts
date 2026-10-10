import type { ModelDivergenceAlert } from "@getpaseo/protocol/agent-types";
import { buildModelDivergenceNotificationPayload } from "@getpaseo/protocol/model-divergence-notification";
import type { AgentManager } from "./agent/agent-manager.js";
import {
  DEFAULT_PERSIST_MS,
  DEFAULT_PERSIST_RESPONSES,
  divergenceKey,
  isDivergencePersisting,
  type ModelDivergence,
} from "./agent/model-divergence.js";
import type { PushNotificationSender } from "./push/index.js";
import { MonitorModeLog } from "./monitor-mode-log.js";

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface ModelDivergenceMonitorSettings {
  enabled?: boolean;
  /** Consecutive wrong responses before a finding counts as persisting. */
  persistResponses?: number;
  /** Time between the first and latest wrong response before it counts as persisting. */
  persistSeconds?: number;
}

interface AgentModelDivergenceMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentModelDivergenceMonitorOptions {
  agentManager: Pick<
    AgentManager,
    "listAgentsForModelDivergenceMonitor" | "setModelDivergenceAlert" | "clearModelDivergenceAlert"
  >;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  readSettings: () => ModelDivergenceMonitorSettings | undefined;
  logger: AgentModelDivergenceMonitorLogger;
  sweepIntervalMs?: number;
}

function toAlert(divergence: ModelDivergence, persisting: boolean): ModelDivergenceAlert {
  return {
    configuredModel: divergence.configuredModel,
    observedModel: divergence.observedModel,
    firstObservedAt: new Date(divergence.firstObservedAt).toISOString(),
    responses: divergence.responses,
    persisted: persisting,
  };
}

function sameAlert(a: ModelDivergenceAlert, b: ModelDivergenceAlert): boolean {
  return (
    a.configuredModel === b.configuredModel &&
    a.observedModel === b.observedModel &&
    a.firstObservedAt === b.firstObservedAt &&
    a.responses === b.responses &&
    a.persisted === b.persisted
  );
}

/**
 * Surfaces the model-divergence state AgentManager keeps for every agent (docs/model-divergence.md).
 * The state costs a string compare per response and is always kept; this monitor is the opt-in
 * part. It reads a verdict, it never compares models itself, so what counts as an intentional
 * change lives in one place (agent/model-divergence.ts).
 *
 * A finding is announced once per agent per (configured, observed) pair: one log line when it
 * first shows, one push once it has persisted. The badge follows the live state, so a mismatch
 * that recovers and returns shows again, without a second log line or push.
 */
export class AgentModelDivergenceMonitor {
  private readonly agentManager: AgentModelDivergenceMonitorOptions["agentManager"];
  private readonly pushNotificationSender: PushNotificationSender;
  private readonly serverId: string;
  private readonly readSettings: AgentModelDivergenceMonitorOptions["readSettings"];
  private readonly logger: AgentModelDivergenceMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly modeLog: MonitorModeLog;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Findings already logged and already pushed, per agent. Forgotten with the agent. */
  private readonly logged = new Map<string, Set<string>>();
  private readonly pushed = new Map<string, Set<string>>();

  constructor(options: AgentModelDivergenceMonitorOptions) {
    this.agentManager = options.agentManager;
    this.pushNotificationSender = options.pushNotificationSender;
    this.serverId = options.serverId;
    this.readSettings = options.readSettings;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.modeLog = new MonitorModeLog(options.logger);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.reportMode();
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Model divergence monitor sweep failed");
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
    this.modeLog.report([
      { monitor: "model-divergence", enabled: this.readSettings()?.enabled === true },
    ]);
  }

  async tick(): Promise<void> {
    this.reportMode();
    const settings = this.readSettings();
    const agents = this.agentManager.listAgentsForModelDivergenceMonitor();
    if (settings?.enabled !== true) {
      // Turning the monitor off takes the badge with it, and forgets what was announced so that
      // turning it back on reports a standing finding again.
      for (const agent of agents) {
        if (agent.shownAlert) this.agentManager.clearModelDivergenceAlert(agent.id);
      }
      this.logged.clear();
      this.pushed.clear();
      return;
    }
    const thresholds = {
      persistResponses: settings.persistResponses ?? DEFAULT_PERSIST_RESPONSES,
      persistMs:
        settings.persistSeconds !== undefined ? settings.persistSeconds * 1000 : DEFAULT_PERSIST_MS,
    };
    const liveIds = new Set<string>();
    for (const agent of agents) {
      liveIds.add(agent.id);
      if (agent.internal) continue;
      const { divergence } = agent;
      if (!divergence) {
        if (agent.shownAlert) this.agentManager.clearModelDivergenceAlert(agent.id);
        continue;
      }
      const persisting = isDivergencePersisting(divergence, thresholds);
      const alert = toAlert(divergence, persisting);
      if (!agent.shownAlert || !sameAlert(agent.shownAlert, alert)) {
        this.agentManager.setModelDivergenceAlert(agent.id, alert);
      }
      const key = divergenceKey(divergence);
      if (this.markOnce(this.logged, agent.id, key)) {
        this.logger.warn(
          {
            agentId: agent.id,
            configuredModel: divergence.configuredModel,
            observedModel: divergence.observedModel,
          },
          "Model divergence: agent responses report a model other than the one it was configured with",
        );
      }
      if (persisting && this.markOnce(this.pushed, agent.id, key)) {
        await this.push(agent.id, agent.workspaceId, agent.title, divergence);
      }
    }
    for (const agentId of this.logged.keys()) {
      if (!liveIds.has(agentId)) this.logged.delete(agentId);
    }
    for (const agentId of this.pushed.keys()) {
      if (!liveIds.has(agentId)) this.pushed.delete(agentId);
    }
  }

  /** True the first time `key` is seen for `agentId`, false ever after. */
  private markOnce(book: Map<string, Set<string>>, agentId: string, key: string): boolean {
    let seen = book.get(agentId);
    if (!seen) {
      seen = new Set();
      book.set(agentId, seen);
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  private async push(
    agentId: string,
    workspaceId: string | undefined,
    title: string | null,
    divergence: ModelDivergence,
  ): Promise<void> {
    try {
      await this.pushNotificationSender.send(
        buildModelDivergenceNotificationPayload({
          serverId: this.serverId,
          ...(workspaceId ? { workspaceId } : {}),
          agentId,
          agentTitle: title,
          configuredModel: divergence.configuredModel,
          observedModel: divergence.observedModel,
          responses: divergence.responses,
        }),
        { level: "notice", dedupeKey: `model-divergence:${agentId}` },
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send model-divergence push notification");
    }
  }
}
