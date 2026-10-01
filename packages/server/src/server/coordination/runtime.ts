import type { Logger } from "pino";
import { resolveCoordinationConfig, type CoordinationConfigInput } from "./config.js";
import {
  openCoordination,
  type Coordination,
  type OpenCoordinationOptions,
} from "./coordination.js";
import { WorkQueueDelivery, type DeliverPromptToAgent } from "./queue/delivery.js";
import { WorkQueueFinishLink, type AgentTurnSource } from "./queue/finish-link.js";

// The daemon's handle on coordination. Built before the WebSocket server and the agent tools so
// both can hold it, opened once by `start()` after the monitors start. A store that fails to open
// (a corrupt journal, an unreadable directory) is logged and leaves coordination unavailable; it
// never fails or delays daemon boot. See docs/work-queue.md#surfaces.

export type CoordinationStatus = "disabled" | "pending" | "open" | "failed";

export class CoordinationUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CoordinationUnavailableError";
  }
}

const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CoordinationRuntimeOptions {
  paseoHome: string;
  config: CoordinationConfigInput;
  logger: Logger;
  deliver: DeliverPromptToAgent;
  turns: AgentTurnSource;
  retentionIntervalMs?: number;
  /** Test seam passed to the queue store; see WorkQueueStoreOptions.onCommitStep. */
  onCommitStep?: OpenCoordinationOptions["onCommitStep"];
}

export class CoordinationRuntime {
  readonly enabled: boolean;
  private state: CoordinationStatus;
  private coordination: Coordination | null = null;
  private delivery: WorkQueueDelivery | null = null;
  private finishLink: WorkQueueFinishLink | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly logger: Logger;
  private resolveStarted!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  constructor(private readonly options: CoordinationRuntimeOptions) {
    this.enabled = resolveCoordinationConfig(options.config).enabled;
    this.state = this.enabled ? "pending" : "disabled";
    this.logger = options.logger.child({ module: "coordination" });
  }

  get status(): CoordinationStatus {
    return this.state;
  }

  /** What `server_info.features.coordinationQueue` reports. True while opening. */
  get advertised(): boolean {
    return this.state === "pending" || this.state === "open";
  }

  /** Never throws. Safe to call once; later calls are no-ops. */
  async start(): Promise<void> {
    if (this.state !== "pending" || this.coordination) {
      this.resolveStarted();
      return;
    }
    try {
      const coordination = await openCoordination({
        paseoHome: this.options.paseoHome,
        config: this.options.config,
        logger: this.options.logger,
        ...(this.options.onCommitStep ? { onCommitStep: this.options.onCommitStep } : {}),
      });
      this.coordination = coordination;
      this.delivery = new WorkQueueDelivery({
        queue: coordination.queue,
        deliver: this.options.deliver,
        logger: this.logger,
      });
      this.delivery.start();
      this.finishLink = new WorkQueueFinishLink({
        queue: coordination.queue,
        turns: this.options.turns,
        logger: this.logger,
      });
      this.finishLink.start();
      this.state = "open";
      this.logger.info("Coordination open: work queue and fleet stream");
    } catch (error) {
      this.state = "failed";
      this.logger.error(
        { err: error },
        "COORDINATION DISABLED: the work queue store failed to open. The daemon runs without " +
          "the queue; fix or move $PASEO_HOME/coordination and restart.",
      );
      this.resolveStarted();
      return;
    }
    this.resolveStarted();
    await this.runRetention();
    const delivered = await this.delivery.deliverUndelivered().catch((error: unknown) => {
      this.logger.error({ err: error }, "Work queue: redelivery sweep failed");
      return 0;
    });
    if (delivered > 0) {
      this.logger.info({ delivered }, "Work queue: delivering items a previous daemon never sent");
    }
    this.retentionTimer = setInterval(
      () => void this.runRetention(),
      this.options.retentionIntervalMs ?? DEFAULT_RETENTION_INTERVAL_MS,
    );
    this.retentionTimer.unref?.();
  }

  stop(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    this.delivery?.stop();
    this.finishLink?.stop();
  }

  /**
   * The open coordination. Waits for `start()` when it has not finished; throws
   * CoordinationUnavailableError when coordination is off or failed to open.
   */
  async require(): Promise<Coordination> {
    if (this.state === "disabled") {
      throw new CoordinationUnavailableError(
        "Coordination is disabled on this daemon. Set agents.coordination.enabled to true in " +
          "config.json and restart the daemon.",
      );
    }
    await this.started;
    if (!this.coordination) {
      throw new CoordinationUnavailableError(
        "Coordination failed to open on this daemon; see the daemon log for why.",
      );
    }
    return this.coordination;
  }

  /** Test seam: resolves once every delivery and finish link started so far has settled. */
  async idle(): Promise<void> {
    await this.delivery?.idle();
    await this.finishLink?.idle();
    await this.delivery?.idle();
  }

  private async runRetention(): Promise<void> {
    try {
      await this.coordination?.queue.runRetention();
    } catch (error) {
      this.logger.error({ err: error }, "Work queue: retention run failed");
    }
  }
}
