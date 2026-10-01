import type { Logger } from "pino";
import {
  HUMAN_WORK_ITEM_OWNER,
  type WorkItem,
} from "@getpaseo/protocol/coordination/queue-schemas";
import type { PushNotificationSender, PushPayload } from "../../push/index.js";
import type { WorkItemChange, WorkQueueService } from "../queue/service.js";

// OR-A5 / OR-H1: an item that lands on `human`, by create or handoff, pushes once so the Inbox
// is never a silent queue. Rides the same item-changed listener as delivery
// (../queue/delivery.ts), which fires only when a call changed something, so an idempotent
// repeat create never pushes twice. See docs/work-queue.md#inbox.

export interface WorkQueueInboxPushOptions {
  queue: Pick<WorkQueueService, "onItemChanged">;
  push: PushNotificationSender;
  serverId: string;
  logger: Logger;
}

export class WorkQueueInboxPush {
  private unsubscribe: (() => void) | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: WorkQueueInboxPushOptions) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.queue.onItemChanged((change) => this.onChange(change));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves when every push started so far has settled. Test seam. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight);
    }
  }

  private onChange(change: WorkItemChange): void {
    if (change.op !== "create" && change.op !== "handoff") return;
    // A handoff writes [successor, source]; only the successor is new work for someone.
    const target = change.items[0];
    if (target && needsInboxPush(target)) this.track(this.send(target));
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private async send(item: WorkItem): Promise<void> {
    try {
      await this.options.push.send(buildInboxItemPushPayload(item, this.options.serverId), {
        level: "alert",
      });
    } catch (error) {
      this.options.logger.warn({ err: error, itemId: item.id }, "Inbox: push notification failed");
    }
  }
}

function needsInboxPush(item: WorkItem): boolean {
  return item.owner === HUMAN_WORK_ITEM_OWNER && item.state === "pending";
}

export function buildInboxItemPushPayload(item: WorkItem, serverId: string): PushPayload {
  return {
    title: "Needs you",
    body: item.title,
    data: {
      reason: "coordination_inbox_item",
      serverId,
      itemId: item.id,
    },
  };
}
