import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { QueueValidationError } from "./state-machine.js";
import {
  QueueConflictError,
  WorkQueueStore,
  deriveSuccessorId,
  type CommitStep,
} from "./store.js";

const AT = "2026-09-30T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

let paseoHome: string;
let rootDir: string;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-queue-store-"));
  rootDir = path.join(paseoHome, "coordination", "queue");
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

async function openStore(onCommitStep?: (step: CommitStep) => Promise<void>) {
  return WorkQueueStore.open({ rootDir, logger: createTestLogger(), onCommitStep });
}

function at(offsetMs: number): string {
  return new Date(Date.parse(AT) + offsetMs).toISOString();
}

describe("create", () => {
  it("is idempotent on the caller's id", async () => {
    const store = await openStore();
    const first = await store.create({ id: "item-1", title: "Fix it", owner: "agent-a" }, AT);
    expect(first.changed).toBe(true);
    expect(first.item).toMatchObject({ id: "item-1", state: "pending", owner: "agent-a" });
    expect(first.item.delivery).toEqual({ state: "not_attempted" });

    const repeat = await store.create({ id: "item-1", title: "Fix it", owner: "agent-a" }, at(5));
    expect(repeat.changed).toBe(false);
    expect(repeat.item.createdAt).toBe(AT);
    expect((await store.get("item-1"))?.transitions).toHaveLength(1);
  });

  it("returns the item even after it has moved on", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "Fix it", owner: "agent-a" }, AT);
    await store.claim("item-1", { actor: "agent-a" }, at(1));
    const repeat = await store.create({ id: "item-1", title: "Fix it", owner: "agent-a" }, at(2));
    expect(repeat.item.state).toBe("in-progress");
  });

  it("rejects the same id with different content", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "Fix it", owner: "agent-a" }, AT);
    await expect(
      store.create({ id: "item-1", title: "Something else", owner: "agent-a" }, at(1)),
    ).rejects.toThrow(QueueConflictError);
  });

  it("rejects an id that cannot be a file name", async () => {
    const store = await openStore();
    await expect(store.create({ id: "../x", title: "t", owner: "a" }, AT)).rejects.toThrow(
      QueueValidationError,
    );
    await expect(store.create({ id: "a:b", title: "t", owner: "a" }, AT)).rejects.toThrow(
      QueueValidationError,
    );
  });

  it("survives a reopen", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "Fix it", owner: "agent-a" }, AT);
    const reopened = await openStore();
    const got = await reopened.get("item-1");
    expect(got?.item.title).toBe("Fix it");
    expect(got?.transitions).toEqual([
      expect.objectContaining({ seq: 1, itemId: "item-1", to: "pending" }),
    ]);
  });
});

describe("claim and transition", () => {
  it("records each move in the journal", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "t", owner: "human" }, AT);
    await store.claim("item-1", { actor: "agent-a" }, at(1));
    const done = await store.transition(
      "item-1",
      { to: "done", closure: { reason: "no-follow-on" }, actor: "agent-a" },
      at(2),
    );
    expect(done.item).toMatchObject({ state: "done", owner: "agent-a", closedAt: at(2) });
    const reopened = await openStore();
    const got = await reopened.get("item-1");
    expect(got?.transitions.map((t) => [t.from, t.to])).toEqual([
      [undefined, "pending"],
      ["pending", "in-progress"],
      ["in-progress", "done"],
    ]);
  });

  it("treats a repeat claim by the owner as a no-op and teaches anyone else to hand off", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await store.claim("item-1", { actor: "agent-a" }, at(1));
    const again = await store.claim("item-1", { actor: "agent-a" }, at(2));
    expect(again.changed).toBe(false);
    await expect(store.claim("item-1", { actor: "agent-b" }, at(3))).rejects.toThrow(/handoff/);
  });

  it("enforces the closure contract", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await expect(store.transition("item-1", { to: "done" }, at(1))).rejects.toThrow(
      /closure reason/,
    );
    const canceled = await store.transition("item-1", { to: "canceled" }, at(2));
    expect(canceled.item.closure).toEqual({ reason: "canceled" });
  });

  it("rejects a stale revision", async () => {
    const store = await openStore();
    const created = await store.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await store.update("item-1", { title: "t2" }, at(1));
    await expect(
      store.transition(
        "item-1",
        { to: "in-progress", expectedRevision: created.item.revision },
        at(2),
      ),
    ).rejects.toThrow(QueueConflictError);
  });

  it("stores the delivery result", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await store.update("item-1", { delivery: { state: "failed", reason: "closed", at: at(1) } }, at(1));
    const reopened = await openStore();
    expect((await reopened.get("item-1"))?.item.delivery).toEqual({
      state: "failed",
      reason: "closed",
      at: at(1),
    });
  });
});

describe("handoff", () => {
  it("closes the source and opens the successor together", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "t", owner: "agent-a", tags: ["x"] }, AT);
    const result = await store.handoff("item-1", { to: "agent-b", actor: "agent-a" }, at(1));
    const successorId = deriveSuccessorId("item-1");
    expect(result.source).toMatchObject({
      state: "handed-off",
      handedOffTo: successorId,
      closure: { reason: "handed_off_to", target: "agent-b" },
    });
    expect(result.successor).toMatchObject({
      id: successorId,
      owner: "agent-b",
      state: "pending",
      handedOffFrom: "item-1",
      tags: ["x"],
    });

    const retry = await store.handoff("item-1", { to: "agent-b", actor: "agent-a" }, at(2));
    expect(retry.changed).toBe(false);
    expect(retry.successor.id).toBe(successorId);
    await expect(store.handoff("item-1", { to: "agent-c" }, at(3))).rejects.toThrow(
      /already handed-off/,
    );
  });

  it("derives the same successor id every time", () => {
    expect(deriveSuccessorId("item-1")).toBe(deriveSuccessorId("item-1"));
    expect(deriveSuccessorId("item-1")).not.toBe(deriveSuccessorId("item-2"));
  });

  it("completes a commit cut off after the journal intent", async () => {
    const crashing = await openStore(async (step) => {
      if (step.kind === "begun" && step.op === "handoff") throw new Error("daemon killed");
    });
    await crashing.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await expect(crashing.handoff("item-1", { to: "agent-b" }, at(1))).rejects.toThrow(
      "daemon killed",
    );

    const recovered = await openStore();
    await expectExactlyOneOpenSuccessor(recovered);
  });

  it("completes a commit cut off between successor create and source close", async () => {
    const successorId = deriveSuccessorId("item-1");
    const crashing = await openStore(async (step) => {
      if (step.kind === "item-written" && step.itemId === successorId) {
        throw new Error("daemon killed");
      }
    });
    await crashing.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await expect(crashing.handoff("item-1", { to: "agent-b" }, at(1))).rejects.toThrow(
      "daemon killed",
    );
    const sourceOnDisk = JSON.parse(
      await fs.readFile(path.join(rootDir, "items", "item-1.json"), "utf8"),
    );
    expect(sourceOnDisk.state).toBe("pending");

    const recovered = await openStore();
    await expectExactlyOneOpenSuccessor(recovered);
    const again = await openStore();
    await expectExactlyOneOpenSuccessor(again);
  });

  it("recovers in the same instance after a failed commit", async () => {
    let failOnce = true;
    const store = await openStore(async (step) => {
      if (step.kind === "begun" && step.op === "handoff" && failOnce) {
        failOnce = false;
        throw new Error("disk hiccup");
      }
    });
    await store.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await expect(store.handoff("item-1", { to: "agent-b" }, at(1))).rejects.toThrow();
    await expectExactlyOneOpenSuccessor(store);
  });
});

async function expectExactlyOneOpenSuccessor(store: WorkQueueStore): Promise<void> {
  const open = await store.list({ openOnly: true });
  expect(open.items.map((item) => item.id)).toEqual([deriveSuccessorId("item-1")]);
  const source = await store.get("item-1");
  expect(source?.item.state).toBe("handed-off");
  expect(source?.transitions.map((t) => t.to)).toEqual(["pending", "handed-off"]);
  const successor = await store.get(deriveSuccessorId("item-1"));
  expect(successor?.transitions.map((t) => t.to)).toEqual(["pending"]);
}

describe("list", () => {
  it("filters and pages with a cursor", async () => {
    const store = await openStore();
    for (let i = 0; i < 5; i += 1) {
      await store.create(
        { id: `item-${i}`, title: `t${i}`, owner: i % 2 === 0 ? "agent-a" : "agent-b" },
        at(i),
      );
    }
    await store.transition("item-0", { to: "canceled" }, at(10));

    const first = await store.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["item-0", "item-1"]);
    expect(first.nextCursor).toBeDefined();
    const second = await store.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(["item-2", "item-3"]);
    const third = await store.list({ limit: 2, cursor: second.nextCursor });
    expect(third.items.map((item) => item.id)).toEqual(["item-4"]);
    expect(third.nextCursor).toBeUndefined();

    const ownedOpen = await store.list({ owner: "agent-a", openOnly: true });
    expect(ownedOpen.items.map((item) => item.id)).toEqual(["item-2", "item-4"]);
    const canceled = await store.list({ states: ["canceled"] });
    expect(canceled.items.map((item) => item.id)).toEqual(["item-0"]);
  });

  it("rejects a cursor it did not mint", async () => {
    const store = await openStore();
    await expect(store.list({ cursor: "nonsense" })).rejects.toThrow(QueueValidationError);
  });
});

describe("retention", () => {
  it("moves old closed items to the archive and never drops an open one", async () => {
    const store = await openStore();
    await store.create({ id: "old-open", title: "t", owner: "agent-a" }, AT);
    await store.create({ id: "old-done", title: "t", owner: "agent-a" }, AT);
    await store.create({ id: "new-done", title: "t", owner: "agent-a" }, AT);
    await store.create({ id: "old-blocked", title: "t", owner: "agent-a" }, AT);
    await store.transition(
      "old-done",
      { to: "done", closure: { reason: "no-follow-on" } },
      at(1),
    );
    await store.transition(
      "old-blocked",
      { to: "blocked", closure: { reason: "blocked_on", target: "human" } },
      at(1),
    );
    await store.transition("new-done", { to: "canceled" }, at(40 * DAY_MS));

    const result = await store.compact({ now: at(45 * DAY_MS), closedItemMaxAgeMs: 30 * DAY_MS });
    expect(result.archivedItemIds).toEqual(["old-done"]);

    const reopened = await openStore();
    const ids = (await reopened.list({})).items.map((item) => item.id).sort();
    expect(ids).toEqual(["new-done", "old-blocked", "old-open"]);
    expect((await reopened.get("old-open"))?.transitions).toHaveLength(1);
    expect(await reopened.get("old-done")).toBeNull();

    const archiveDir = path.join(rootDir, "archive");
    const [archiveFile] = await fs.readdir(archiveDir);
    const archived = JSON.parse(
      (await fs.readFile(path.join(archiveDir, archiveFile), "utf8")).trim(),
    );
    expect(archived.item.id).toBe("old-done");
    expect(archived.transitions.map((t: { to: string }) => t.to)).toEqual(["pending", "done"]);

    const next = await reopened.create({ id: "after", title: "t", owner: "agent-a" }, at(46 * DAY_MS));
    expect(next.transitions[0].seq).toBeGreaterThan(6);
  });
});

describe("journal", () => {
  it("ignores a torn last line", async () => {
    const store = await openStore();
    await store.create({ id: "item-1", title: "t", owner: "agent-a" }, AT);
    await fs.appendFile(path.join(rootDir, "journal.jsonl"), '{"kind":"beg');
    const reopened = await openStore();
    await reopened.create({ id: "item-2", title: "t", owner: "agent-a" }, at(1));
    const again = await openStore();
    expect((await again.list({})).items).toHaveLength(2);
  });
});
