import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openCoordination, type Coordination } from "../coordination.js";
import type { WorkItemChange } from "./service.js";

const START = Date.parse("2026-09-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let paseoHome: string;
let clockMs: number;
let idCounter: number;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-queue-service-"));
  clockMs = START;
  idCounter = 0;
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

async function open(): Promise<Coordination> {
  return openCoordination({
    paseoHome,
    config: { enabled: true, retention: { closedItemDays: 7 } },
    logger: createTestLogger(),
    now: () => new Date(clockMs),
    newId: () => `id-${++idCounter}`,
  });
}

describe("work queue service", () => {
  it("stores under PASEO_HOME/coordination and mints ids with the injected factory", async () => {
    const { queue } = await open();
    const created = await queue.create({ title: "Review the plan", owner: "agent-a" });
    expect(created.item).toMatchObject({ id: "id-1", createdAt: new Date(START).toISOString() });
    await expect(
      fs.stat(path.join(paseoHome, "coordination", "queue", "items", "id-1.json")),
    ).resolves.toBeDefined();
  });

  it("tells listeners what changed and logs every transition to the stream", async () => {
    const { queue, stream } = await open();
    const changes: WorkItemChange[] = [];
    const unsubscribe = queue.onItemChanged((change) => changes.push(change));

    await queue.create({ id: "item-1", title: "Fix", owner: "agent-a", createdBy: "human" });
    clockMs += 1000;
    await queue.claim("item-1", { actor: "agent-a" });
    clockMs += 1000;
    await queue.handoff("item-1", { to: "agent-b", actor: "agent-a" });
    await queue.create({ id: "item-1", title: "Fix", owner: "agent-a", createdBy: "human" });
    unsubscribe();
    await queue.recordDelivery("item-1", { state: "delivered" });

    expect(changes.map((change) => change.op)).toEqual(["create", "claim", "handoff"]);
    expect(changes[2].items.map((item) => item.state).sort()).toEqual(["handed-off", "pending"]);

    const page = await stream.list({ types: ["queue.transition"] });
    expect(page.entries.map((entry) => entry.data?.to)).toEqual([
      "handed-off",
      "pending",
      "in-progress",
      "pending",
    ]);
    expect(page.entries[0]).toMatchObject({ source: "agent-a", subject: "item-1" });
  });

  it("marks blocking and failing entries high urgency", async () => {
    const { queue, stream } = await open();
    await queue.create({ id: "item-1", title: "Fix", owner: "agent-a" });
    await queue.transition("item-1", {
      to: "blocked",
      closure: { reason: "blocked_on", target: "human" },
    });
    const [latest] = (await stream.list({ limit: 1 })).entries;
    expect(latest.urgency).toBe("high");
    expect(latest.tags).toContain("blocked");
  });

  it("stamps the delivery result with the clock", async () => {
    const { queue } = await open();
    await queue.create({ id: "item-1", title: "Fix", owner: "agent-a" });
    clockMs += 5000;
    const result = await queue.recordDelivery("item-1", { state: "failed", reason: "closed" });
    expect(result.item.delivery).toEqual({
      state: "failed",
      reason: "closed",
      at: new Date(START + 5000).toISOString(),
    });
  });

  it("keeps working when a listener throws", async () => {
    const { queue } = await open();
    queue.onItemChanged(() => {
      throw new Error("listener bug");
    });
    await expect(queue.create({ id: "item-1", title: "Fix", owner: "agent-a" })).resolves.toMatchObject(
      { changed: true },
    );
  });

  it("applies the configured retention window", async () => {
    const { queue } = await open();
    await queue.create({ id: "done", title: "t", owner: "agent-a" });
    await queue.create({ id: "open", title: "t", owner: "agent-a" });
    await queue.transition("done", { to: "done", closure: { reason: "no-follow-on" } });
    clockMs += 6 * DAY_MS;
    expect((await queue.runRetention()).archivedItemIds).toEqual([]);
    clockMs += 2 * DAY_MS;
    expect((await queue.runRetention()).archivedItemIds).toEqual(["done"]);
    expect((await queue.list({})).items.map((item) => item.id)).toEqual(["open"]);
  });
});
