import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { StreamStore, type StreamRetention } from "./store.js";

const AT = Date.parse("2026-09-30T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION: StreamRetention = { maxEntries: 1000, maxAgeMs: 30 * DAY_MS };

let paseoHome: string;
let rootDir: string;

beforeEach(async () => {
  paseoHome = await fs.mkdtemp(path.join(os.tmpdir(), "work-stream-"));
  rootDir = path.join(paseoHome, "coordination", "stream");
});

afterEach(async () => {
  await fs.rm(paseoHome, { recursive: true, force: true });
});

function at(offsetMs: number): string {
  return new Date(AT + offsetMs).toISOString();
}

async function openStream(retention: StreamRetention = RETENTION) {
  return StreamStore.open({ rootDir, retention, logger: createTestLogger() });
}

async function appendN(stream: StreamStore, count: number, offsetMs = 0) {
  for (let i = 0; i < count; i += 1) {
    await stream.append(
      { id: `e-${i}`, type: i % 2 ? "queue.transition" : "agent.note", source: "queue", summary: `${i}` },
      at(offsetMs + i),
    );
  }
}

describe("stream", () => {
  it("appends with increasing seq and survives a reopen", async () => {
    const stream = await openStream();
    const first = await stream.append(
      {
        id: "e-1",
        type: "queue.transition",
        source: "queue",
        summary: "item-1 pending",
        urgency: "high",
        tags: ["pending"],
        subject: "item-1",
      },
      at(0),
    );
    const second = await stream.append(
      { id: "e-2", type: "agent.note", source: "agent-a", summary: "hi" },
      at(1),
    );
    expect(second.seq).toBeGreaterThan(first.seq);
    const reopened = await openStream();
    const page = await reopened.list({});
    expect(page.entries.map((entry) => entry.id)).toEqual(["e-2", "e-1"]);
    expect(page.entries[1]).toMatchObject({ urgency: "high", tags: ["pending"], subject: "item-1" });
  });

  it("pages newest first with a cursor and filters by type", async () => {
    const stream = await openStream();
    await appendN(stream, 5);
    const first = await stream.list({ limit: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(["e-4", "e-3"]);
    const second = await stream.list({ limit: 2, cursor: first.nextCursor });
    expect(second.entries.map((entry) => entry.id)).toEqual(["e-2", "e-1"]);
    const third = await stream.list({ limit: 2, cursor: second.nextCursor });
    expect(third.entries.map((entry) => entry.id)).toEqual(["e-0"]);
    expect(third.nextCursor).toBeUndefined();

    const notes = await stream.list({ types: ["agent.note"] });
    expect(notes.entries.map((entry) => entry.id)).toEqual(["e-4", "e-2", "e-0"]);
  });

  it("hides archived entries by default and keeps them on disk", async () => {
    const stream = await openStream();
    await appendN(stream, 3);
    const archived = await stream.archive("e-1", at(10));
    expect(archived?.archivedAt).toBe(at(10));
    expect((await stream.archive("e-1", at(11)))?.archivedAt).toBe(at(10));

    const reopened = await openStream();
    expect((await reopened.list({})).entries.map((entry) => entry.id)).toEqual(["e-2", "e-0"]);
    expect(
      (await reopened.list({ includeArchived: true })).entries.map((entry) => entry.id),
    ).toEqual(["e-2", "e-1", "e-0"]);
  });

  it("is idempotent on the entry id", async () => {
    const stream = await openStream();
    const first = await stream.append({ id: "e-1", type: "t", source: "s", summary: "x" }, at(0));
    const again = await stream.append({ id: "e-1", type: "t", source: "s", summary: "x" }, at(1));
    expect(again.seq).toBe(first.seq);
    expect((await stream.list({})).entries).toHaveLength(1);
  });

  it("keeps the log bounded by count and age", async () => {
    const stream = await openStream({ maxEntries: 3, maxAgeMs: 30 * DAY_MS });
    await appendN(stream, 10);
    await stream.compact(at(20));
    expect((await stream.list({})).entries.map((entry) => entry.id)).toEqual(["e-9", "e-8", "e-7"]);

    await stream.compact(at(31 * DAY_MS));
    expect((await stream.list({})).entries).toEqual([]);
    const next = await stream.append({ id: "late", type: "t", source: "s", summary: "x" }, at(32 * DAY_MS));
    expect(next.seq).toBeGreaterThan(10);
  });

  it("compacts on its own once the file holds twice the cap", async () => {
    const stream = await openStream({ maxEntries: 3, maxAgeMs: 30 * DAY_MS });
    await appendN(stream, 7);
    const lines = (await fs.readFile(path.join(rootDir, "entries.jsonl"), "utf8"))
      .trim()
      .split("\n");
    // The sixth append reached twice the cap and rewrote the file down to the newest three.
    expect(lines.length).toBe(5);
    expect((await stream.list({})).entries.map((entry) => entry.id)).toEqual([
      "e-6",
      "e-5",
      "e-4",
      "e-3",
    ]);
  });
});
