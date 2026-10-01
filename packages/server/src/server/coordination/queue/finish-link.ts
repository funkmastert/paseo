import type { Logger } from "pino";
import type { WorkItem } from "@getpaseo/protocol/coordination/queue-schemas";
import { parseClosureMarkers } from "./closure-marker.js";
import type { WorkQueueService } from "./service.js";

// When an agent that owns open items ends a turn, its final message may close them with closure
// markers (closure-marker.ts). No marker leaves the item where it is, for the stuck sweep to find.
// This is separate from finish reports (docs/finish-reports.md), which stay the wake path.

export interface AgentTurnSource {
  /** Calls back with the agent id each time one of its turns ends (completed, failed or canceled). */
  onTurnEnded(listener: (agentId: string) => void): () => void;
  getFinalMessage(agentId: string): Promise<string | null>;
}

export interface WorkQueueFinishLinkOptions {
  queue: WorkQueueService;
  turns: AgentTurnSource;
  logger: Logger;
}

export interface FinishLinkResult {
  applied: string[];
  rejected: { itemId: string; reason: string }[];
  malformed: number;
}

const NOTE = "closure marker in the owner's final message";

export class WorkQueueFinishLink {
  private readonly inFlight = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: WorkQueueFinishLinkOptions) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.turns.onTurnEnded((agentId) => {
      const run = this.handleTurnEnded(agentId).catch((error: unknown) => {
        this.options.logger.error({ err: error, agentId }, "Work queue: finish link failed");
      });
      this.inFlight.add(run);
      void run.finally(() => this.inFlight.delete(run));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async handleTurnEnded(agentId: string): Promise<FinishLinkResult> {
    const result: FinishLinkResult = { applied: [], rejected: [], malformed: 0 };
    const owned = await this.openItemsOwnedBy(agentId);
    // Most turns end with nothing owned; skip reading the message.
    if (owned.size === 0) return result;
    const text = await this.options.turns.getFinalMessage(agentId);
    if (!text) return result;
    const { markers, malformed } = parseClosureMarkers(text);
    result.malformed = malformed.length;
    for (const entry of malformed) {
      this.options.logger.warn(
        { agentId, line: entry.line, problem: entry.problem },
        "Work queue: malformed closure marker ignored",
      );
    }
    for (const marker of markers) {
      if (!owned.has(marker.itemId)) {
        const reason = `not an open item owned by ${agentId}`;
        result.rejected.push({ itemId: marker.itemId, reason });
        this.options.logger.warn(
          { agentId, itemId: marker.itemId, line: marker.line },
          `Work queue: closure marker ignored: ${reason}`,
        );
        continue;
      }
      try {
        await this.options.queue.transition(marker.itemId, {
          to: marker.to,
          ...(marker.closure ? { closure: marker.closure } : {}),
          actor: agentId,
          note: NOTE,
        });
        result.applied.push(marker.itemId);
        this.options.logger.info(
          { agentId, itemId: marker.itemId, to: marker.to, closure: marker.closure },
          "Work queue: closed an item from a closure marker",
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.rejected.push({ itemId: marker.itemId, reason });
        this.options.logger.warn(
          { agentId, itemId: marker.itemId, line: marker.line, reason },
          "Work queue: closure marker rejected",
        );
      }
    }
    return result;
  }

  private async openItemsOwnedBy(agentId: string): Promise<Map<string, WorkItem>> {
    const owned = new Map<string, WorkItem>();
    let cursor: string | undefined;
    do {
      const page = await this.options.queue.list({
        owner: agentId,
        openOnly: true,
        cursor,
        limit: 200,
      });
      for (const item of page.items) owned.set(item.id, item);
      cursor = page.nextCursor;
    } while (cursor);
    return owned;
  }
}
