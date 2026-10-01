import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openCoordination, type Coordination } from "../coordination.js";
import { applyInboxAct, type InboxActOptions } from "./act.js";

const START = Date.parse("2026-09-30T12:00:00.000Z");

let paseoHome: string;
let clockMs: number;
let idCounter: number;
let coordination: Coordination;
let auditLines: unknown[];

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-act-"));
  clockMs = START;
  idCounter = 0;
  auditLines = [];
  coordination = await openCoordination({
    paseoHome,
    config: { enabled: true },
    logger: createTestLogger(),
    now: () => new Date(clockMs),
    newId: () => `id-${++idCounter}`,
  });
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

function options(): InboxActOptions {
  return {
    queue: coordination.queue,
    stream: coordination.stream,
    audit: { append: (line) => auditLines.push(line) },
    now: () => new Date(clockMs),
  };
}

describe("applyInboxAct", () => {
  it("approve moves the item to done with no-follow-on and audits it", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    const result = await applyInboxAct(options(), { id: "wi-1", verb: "approve" });
    expect(result.item).toMatchObject({
      id: "wi-1",
      state: "done",
      closure: { reason: "no-follow-on" },
    });
    expect(auditLines).toMatchObject([
      { verb: "approve", itemId: "wi-1", actor: "human", outcome: "applied", state: "done" },
    ]);
  });

  it("deny moves the item to denied", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    const result = await applyInboxAct(options(), { id: "wi-1", verb: "deny", note: "no" });
    expect(result.item).toMatchObject({ state: "denied", closure: { reason: "denied" } });
  });

  it("hold blocks the item on human", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    const result = await applyInboxAct(options(), { id: "wi-1", verb: "hold" });
    expect(result.item).toMatchObject({
      state: "blocked",
      closure: { reason: "blocked_on", target: "human" },
    });
  });

  it("drop cancels the item", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    const result = await applyInboxAct(options(), { id: "wi-1", verb: "drop" });
    expect(result.item).toMatchObject({ state: "canceled" });
  });

  it("route hands the item off to the chosen agent", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    const result = await applyInboxAct(options(), { id: "wi-1", verb: "route", to: "agent-a" });
    expect(result.item).toMatchObject({ id: "wi-1", state: "handed-off" });
    expect(result.successor).toMatchObject({ owner: "agent-a", handedOffFrom: "wi-1" });
  });

  it("route with no target is refused", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    await expect(applyInboxAct(options(), { id: "wi-1", verb: "route" })).rejects.toThrow(
      /needs `to`/,
    );
    expect(auditLines).toMatchObject([{ outcome: "refused" }]);
  });

  it("annotate leaves the state alone and appends a stream entry carrying the note", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    const before = await coordination.queue.get("wi-1");
    const result = await applyInboxAct(options(), {
      id: "wi-1",
      verb: "annotate",
      note: "waiting on legal",
    });
    expect(result.item.state).toBe(before?.item.state);
    const page = await coordination.stream.list({ types: ["coordination.inbox.annotate"] });
    expect(page.entries).toMatchObject([
      { type: "coordination.inbox.annotate", subject: "wi-1", summary: "waiting on legal" },
    ]);
  });

  it("annotate with no note is refused", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    await expect(applyInboxAct(options(), { id: "wi-1", verb: "annotate" })).rejects.toThrow(
      /needs a note/,
    );
  });

  it("refuses any verb on a closed item with a teaching error, including annotate", async () => {
    await coordination.queue.create({ id: "wi-1", title: "Review", owner: "human" });
    await applyInboxAct(options(), { id: "wi-1", verb: "approve" });
    await expect(applyInboxAct(options(), { id: "wi-1", verb: "deny" })).rejects.toThrow(
      /already done/,
    );
    await expect(
      applyInboxAct(options(), { id: "wi-1", verb: "annotate", note: "too late" }),
    ).rejects.toThrow(/already done/);
    expect(
      auditLines.filter((line) => (line as { outcome: string }).outcome === "refused"),
    ).toHaveLength(2);
  });

  it("refuses an unknown item id", async () => {
    await expect(applyInboxAct(options(), { id: "nope", verb: "approve" })).rejects.toThrow(
      /No work item/,
    );
  });
});
