import { randomUUID } from "node:crypto";
import {
  HUMAN_WORK_ITEM_OWNER,
  type WorkItem,
} from "@getpaseo/protocol/coordination/queue-schemas";
import type { InboxActVerb } from "@getpaseo/protocol/coordination/rpc-schemas";
import type { JsonlAppender } from "../../jsonl-appender.js";
import { QueueNotFoundError } from "../queue/store.js";
import { isOpenState, QueueValidationError } from "../queue/state-machine.js";
import type { WorkQueueService } from "../queue/service.js";
import type { StreamStore } from "../stream/store.js";

export type { InboxActVerb };

export interface InboxActInput {
  id: string;
  verb: InboxActVerb;
  note?: string;
  // `route` only: the agent id to hand the item off to.
  to?: string;
}

export interface InboxActResult {
  item: WorkItem;
  // `route` only: the item the handoff created.
  successor?: WorkItem;
  changed: boolean;
}

export interface InboxActOptions {
  queue: Pick<WorkQueueService, "get" | "transition" | "handoff" | "update">;
  stream: Pick<StreamStore, "append">;
  audit: Pick<JsonlAppender, "append">;
  now: () => Date;
}

/**
 * Applies one Mission Control verb (OR-A5) to a work item, always as `human`: the Inbox is the
 * only caller. Five of the six verbs map onto `transition` or `handoff`, so they inherit the
 * closure contract and the state machine's teaching errors for free. `annotate` does not
 * transition, so a closed item is refused here explicitly, up front, the same way every other
 * verb already refuses one. Every call appends one line to the inbox audit log, win or lose
 * (a throw still writes a `refused` line) so the log answers "who tried what" even when nothing
 * changed. See docs/work-queue.md#inbox.
 */
export async function applyInboxAct(
  options: InboxActOptions,
  input: InboxActInput,
): Promise<InboxActResult> {
  const actor = HUMAN_WORK_ITEM_OWNER;
  try {
    const found = await options.queue.get(input.id);
    if (!found) throw new QueueNotFoundError(input.id);
    if (!isOpenState(found.item.state)) {
      throw new QueueValidationError(
        `Work item "${input.id}" is already ${found.item.state} and cannot take another action. ` +
          `Create a new item for follow-on work.`,
      );
    }
    const result = await runVerb(options, input, actor);
    writeAudit(options, input, actor, { outcome: "applied", state: result.item.state });
    return result;
  } catch (error) {
    writeAudit(options, input, actor, {
      outcome: "refused",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runVerb(
  options: InboxActOptions,
  input: InboxActInput,
  actor: string,
): Promise<InboxActResult> {
  switch (input.verb) {
    case "approve": {
      const result = await options.queue.transition(input.id, {
        to: "done",
        closure: { reason: "no-follow-on" },
        actor,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return { item: result.item, changed: result.changed };
    }
    case "deny": {
      const result = await options.queue.transition(input.id, {
        to: "denied",
        actor,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return { item: result.item, changed: result.changed };
    }
    case "hold": {
      const result = await options.queue.transition(input.id, {
        to: "blocked",
        closure: { reason: "blocked_on", target: HUMAN_WORK_ITEM_OWNER },
        actor,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return { item: result.item, changed: result.changed };
    }
    case "drop": {
      const result = await options.queue.transition(input.id, {
        to: "canceled",
        actor,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return { item: result.item, changed: result.changed };
    }
    case "route": {
      if (!input.to?.trim()) {
        throw new QueueValidationError(
          'The "route" verb needs `to`: the agent id to hand this item off to.',
        );
      }
      const result = await options.queue.handoff(input.id, {
        to: input.to,
        actor,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return { item: result.source, successor: result.successor, changed: result.changed };
    }
    case "annotate": {
      if (!input.note?.trim()) {
        throw new QueueValidationError('The "annotate" verb needs a note.');
      }
      const result = await options.queue.update(input.id, {});
      await options.stream.append(
        {
          id: `inbox-annotate-${randomUUID()}`,
          type: "coordination.inbox.annotate",
          source: actor,
          subject: input.id,
          summary: input.note,
          urgency: "low",
          data: { itemId: input.id, note: input.note },
        },
        options.now().toISOString(),
      );
      return { item: result.item, changed: result.changed };
    }
  }
}

function writeAudit(
  options: InboxActOptions,
  input: InboxActInput,
  actor: string,
  outcome:
    | { outcome: "applied"; state: WorkItem["state"] }
    | { outcome: "refused"; reason: string },
): void {
  options.audit.append({
    v: 1,
    at: options.now().toISOString(),
    actor,
    itemId: input.id,
    verb: input.verb,
    note: input.note ?? null,
    to: input.to ?? null,
    ...outcome,
  });
}
