import type { Logger } from "pino";
import {
  HUMAN_WORK_ITEM_OWNER,
  type WorkItem,
} from "@getpaseo/protocol/coordination/queue-schemas";
import type { WorkItemChange, WorkQueueService } from "./service.js";

// OR-A3 / OR-D9: an item created for, or handed off to, an agent reaches it as one prompt, and
// the item records whether it got there. An item for `human` sends nothing; the Inbox shows it.
// Delivery rides the service's item-changed listener, which fires only when a call changed
// something, so an idempotent repeat create never delivers twice.

/** Sends one daemon-originated prompt to an agent. Rejects when the agent cannot receive it. */
export type DeliverPromptToAgent = (agentId: string, prompt: string) => Promise<void>;

export interface WorkQueueDeliveryOptions {
  queue: WorkQueueService;
  deliver: DeliverPromptToAgent;
  logger: Logger;
}

export class WorkQueueDelivery {
  private readonly inFlight = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: WorkQueueDeliveryOptions) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.queue.onItemChanged((change) => this.onChange(change));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Delivers pending agent items a previous daemon created but never reached (it died between
   * the create and the delivery). Only `not_attempted`: an item that failed delivery says so and
   * waits for someone to act on it.
   */
  async deliverUndelivered(): Promise<number> {
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await this.options.queue.list({ states: ["pending"], cursor, limit: 200 });
      for (const item of page.items) {
        if (needsDelivery(item) && item.delivery?.state === "not_attempted") {
          this.track(this.deliver(item));
          count += 1;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return count;
  }

  /** Resolves when every delivery started so far has been recorded. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private onChange(change: WorkItemChange): void {
    // A handoff writes [successor, source]; only the successor is new work for someone.
    const target = change.op === "create" || change.op === "handoff" ? change.items[0] : null;
    if (target && needsDelivery(target)) this.track(this.deliver(target));
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private async deliver(item: WorkItem): Promise<void> {
    const { queue, deliver, logger } = this.options;
    let outcome: { state: "delivered" } | { state: "failed"; reason: string };
    try {
      await deliver(item.owner, formatWorkItemPrompt(item));
      outcome = { state: "delivered" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { state: "failed", reason };
      logger.warn({ itemId: item.id, owner: item.owner, reason }, "Work queue: delivery failed");
    }
    try {
      await queue.recordDelivery(item.id, outcome);
    } catch (error) {
      logger.error({ err: error, itemId: item.id }, "Work queue: failed to record delivery");
    }
  }
}

function needsDelivery(item: WorkItem): boolean {
  return item.owner !== HUMAN_WORK_ITEM_OWNER && item.state === "pending";
}

/** The prompt an owner agent receives. It names the item and teaches the closure in two lines. */
export function formatWorkItemPrompt(item: WorkItem): string {
  const lines = [
    `Work item assigned to you: ${item.title}`,
    `id: ${item.id}`,
    ...(item.createdBy ? [`from: ${item.createdBy}`] : []),
    ...(item.handedOffFrom ? [`handed off from: ${item.handedOffFrom}`] : []),
    ...(item.tags?.length ? [`tags: ${item.tags.join(", ")}`] : []),
    ...(item.body ? ["", item.body] : []),
    "",
    `Claim it with queue_claim before you start. Close it with queue_update (done needs a closure: no-follow-on, handed_off_to=<owner>, blocked_on=<target>, escalation=<target>), ` +
      `or end your final message with the line \`queue: ${item.id} done no-follow-on\`.`,
  ];
  return `<paseo-system>\n${lines.join("\n")}\n</paseo-system>`;
}
