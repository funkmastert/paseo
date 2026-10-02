import type { Logger } from "pino";
import { HUMAN_WORK_ITEM_OWNER } from "@getpaseo/protocol/coordination/queue-schemas";
import type { WorkQueueService } from "./service.js";

// OR-F3: archiving an agent that owns open queue items no longer blocks on `--force`. Each open
// item is handed off to the archived agent's parent, or to `human` for a root, through the
// queue's own handoff — journaled, idempotent, and delivered the normal way. Coordination
// disabled, or any failure here, never blocks or slows the archive: it has already happened by
// the time this runs. See docs/work-queue.md and docs/agent-lifecycle.md#archive.

export interface HandBackOpenItemsInput {
  /** Null: coordination is off, or still opening. Nothing to hand back. */
  queue: WorkQueueService | null;
  /** The agent that was just archived. */
  agentId: string;
  /** Its `paseo.parent-agent-id` label; null for a root, which hands off to `human`. */
  parentAgentId: string | null;
  logger: Logger;
}

const HANDBACK_NOTE = "owner archived";

/** Hands every open item the archived agent owns back to its parent, or to `human` for a root. */
export async function handBackOpenItemsForArchivedAgent(
  input: HandBackOpenItemsInput,
): Promise<void> {
  const { queue, agentId, parentAgentId, logger } = input;
  if (!queue) return;
  const to = parentAgentId ?? HUMAN_WORK_ITEM_OWNER;
  try {
    let cursor: string | undefined;
    do {
      const page = await queue.list({ owner: agentId, openOnly: true, cursor });
      for (const item of page.items) {
        try {
          await queue.handoff(item.id, { to, actor: "system", note: HANDBACK_NOTE });
        } catch (error) {
          logger.error(
            { err: error, itemId: item.id, agentId, to },
            "Work queue: failed to hand back an open item from an archived agent",
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    logger.error(
      { err: error, agentId },
      "Work queue: failed to list open items for an archived agent",
    );
  }
}
