import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openCoordination, type Coordination } from "../coordination.js";
import { WorkQueueFinishLink } from "./finish-link.js";

let paseoHome: string;
let coordination: Coordination;
let finalMessages: Map<string, string>;
let fireTurnEnded: (agentId: string) => void;
let link: WorkQueueFinishLink;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-queue-finish-link-"));
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
  });
  finalMessages = new Map();
  link = new WorkQueueFinishLink({
    queue: coordination.queue,
    turns: {
      onTurnEnded: (listener) => {
        fireTurnEnded = listener;
        return () => undefined;
      },
      getFinalMessage: async (agentId) => finalMessages.get(agentId) ?? null,
    },
    logger: createTestLogger(),
  });
  link.start();
  await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });
  await coordination.queue.claim("wi-1", { actor: "agent-a" });
});

afterEach(async () => {
  link.stop();
  await fs.rm(paseoHome, { recursive: true, force: true });
});

async function stateOf(id: string) {
  return (await coordination.queue.get(id))?.item;
}

describe("finish link", () => {
  it("closes an owned item from a valid marker in the final message", async () => {
    finalMessages.set("agent-a", "Reviewed.\nqueue: wi-1 done no-follow-on");
    fireTurnEnded("agent-a");
    await link.idle();
    expect(await stateOf("wi-1")).toMatchObject({
      state: "done",
      closure: { reason: "no-follow-on" },
    });
  });

  it("leaves the item in progress when the final message has no marker", async () => {
    finalMessages.set("agent-a", "Reviewed; all done.");
    const result = await link.handleTurnEnded("agent-a");
    expect(result).toEqual({ applied: [], rejected: [], malformed: 0 });
    expect(await stateOf("wi-1")).toMatchObject({ state: "in-progress" });
  });

  it("changes nothing for a malformed marker", async () => {
    finalMessages.set("agent-a", "queue: wi-1 done because");
    const result = await link.handleTurnEnded("agent-a");
    expect(result.malformed).toBe(1);
    expect(await stateOf("wi-1")).toMatchObject({ state: "in-progress" });
  });

  it("changes nothing when the closure contract rejects the marker", async () => {
    finalMessages.set("agent-a", "queue: wi-1 done");
    const result = await link.handleTurnEnded("agent-a");
    expect(result.rejected).toEqual([{ itemId: "wi-1", reason: expect.any(String) }]);
    expect(await stateOf("wi-1")).toMatchObject({ state: "in-progress" });
  });

  it("ignores a marker for an item the agent does not own", async () => {
    await coordination.queue.create({ id: "wi-2", title: "Other", owner: "agent-b" });
    finalMessages.set("agent-a", "queue: wi-2 canceled");
    const result = await link.handleTurnEnded("agent-a");
    expect(result.rejected.map((entry) => entry.itemId)).toEqual(["wi-2"]);
    expect(await stateOf("wi-2")).toMatchObject({ state: "pending" });
  });
});
