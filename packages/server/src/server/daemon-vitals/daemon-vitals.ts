import path from "node:path";
import { buildDaemonWedgedNotificationPayload } from "@getpaseo/protocol/daemon-vitals-notification";
import { MonitorModeLog } from "../monitor-mode-log.js";
import type { PushNotificationSender } from "../push/index.js";
import { EventLoopMonitor, type EventLoopSnapshot } from "./event-loop.js";
import {
  DEFAULT_SLOW_OP_THRESHOLD_MS,
  SLOW_OP_LOG_BASENAME,
  SlowOpRecorder,
  setActiveSlowOpRecorder,
} from "./slow-ops.js";
import { DIAGNOSTICS_DIRNAME } from "./vitals-file.js";
import { DEFAULT_STALL_THRESHOLDS, type StallThresholds } from "./stall-tracker.js";

/**
 * Daemon vitals: the event-loop wedge detector (OR-D3) and the slow-op recorder (OR-D4).
 * The shutdown receipt (OR-C11) is separate because it runs in the worker process, before and
 * after the daemon object exists. See docs/daemon-vitals.md.
 *
 * Read once at boot, not live-toggleable like the other monitors: the detector owns a thread and
 * a file, and a config reload that started or stopped either mid-run would need the same care as
 * a restart. Change it in config.json and relaunch.
 */

export interface DaemonVitalsConfig {
  /** Off unless this says otherwise. Covers the wedge detector and the slow-op recorder. */
  enabled?: boolean;
  /** Defaults to true. Detects, logs and records; sends no push. */
  dryRun?: boolean;
  tickMs?: number;
  slowStallMs?: number;
  wedgeMs?: number;
  suspendMs?: number;
  slowOpThresholdMs?: number;
  /**
   * The daemon-shutdown.json receipt. Defaults to ON, unlike everything above: it is one small
   * file written as the process exits, it observes nothing, and restart recovery needs its
   * absence to mean "it died" on every run, not only on runs where someone opted in.
   */
  shutdownReceipt?: boolean;
}

export interface ResolvedDaemonVitalsConfig {
  enabled: boolean;
  dryRun: boolean;
  thresholds: StallThresholds;
  slowOpThresholdMs: number;
  shutdownReceipt: boolean;
}

export function resolveDaemonVitalsConfig(
  config: DaemonVitalsConfig | undefined,
): ResolvedDaemonVitalsConfig {
  return {
    enabled: config?.enabled === true,
    dryRun: config?.dryRun !== false,
    thresholds: {
      tickMs: config?.tickMs ?? DEFAULT_STALL_THRESHOLDS.tickMs,
      slowStallMs: config?.slowStallMs ?? DEFAULT_STALL_THRESHOLDS.slowStallMs,
      wedgeMs: config?.wedgeMs ?? DEFAULT_STALL_THRESHOLDS.wedgeMs,
      suspendMs: config?.suspendMs ?? DEFAULT_STALL_THRESHOLDS.suspendMs,
    },
    slowOpThresholdMs: config?.slowOpThresholdMs ?? DEFAULT_SLOW_OP_THRESHOLD_MS,
    shutdownReceipt: config?.shutdownReceipt !== false,
  };
}

interface DaemonVitalsLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface StartDaemonVitalsOptions {
  config: DaemonVitalsConfig | undefined;
  paseoHome: string;
  serverId: string;
  pushNotificationSender: PushNotificationSender;
  logger: DaemonVitalsLogger;
}

export interface DaemonVitals {
  snapshot(): EventLoopSnapshot | null;
  getSlowOps(): SlowOpRecorder | null;
  stop(): Promise<void>;
}

export function startDaemonVitals(options: StartDaemonVitalsOptions): DaemonVitals {
  const resolved = resolveDaemonVitalsConfig(options.config);
  const { logger } = options;
  new MonitorModeLog(logger).report([
    { monitor: "daemonVitals", enabled: resolved.enabled, dryRun: resolved.dryRun },
  ]);
  if (!resolved.enabled) {
    return { snapshot: () => null, getSlowOps: () => null, stop: async () => undefined };
  }

  const slowOps = new SlowOpRecorder({
    filePath: path.join(options.paseoHome, DIAGNOSTICS_DIRNAME, SLOW_OP_LOG_BASENAME),
    thresholdMs: resolved.slowOpThresholdMs,
    onWriteError: (err) => logger.warn({ err }, "Slow-op recorder could not write a record"),
  });
  slowOps.observeGc();
  setActiveSlowOpRecorder(slowOps);

  const eventLoop = new EventLoopMonitor({
    paseoHome: options.paseoHome,
    thresholds: resolved.thresholds,
    dryRun: resolved.dryRun,
    logger,
    slowOps,
    onWedgeRecovered: (episode) => {
      const payload = buildDaemonWedgedNotificationPayload({
        serverId: options.serverId,
        wedgedForMs: episode.blockedMs,
        cause: episode.cause,
      });
      if (resolved.dryRun) {
        // A dry run that only speaks when it acts cannot be evaluated: say what would be sent.
        logger.info(
          { title: payload.title, body: payload.body },
          "Daemon vitals dry run: would push",
        );
        return;
      }
      // `alert`, not `urgent`: this only goes out once the loop has recovered, so nothing is about
      // to be lost when it arrives, but agents that stalled through it may need a look.
      // See docs/notification-policy.md.
      void options.pushNotificationSender
        .send(payload, { level: "alert" })
        .catch((err: unknown) => {
          logger.warn({ err }, "Failed to send daemon-wedged push notification");
        });
    },
  });
  eventLoop.start();

  return {
    snapshot: () => eventLoop.snapshot(),
    getSlowOps: () => slowOps,
    stop: async () => {
      await eventLoop.stop();
      setActiveSlowOpRecorder(null);
      await slowOps.close();
    },
  };
}
