import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openCoordination, type Coordination } from "../coordination.js";
import { WorkQueueDelivery, formatWorkItemPrompt } from "./delivery.js";

let paseoHome: string;
let coordination: Coordination;
let sent: { agentId: string; prompt: string }[];
let unreachable: Set<string>;
let delivery: WorkQueueDelivery;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-queue-delivery-"));
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
  });
  sent = [];
  unreachable = new Set();
  delivery = new WorkQueueDelivery({
    queue: coordination.queue,
    deliver: async (agentId, prompt) => {
      if (unreachable.has(agentId)) throw new Error(`agent ${agentId} is archived`);
      sent.push({ agentId, prompt });
    },
    logger: createTestLogger(),
  });
  delivery.start();
});

afterEach(async () => {
  delivery.stop();
  await fs.rm(paseoHome, { recursive: true, force: true });
});

async function deliveryOf(id: string) {
  return (await coordination.queue.get(id))?.item.delivery;
}

describe("work item delivery", () => {
  it("prompts the owner agent once and records delivered", async () => {
    await coordination.queue.create({ id: "wi-a", title: "Review", owner: "agent-a" });
    await delivery.idle();
    expect(sent).toEqual([{ agentId: "agent-a", prompt: expect.stringContaining("id: wi-a") }]);
    expect(await deliveryOf("wi-a")).toMatchObject({ state: "delivered" });
  });

  it("records failed with the reason when the agent cannot be reached", async () => {
    unreachable.add("agent-gone");
    await coordination.queue.create({ id: "wi-b", title: "Review", owner: "agent-gone" });
    await delivery.idle();
    expect(sent).toEqual([]);
    expect(await deliveryOf("wi-b")).toMatchObject({
      state: "failed",
      reason: "agent agent-gone is archived",
    });
  });

  it("delivers an idempotent repeat create only once", async () => {
    const input = { id: "wi-c", title: "Review", owner: "agent-a" };
    await coordination.queue.create(input);
    await delivery.idle();
    await coordination.queue.create(input);
    await delivery.idle();
    expect(sent).toHaveLength(1);
  });

  it("sends nothing for a human owner", async () => {
    await coordination.queue.create({ id: "wi-d", title: "Approve", owner: "human" });
    await delivery.idle();
    expect(sent).toEqual([]);
    expect(await deliveryOf("wi-d")).toMatchObject({ state: "not_attempted" });
  });

  it("delivers the successor of a handoff to its new owner", async () => {
    await coordination.queue.create({ id: "wi-e", title: "Review", owner: "human" });
    const { successor } = await coordination.queue.handoff("wi-e", { to: "agent-b" });
    await delivery.idle();
    expect(sent.map((entry) => entry.agentId)).toEqual(["agent-b"]);
    expect(sent[0].prompt).toContain("handed off from: wi-e");
    expect(await deliveryOf(successor.id)).toMatchObject({ state: "delivered" });
  });

  it("delivers pending items a previous daemon never sent, and nothing else", async () => {
    delivery.stop();
    await coordination.queue.create({ id: "wi-f", title: "Never sent", owner: "agent-a" });
    await coordination.queue.create({ id: "wi-g", title: "For a person", owner: "human" });
    delivery.start();
    expect(await delivery.deliverUndelivered()).toBe(1);
    await delivery.idle();
    expect(await delivery.deliverUndelivered()).toBe(0);
    expect(sent.map((entry) => entry.agentId)).toEqual(["agent-a"]);
  });

  it("teaches the closure marker in the prompt", () => {
    const prompt = formatWorkItemPrompt({
      id: "wi-x",
      title: "Ship it",
      owner: "agent-a",
      state: "pending",
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(prompt).toMatch(/^<paseo-system>\n/);
    expect(prompt).toContain("`queue: wi-x done no-follow-on`");
  });
});
