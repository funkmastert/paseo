import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openCoordination, type Coordination } from "../coordination.js";
import { handBackOpenItemsForArchivedAgent } from "./archive-handback.js";

let paseoHome: string;
let coordination: Coordination;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-queue-archive-handback-"));
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
  });
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

async function stateOf(id: string) {
  return (await coordination.queue.get(id))?.item;
}

describe("handBackOpenItemsForArchivedAgent", () => {
  it("hands every open item owned by the archived agent to its parent", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });
    await coordination.queue.create({ id: "wi-2", title: "Fix", owner: "agent-a" });
    await coordination.queue.claim("wi-1", { actor: "agent-a" });

    await handBackOpenItemsForArchivedAgent({
      queue: coordination.queue,
      agentId: "agent-a",
      parentAgentId: "leader-1",
      logger: createTestLogger(),
    });

    for (const id of ["wi-1", "wi-2"]) {
      const item = await stateOf(id);
      expect(item?.state).toBe("handed-off");
      expect(item?.closure).toEqual({ reason: "handed_off_to", target: "leader-1" });
      const successor = await coordination.queue.list({ owner: "leader-1" });
      expect(successor.items.some((candidate) => candidate.handedOffFrom === id)).toBe(true);
    }
  });

  it("hands a root's open item to human", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });

    await handBackOpenItemsForArchivedAgent({
      queue: coordination.queue,
      agentId: "agent-a",
      parentAgentId: null,
      logger: createTestLogger(),
    });

    expect((await stateOf("wi-1"))?.closure).toEqual({
      reason: "handed_off_to",
      target: "human",
    });
  });

  it("leaves closed items alone", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });
    await coordination.queue.transition("wi-1", {
      to: "done",
      closure: { reason: "no-follow-on" },
    });

    await handBackOpenItemsForArchivedAgent({
      queue: coordination.queue,
      agentId: "agent-a",
      parentAgentId: "leader-1",
      logger: createTestLogger(),
    });

    expect((await stateOf("wi-1"))?.state).toBe("done");
  });

  it("does nothing when coordination is off", async () => {
    await expect(
      handBackOpenItemsForArchivedAgent({
        queue: null,
        agentId: "agent-a",
        parentAgentId: "leader-1",
        logger: createTestLogger(),
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the queue rejects a handoff", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });

    await expect(
      handBackOpenItemsForArchivedAgent({
        queue: {
          list: coordination.queue.list.bind(coordination.queue),
          handoff: async () => {
            throw new Error("boom");
          },
        } as unknown as typeof coordination.queue,
        agentId: "agent-a",
        parentAgentId: "leader-1",
        logger: createTestLogger(),
      }),
    ).resolves.toBeUndefined();
  });
});
