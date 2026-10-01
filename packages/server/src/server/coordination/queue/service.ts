import type { Logger } from "pino";
import type {
  WorkItem,
  WorkItemDeliveryState,
  WorkItemListFilter,
  WorkItemPage,
  WorkItemTransition,
  WorkItemWithTransitions,
} from "@getpaseo/protocol/coordination/queue-schemas";
import type { StreamUrgency } from "@getpaseo/protocol/coordination/stream-schemas";
import type { CoordinationConfig } from "../config.js";
import type { StreamStore } from "../stream/store.js";
import type {
  CompactResult,
  CreateWorkItemInput,
  HandoffInput,
  HandoffResult,
  TransitionInput,
  UpdateWorkItemInput,
  WorkItemMutation,
  WorkQueueStore,
} from "./store.js";

// The queue's API for the surfaces W2.1b adds (agent tools, session RPCs, CLI, delivery). It
// owns the clock and id minting, logs every transition to the stream, and tells listeners what
// changed. See docs/work-queue.md.

export type WorkQueueOp = "create" | "claim" | "transition" | "handoff" | "update";

export interface WorkItemChange {
  op: WorkQueueOp;
  // Every item the call wrote; a handoff writes the source and the successor.
  items: WorkItem[];
  transitions: WorkItemTransition[];
}

export type WorkItemChangeListener = (change: WorkItemChange) => void;

export interface WorkQueueServiceOptions {
  store: WorkQueueStore;
  stream: StreamStore;
  retention: CoordinationConfig["retention"];
  logger: Logger;
  now: () => Date;
  newId: () => string;
}

export type CreateWorkItemRequest = Omit<CreateWorkItemInput, "id"> & { id?: string };

export class WorkQueueService {
  private readonly listeners = new Set<WorkItemChangeListener>();

  constructor(private readonly options: WorkQueueServiceOptions) {}

  onItemChanged(listener: WorkItemChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Pass a caller-minted `id` to make a retry safe: a repeat with the same content returns the
  // existing item.
  async create(input: CreateWorkItemRequest): Promise<WorkItemMutation> {
    const result = await this.options.store.create(
      { ...input, id: input.id ?? this.options.newId() },
      this.at(),
    );
    await this.publish("create", result.changed, [result.item], result.transitions);
    return result;
  }

  async claim(id: string, input: { actor: string; note?: string }): Promise<WorkItemMutation> {
    const result = await this.options.store.claim(id, input, this.at());
    await this.publish("claim", result.changed, [result.item], result.transitions);
    return result;
  }

  async transition(id: string, input: TransitionInput): Promise<WorkItemMutation> {
    const result = await this.options.store.transition(id, input, this.at());
    await this.publish("transition", result.changed, [result.item], result.transitions);
    return result;
  }

  async handoff(id: string, input: HandoffInput): Promise<HandoffResult> {
    const result = await this.options.store.handoff(id, input, this.at());
    await this.publish(
      "handoff",
      result.changed,
      [result.successor, result.source],
      result.transitions,
    );
    return result;
  }

  async update(id: string, input: UpdateWorkItemInput): Promise<WorkItemMutation> {
    const result = await this.options.store.update(id, input, this.at());
    await this.publish("update", result.changed, [result.item], result.transitions);
    return result;
  }

  recordDelivery(
    id: string,
    delivery: Omit<WorkItemDeliveryState, "at"> & { at?: string },
  ): Promise<WorkItemMutation> {
    return this.update(id, { delivery: { ...delivery, at: delivery.at ?? this.at() } });
  }

  get(id: string): Promise<WorkItemWithTransitions | null> {
    return this.options.store.get(id);
  }

  list(filter: WorkItemListFilter): Promise<WorkItemPage> {
    return this.options.store.list(filter);
  }

  // OR-J1. The daemon wiring calls this at startup and on an interval.
  async runRetention(): Promise<CompactResult> {
    const now = this.at();
    const result = await this.options.store.compact({
      now,
      closedItemMaxAgeMs: this.options.retention.closedItemMaxAgeMs,
    });
    await this.options.stream.compact(now);
    if (result.archivedItemIds.length > 0) {
      this.options.logger.info(
        { archived: result.archivedItemIds.length },
        "Work queue: archived closed items past retention",
      );
    }
    return result;
  }

  private at(): string {
    return this.options.now().toISOString();
  }

  // The store has committed by now. The stream and listeners are best effort: a failure there
  // is logged and never undoes or fails the queue write.
  private async publish(
    op: WorkQueueOp,
    changed: boolean,
    items: WorkItem[],
    transitions: WorkItemTransition[],
  ): Promise<void> {
    if (!changed) return;
    for (const row of transitions) {
      const item = items.find((candidate) => candidate.id === row.itemId);
      try {
        await this.options.stream.append(
          {
            id: `queue-transition-${row.seq}`,
            type: "queue.transition",
            source: row.actor ?? "queue",
            subject: row.itemId,
            summary: `${item?.title ?? row.itemId}: ${row.from ?? "new"} → ${row.to}`,
            urgency: urgencyFor(row),
            tags: [row.to],
            data: stripUndefined({
              itemId: row.itemId,
              from: row.from,
              to: row.to,
              owner: row.owner,
              closure: row.closure,
              successorId: row.successorId,
            }),
          },
          row.at,
        );
      } catch (error) {
        this.options.logger.error(
          { err: error, itemId: row.itemId, seq: row.seq },
          "Work queue: failed to log a transition to the stream",
        );
      }
    }
    const change: WorkItemChange = { op, items, transitions };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.options.logger.error({ err: error, op }, "Work queue: item-changed listener threw");
      }
    }
  }
}

function urgencyFor(row: WorkItemTransition): StreamUrgency {
  if (row.to === "blocked" || row.to === "failed") return "high";
  if (row.closure?.reason === "escalation") return "high";
  return "normal";
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
