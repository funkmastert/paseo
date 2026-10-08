import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { InvalidNotePathError, NoteConflictError, NoteStore } from "./note-store.js";

let notesDir: string;
let store: NoteStore;

beforeEach(async () => {
  notesDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-note-store-"));
  store = new NoteStore(notesDir);
});

afterEach(async () => {
  await fs.rm(notesDir, { recursive: true, force: true });
});

describe("write with expectedModifiedAt", () => {
  test("a stale expectedModifiedAt fails with a conflict and leaves the file untouched", async () => {
    await store.write("projects/a.md", "version one");
    const read = await store.read("projects/a.md");
    expect(read).not.toBeNull();

    // Someone else writes in between.
    await store.write("projects/a.md", "version two");

    await expect(
      store.write("projects/a.md", "version three", { expectedModifiedAt: read!.modifiedAt }),
    ).rejects.toThrow(NoteConflictError);

    const final = await store.read("projects/a.md");
    expect(final?.content).toBe("version two");
  });

  test("expectedModifiedAt: null requires the note not exist yet", async () => {
    await store.write("projects/b.md", "first", { expectedModifiedAt: null });
    await expect(
      store.write("projects/b.md", "second", { expectedModifiedAt: null }),
    ).rejects.toThrow(NoteConflictError);
  });
});

describe("concurrent writes to one note", () => {
  test("apply in call order; the last one issued always wins, never a corrupted interleave", async () => {
    const writes = ["v0", "v1", "v2", "v3", "v4"].map((value) =>
      store.write("projects/race.md", value),
    );
    await Promise.all(writes);

    const final = await store.read("projects/race.md");
    expect(final?.content).toBe("v4");
  });
});

describe("path safety", () => {
  test("a note path of ../x is rejected", async () => {
    await expect(store.write("../x", "escape")).rejects.toThrow(InvalidNotePathError);
    await expect(store.read("../x")).rejects.toThrow(InvalidNotePathError);
  });
});

describe("list and read", () => {
  test("list finds every .md file, read reports a usable modifiedAt", async () => {
    await store.write("projects/a.md", "a");
    await store.write("inbox.md", "inbox");
    expect(await store.list()).toEqual(["inbox.md", "projects/a.md"]);

    const record = await store.read("projects/a.md");
    expect(record?.content).toBe("a");
    expect(typeof record?.modifiedAt).toBe("number");
  });

  test("read of a missing note returns null", async () => {
    expect(await store.read("projects/missing.md")).toBeNull();
  });
});

describe("ensureInbox", () => {
  test("creates inbox.md once and returns the existing one on a second call", async () => {
    const first = await store.ensureInbox();
    expect(first.path).toBe("inbox.md");
    expect(first.content).toContain("title: Inbox");

    const second = await store.ensureInbox();
    expect(second.content).toBe(first.content);
  });

  test("two concurrent ensureInbox calls do not corrupt the file", async () => {
    const [first, second] = await Promise.all([store.ensureInbox(), store.ensureInbox()]);
    expect(first.content).toBe(second.content);
    const files = await store.list();
    expect(files).toEqual(["inbox.md"]);
  });
});

describe("write scrubs content", () => {
  test("a token-shaped span in the written content is redacted and reported", async () => {
    const result = await store.write(
      "projects/c.md",
      `decision: key sk-ant-${"a".repeat(20)} must not be stored`,
    );
    expect(result.removedSecretSpans).toBe(1);
    const record = await store.read("projects/c.md");
    expect(record?.content).toContain("[redacted]");
    expect(record?.content).not.toContain("sk-ant-");
  });
});
