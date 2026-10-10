import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
import { PromptQueue, type QueuedPrompt, type QueuedPromptDelivery } from "./prompt-queue.js";

const logger = createTestLogger();
const workdirs: string[] = [];

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prompt-queue-"));
  workdirs.push(dir);
  return join(dir, "agents");
}

function record(id: string, overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id,
    provider: "claude",
    cwd: "/tmp/prompt-queue-agent",
    createdAt: now,
    updatedAt: now,
    labels: {},
    lastStatus: "running",
    ...overrides,
  };
}

async function storageWithAgent(dir: string, agentId: string): Promise<AgentStorage> {
  const storage = new AgentStorage(dir, logger);
  await storage.initialize();
  await storage.upsert(record(agentId));
  return storage;
}

/** A delivery that holds every prompt until the test lets it through, like a busy agent. */
function heldDelivery() {
  const delivered: string[] = [];
  let release: (() => void) | null = null;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deliver = async (_agentId: string, prompt: QueuedPrompt): Promise<QueuedPromptDelivery> => {
    await gate;
    delivered.push(prompt.prompt as string);
    return "delivered";
  };
  return {
    delivered,
    deliver,
    release() {
      release?.();
      gate = Promise.resolve();
    },
  };
}

function textOf(prompts: readonly QueuedPrompt[] | undefined): unknown[] {
  return (prompts ?? []).map((prompt) => prompt.prompt);
}

test("a queued message is on the agent's record until it is delivered", async () => {
  const dir = agentsDir();
  const storage = await storageWithAgent(dir, "busy-agent");
  const delivery = heldDelivery();
  const queue = new PromptQueue({ store: storage, deliver: delivery.deliver, logger });

  await queue.enqueue("busy-agent", { prompt: "while you work", clientMessageId: "client-1" });

  expect(queue.hasWaiting("busy-agent")).toBe(true);
  expect((await storage.get("busy-agent"))?.queuedPrompts).toEqual([
    expect.objectContaining({ prompt: "while you work", clientMessageId: "client-1" }),
  ]);

  delivery.release();

  await vi.waitFor(() => expect(delivery.delivered).toEqual(["while you work"]));
  await vi.waitFor(async () =>
    expect((await storage.get("busy-agent"))?.queuedPrompts).toBeUndefined(),
  );
  expect(queue.hasWaiting("busy-agent")).toBe(false);
});

// A queued message used to live only in memory, so a daemon restart before the agent's turn ended
// lost it, and a finish report counts as delivered once queued.
test("messages queued before a restart are delivered after it, in the order they were sent", async () => {
  const dir = agentsDir();
  const before = await storageWithAgent(dir, "busy-agent");
  const neverDelivered = new PromptQueue({
    store: before,
    deliver: () => new Promise<QueuedPromptDelivery>(() => undefined),
    logger,
  });
  await neverDelivered.enqueue("busy-agent", { prompt: "first" });
  await neverDelivered.enqueue("busy-agent", { prompt: "second" });
  neverDelivered.stop();
  await before.flush();

  const after = new AgentStorage(dir, logger);
  await after.initialize();
  expect(textOf((await after.get("busy-agent"))?.queuedPrompts)).toEqual(["first", "second"]);
  const delivered: string[] = [];
  const restarted = new PromptQueue({
    store: after,
    deliver: async (_agentId, prompt) => {
      delivered.push(prompt.prompt as string);
      return "delivered";
    },
    logger,
  });

  await restarted.resume();

  await vi.waitFor(() => expect(delivered).toEqual(["first", "second"]));
  await vi.waitFor(async () =>
    expect((await after.get("busy-agent"))?.queuedPrompts).toBeUndefined(),
  );
});

test("a message sent after a restart waits behind the ones queued before it", async () => {
  const dir = agentsDir();
  const before = await storageWithAgent(dir, "busy-agent");
  const neverDelivered = new PromptQueue({
    store: before,
    deliver: () => new Promise<QueuedPromptDelivery>(() => undefined),
    logger,
  });
  await neverDelivered.enqueue("busy-agent", { prompt: "before the restart" });
  neverDelivered.stop();
  await before.flush();

  const after = new AgentStorage(dir, logger);
  await after.initialize();
  const delivery = heldDelivery();
  const restarted = new PromptQueue({ store: after, deliver: delivery.deliver, logger });
  await restarted.resume();
  await restarted.enqueue("busy-agent", { prompt: "after the restart" });
  delivery.release();

  await vi.waitFor(() =>
    expect(delivery.delivered).toEqual(["before the restart", "after the restart"]),
  );
});

test("an archived agent's queued messages are dropped at restart, not delivered", async () => {
  const dir = agentsDir();
  const storage = new AgentStorage(dir, logger);
  await storage.initialize();
  await storage.upsert(
    record("archived-agent", {
      archivedAt: new Date().toISOString(),
      queuedPrompts: [{ id: "queued-1", prompt: "too late", queuedAt: new Date().toISOString() }],
    }),
  );
  const deliver = vi.fn(async (): Promise<QueuedPromptDelivery> => "delivered");
  const queue = new PromptQueue({ store: storage, deliver, logger });

  await queue.resume();

  await vi.waitFor(async () =>
    expect((await storage.get("archived-agent"))?.queuedPrompts).toBeUndefined(),
  );
  expect(deliver).not.toHaveBeenCalled();
});

test("a message that could not be delivered stays queued and is tried again", async () => {
  const dir = agentsDir();
  const storage = await storageWithAgent(dir, "flaky-agent");
  let attempts = 0;
  const queue = new PromptQueue({
    store: storage,
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider went away");
      return "delivered";
    },
    logger,
    retryDelayMs: 5,
  });

  await queue.enqueue("flaky-agent", { prompt: "keep trying" });

  await vi.waitFor(() => expect(attempts).toBe(2));
  await vi.waitFor(async () =>
    expect((await storage.get("flaky-agent"))?.queuedPrompts).toBeUndefined(),
  );
});

test("a record write built from a stale copy keeps the queued messages", async () => {
  const dir = agentsDir();
  const storage = await storageWithAgent(dir, "busy-agent");
  const stale = await storage.get("busy-agent");
  const queue = new PromptQueue({
    store: storage,
    deliver: () => new Promise<QueuedPromptDelivery>(() => undefined),
    logger,
  });
  await queue.enqueue("busy-agent", { prompt: "do not lose me" });

  await storage.upsert({ ...stale!, title: "renamed" });

  const stored = await storage.get("busy-agent");
  expect(stored?.title).toBe("renamed");
  expect(textOf(stored?.queuedPrompts)).toEqual(["do not lose me"]);
  queue.stop();
});
