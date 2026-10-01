import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { PushPayload, PushSendMeta } from "../../push/index.js";
import { openCoordination, type Coordination } from "../coordination.js";
import { WorkQueueInboxPush } from "./push.js";

let paseoHome: string;
let coordination: Coordination;
let sent: { payload: PushPayload; meta: PushSendMeta | undefined }[];
let inboxPush: WorkQueueInboxPush;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-push-"));
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
  });
  sent = [];
  inboxPush = new WorkQueueInboxPush({
    queue: coordination.queue,
    serverId: "server-1",
    logger: createTestLogger(),
    push: {
      send: async (payload, meta) => {
        sent.push({ payload, meta });
      },
    },
  });
  inboxPush.start();
});

afterEach(async () => {
  inboxPush.stop();
  await fs.rm(paseoHome, { recursive: true, force: true });
});

describe("WorkQueueInboxPush", () => {
  it("pushes once when an item is created for human", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review the plan", owner: "human" });
    await inboxPush.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      data: { reason: "coordination_inbox_item", serverId: "server-1", itemId: "wi-1" },
    });
    expect(sent[0]?.meta).toMatchObject({ level: "alert" });
  });

  it("pushes once when an item is handed off to human, not for the closed source", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });
    await inboxPush.idle();
    expect(sent).toHaveLength(0);
    const handoff = await coordination.queue.handoff("wi-1", { to: "human", actor: "agent-a" });
    await inboxPush.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.data).toMatchObject({ itemId: handoff.successor.id });
  });

  it("never pushes twice for an idempotent repeat create", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    await inboxPush.idle();
    expect(sent).toHaveLength(1);
  });

  it("does not push for an item created for an agent", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "agent-a" });
    await inboxPush.idle();
    expect(sent).toHaveLength(0);
  });
});
