import { buildPluginOfflineNotificationPayload } from "@getpaseo/protocol/plugin-connection-notification";
import {
  evaluateSustainedBreach,
  type SustainedBreachState,
} from "./agent/sustained-breach-detector.js";
import type { PushNotificationSender } from "./push/index.js";

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_OFFLINE_THRESHOLD_MS = 60_000;

export interface PluginConnectivity {
  pluginId: string;
  connected: boolean;
}

interface PluginConnectionMonitorLogger {
  error: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface PluginConnectionMonitorOptions {
  listConnectivity: () => readonly PluginConnectivity[];
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  logger: PluginConnectionMonitorLogger;
  sweepIntervalMs?: number;
  offlineThresholdMs?: number;
  now?: () => number;
}

interface PluginOfflineState {
  breach: SustainedBreachState;
  offlineSince: number | null;
}

/**
 * Alerts when an enabled plugin stays unable to reach its daemon session, whether its
 * process is gone or its session dropped. A plugin in that state skips every hook it owns
 * while looking installed, which is how account-pool routing failed open unnoticed for 20
 * hours. Same shape as AgentResourceMonitor: unref'd sweep, one episode per breach, re-armed
 * after the same number of connected sweeps (agent/sustained-breach-detector.ts).
 */
export class PluginConnectionMonitor {
  private readonly options: PluginConnectionMonitorOptions;
  private readonly sweepIntervalMs: number;
  private readonly offlineThresholdMs: number;
  private readonly now: () => number;
  private readonly states = new Map<string, PluginOfflineState>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PluginConnectionMonitorOptions) {
    this.options = options;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.offlineThresholdMs = options.offlineThresholdMs ?? DEFAULT_OFFLINE_THRESHOLD_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  sweep(): void {
    const nowMs = this.now();
    // One extra sweep so an episode never fires before the threshold has fully elapsed.
    const sustainedSweeps = Math.ceil(this.offlineThresholdMs / this.sweepIntervalMs) + 1;
    const current = new Set<string>();
    for (const { pluginId, connected } of this.options.listConnectivity()) {
      current.add(pluginId);
      const previous = this.states.get(pluginId);
      const result = evaluateSustainedBreach({
        value: connected ? 0 : 1,
        threshold: 1,
        sustainedSweeps,
        previousState: previous?.breach,
      });
      const offlineSince = connected ? null : (previous?.offlineSince ?? nowMs);
      this.states.set(pluginId, { breach: result.nextState, offlineSince });
      if (result.triggered) this.reportOffline(pluginId, nowMs - (offlineSince ?? nowMs));
    }
    for (const pluginId of this.states.keys()) {
      if (!current.has(pluginId)) this.states.delete(pluginId);
    }
  }

  private reportOffline(pluginId: string, offlineForMs: number): void {
    this.options.logger.error(
      { pluginId, offlineForMs },
      "Plugin has been unable to reach its daemon session past the alert threshold",
    );
    void this.options.pushNotificationSender
      .send(
        buildPluginOfflineNotificationPayload({
          serverId: this.options.serverId,
          pluginId,
          offlineForMs,
        }),
        { level: "notice", dedupeKey: `plugin-offline:${pluginId}` },
      )
      .catch((error: unknown) => {
        this.options.logger.warn(
          { err: error, pluginId },
          "Failed to send plugin-offline push notification",
        );
      });
  }
}
