import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { openCoordination, type Coordination } from "../../coordination/coordination.js";
import { CoordinationUnavailableError } from "../../coordination/runtime.js";
import { CoordinationSession, type CoordinationRequest } from "./coordination-session.js";

let paseoHome: string;
let coordination: Coordination;
let emitted: SessionOutboundMessage[];
let session: CoordinationSession;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "coordination-session-"));
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
  });
  emitted = [];
  session = new CoordinationSession({
    host: { emit: (msg) => emitted.push(msg) },
    coordination: { require: async () => coordination },
    logger: createTestLogger(),
  });
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

async function send(msg: CoordinationRequest): Promise<SessionOutboundMessage> {
  await session.handle(msg);
  const last = emitted.at(-1);
  if (!last) throw new Error("no response");
  return last;
}

describe("coordination session", () => {
  it("creates, claims and closes an item, acting as human by default", async () => {
    const created = await send({
      type: "coordination.queue.create.request",
      requestId: "r1",
      id: "wi-1",
      title: "Review",
      owner: "human",
    });
    expect(created).toMatchObject({
      type: "coordination.queue.create.response",
      payload: { requestId: "r1", changed: true, item: { id: "wi-1", createdBy: "human" } },
    });

    await send({ type: "coordination.queue.claim.request", requestId: "r2", id: "wi-1" });
    const closed = await send({
      type: "coordination.queue.transition.request",
      requestId: "r3",
      id: "wi-1",
      to: "done",
      closure: { reason: "no-follow-on" },
    });
    expect(closed).toMatchObject({ payload: { item: { state: "done", owner: "human" } } });

    const shown = await send({
      type: "coordination.queue.show.request",
      requestId: "r4",
      id: "wi-1",
    });
    expect(shown).toMatchObject({ type: "coordination.queue.show.response" });
    if (shown.type !== "coordination.queue.show.response") throw new Error("wrong type");
    expect(shown.payload.transitions?.map((row) => row.to)).toEqual([
      "pending",
      "in-progress",
      "done",
    ]);
  });

  it("answers a closure-contract violation as invalid, with the daemon's explanation", async () => {
    await send({
      type: "coordination.queue.create.request",
      requestId: "r1",
      id: "wi-1",
      title: "Review",
      owner: "agent-a",
    });
    const response = await send({
      type: "coordination.queue.transition.request",
      requestId: "r2",
      id: "wi-1",
      to: "done",
    });
    expect(response).toMatchObject({
      payload: { requestId: "r2", errorCode: "invalid", error: expect.stringMatching(/closure/) },
    });
  });

  it("answers an unknown id as not_found", async () => {
    const response = await send({
      type: "coordination.queue.show.request",
      requestId: "r1",
      id: "nope",
    });
    expect(response).toMatchObject({ payload: { errorCode: "not_found" } });
  });

  it("hands off and returns both halves", async () => {
    await send({
      type: "coordination.queue.create.request",
      requestId: "r1",
      id: "wi-1",
      title: "Review",
      owner: "agent-a",
      actor: "agent-a",
    });
    const response = await send({
      type: "coordination.queue.handoff.request",
      requestId: "r2",
      id: "wi-1",
      to: "agent-b",
      actor: "agent-a",
    });
    expect(response).toMatchObject({
      payload: {
        item: { id: "wi-1", state: "handed-off" },
        successor: { owner: "agent-b", state: "pending", handedOffFrom: "wi-1" },
      },
    });
  });

  it("lists items and stream entries", async () => {
    await send({
      type: "coordination.queue.create.request",
      requestId: "r1",
      title: "Review",
      owner: "agent-a",
    });
    const list = await send({
      type: "coordination.queue.list.request",
      requestId: "r2",
      filter: { owner: "agent-a", openOnly: true },
    });
    expect(list).toMatchObject({ payload: { items: [{ title: "Review" }] } });
    const stream = await send({ type: "coordination.stream.list.request", requestId: "r3" });
    expect(stream).toMatchObject({ payload: { entries: [{ type: "queue.transition" }] } });
  });

  it("answers every request as disabled when coordination is off", async () => {
    const off = new CoordinationSession({
      host: { emit: (msg) => emitted.push(msg) },
      coordination: {
        require: () =>
          Promise.reject(new CoordinationUnavailableError("Coordination is disabled.")),
      },
      logger: createTestLogger(),
    });
    await off.handle({ type: "coordination.queue.list.request", requestId: "r1" });
    expect(emitted.at(-1)).toEqual({
      type: "coordination.queue.list.response",
      payload: { requestId: "r1", error: "Coordination is disabled.", errorCode: "disabled" },
    });
  });
});
