import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { AgentPromptInput } from "./agent-sdk-types.js";

/** A message waiting for a busy agent. Persisted on that agent's record as `queuedPrompts`. */
export interface QueuedPrompt {
  id: string;
  prompt: AgentPromptInput;
  clientMessageId?: string;
  clearPendingPermissions?: boolean;
  queuedAt: string;
}

export type QueuedPromptInput = Omit<QueuedPrompt, "id" | "queuedAt">;

/**
 * `delivered`: steered into a turn or started one. `dropped`: the agent is archived or gone, so
 * nothing will ever take it.
 */
export type QueuedPromptDelivery = "delivered" | "dropped";

export interface QueuedPromptStore {
  list(): Promise<
    ReadonlyArray<{ id: string; archivedAt?: string | null; queuedPrompts?: QueuedPrompt[] }>
  >;
  appendQueuedPrompt(agentId: string, prompt: QueuedPrompt): Promise<boolean>;
  removeQueuedPrompt(agentId: string, promptId: string): Promise<void>;
}

export interface PromptQueueOptions {
  /** Where the queue survives a restart. Null keeps it in memory, for a daemon with no records. */
  store: QueuedPromptStore | null;
  /** Deliver one message, waiting for the agent as long as it takes. Throws to be retried. */
  deliver: (agentId: string, prompt: QueuedPrompt) => Promise<QueuedPromptDelivery>;
  logger: Logger;
  retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 30_000;

/**
 * The messages that could not join a busy agent's turn, in the order they were sent, one queue per
 * agent (docs/providers.md). Each is written to the agent's record before `enqueue` resolves and
 * removed once delivered, so a daemon restart delivers what the last one could not.
 *
 * A message is never dropped for failing to deliver: it is retried until it lands, the agent is
 * archived, or the daemon stops, which leaves it on the record for the next one.
 */
export class PromptQueue {
  private readonly options: PromptQueueOptions;
  private readonly waiting = new Map<string, QueuedPrompt[]>();
  private readonly draining = new Set<string>();
  private stopped = false;

  constructor(options: PromptQueueOptions) {
    this.options = options;
  }

  /** Whether messages are waiting for this agent. A new one has to go behind them. */
  hasWaiting(agentId: string): boolean {
    return (this.waiting.get(agentId)?.length ?? 0) > 0;
  }

  /** Queue a message behind the agent's run. It is on the agent's record when this resolves. */
  async enqueue(agentId: string, input: QueuedPromptInput): Promise<void> {
    const prompt: QueuedPrompt = { ...input, id: randomUUID(), queuedAt: new Date().toISOString() };
    this.push(agentId, [prompt]);
    const written = (await this.options.store?.appendQueuedPrompt(agentId, prompt)) ?? true;
    if (!written) {
      this.options.logger.warn(
        { agentId, promptId: prompt.id },
        "A queued message has no agent record to live on; it will not survive a restart",
      );
    }
    this.drain(agentId);
  }

  /**
   * Deliver what a previous daemon left queued. Run once at start, when agents can be loaded. Each
   * agent's messages go ahead of anything queued for it since this daemon started.
   */
  async resume(): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    for (const record of await store.list()) {
      const prompts = record.queuedPrompts ?? [];
      if (prompts.length === 0) continue;
      if (record.archivedAt) {
        this.options.logger.warn(
          { agentId: record.id, dropped: prompts.length },
          "Dropping messages queued for an agent that was archived before they were delivered",
        );
        for (const prompt of prompts) await store.removeQueuedPrompt(record.id, prompt.id);
        continue;
      }
      this.options.logger.info(
        { agentId: record.id, queued: prompts.length },
        "Delivering messages queued before the restart",
      );
      this.waiting.set(record.id, [...prompts, ...(this.waiting.get(record.id) ?? [])]);
      this.drain(record.id);
    }
  }

  /** The daemon is going down. What is still queued stays on the records for the next one. */
  stop(): void {
    this.stopped = true;
  }

  private push(agentId: string, prompts: QueuedPrompt[]): void {
    this.waiting.set(agentId, [...(this.waiting.get(agentId) ?? []), ...prompts]);
  }

  private drain(agentId: string): void {
    if (this.draining.has(agentId) || this.stopped) return;
    this.draining.add(agentId);
    void this.drainAgent(agentId).catch((error: unknown) => {
      this.draining.delete(agentId);
      this.options.logger.error({ err: error, agentId }, "Queued message delivery stopped");
    });
  }

  private async drainAgent(agentId: string): Promise<void> {
    for (;;) {
      const next = this.waiting.get(agentId)?.[0];
      // Checked and released in one tick, so an enqueue that follows starts a fresh drain.
      if (!next || this.stopped) {
        if (!next) this.waiting.delete(agentId);
        this.draining.delete(agentId);
        return;
      }
      let outcome: QueuedPromptDelivery;
      try {
        outcome = await this.options.deliver(agentId, next);
      } catch (error) {
        if (this.stopped) continue;
        this.options.logger.warn(
          { err: error, agentId, promptId: next.id },
          "A queued message could not be delivered yet; trying again",
        );
        await sleep(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      if (outcome === "dropped") {
        this.options.logger.warn(
          { agentId, promptId: next.id },
          "Dropping a queued message: its agent is archived or gone",
        );
      }
      const remaining = this.waiting.get(agentId) ?? [];
      this.waiting.set(
        agentId,
        remaining.filter((prompt) => prompt !== next),
      );
      await this.options.store?.removeQueuedPrompt(agentId, next.id).catch((error: unknown) => {
        this.options.logger.error(
          { err: error, agentId, promptId: next.id },
          "A delivered message stayed on the agent's record; a restart would send it again",
        );
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
