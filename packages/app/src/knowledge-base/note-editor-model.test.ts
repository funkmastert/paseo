import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KnowledgeNoteEditor,
  type KnowledgeNoteEditorBackend,
  type KnowledgeNoteRead,
  type KnowledgeNoteWriteInput,
  type KnowledgeNoteWritten,
} from "./note-editor-model";

const PATH = "projects/checkout-redesign.md";
const ORIGINAL = "---\ntitle: Checkout redesign\n---\n\n## Summary\nOld summary\n";

class TestRpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`kb request failed: ${code}`);
    this.code = code;
  }
}

class TestBackend implements KnowledgeNoteEditorBackend {
  writes: KnowledgeNoteWriteInput[] = [];
  reads = 0;
  disk: KnowledgeNoteRead = { status: "ready", content: ORIGINAL, modifiedAt: 1000 };
  nextWriteError: TestRpcError | null = null;
  scrub: (content: string) => { content: string; removed: number } = (content) => ({
    content,
    removed: 0,
  });

  async write(input: KnowledgeNoteWriteInput): Promise<KnowledgeNoteWritten> {
    this.writes.push(input);
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const scrubbed = this.scrub(input.content);
    const modifiedAt = this.disk.status === "ready" ? this.disk.modifiedAt + 1 : 1;
    this.disk = { status: "ready", content: scrubbed.content, modifiedAt };
    return { content: scrubbed.content, modifiedAt, removedSecretSpans: scrubbed.removed };
  }

  async read(): Promise<KnowledgeNoteRead> {
    this.reads += 1;
    return this.disk;
  }
}

function openEditor(backend = new TestBackend()) {
  const editor = new KnowledgeNoteEditor({
    note: { path: PATH, content: ORIGINAL, modifiedAt: 1000 },
    backend,
  });
  return { editor, backend };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("KnowledgeNoteEditor", () => {
  it("never writes until Save, however long the draft sits", async () => {
    const { editor, backend } = openEditor();

    editor.edit(`${ORIGINAL}- [decision] Ship it\n`);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(backend.writes).toEqual([]);
    expect(editor.getSnapshot().file.status).toBe("dirty");
  });

  it("moves dirty to saving to clean on Save and writes against the opened modifiedAt", async () => {
    const { editor, backend } = openEditor();
    const draft = `${ORIGINAL}- [decision] Ship it\n`;
    editor.edit(draft);

    const statuses: string[] = [];
    editor.subscribe(() => statuses.push(editor.getSnapshot().file.status));
    await editor.save();

    expect(backend.writes).toEqual([{ path: PATH, content: draft, expectedModifiedAt: 1000 }]);
    expect(statuses[0]).toBe("saving");
    expect(editor.getSnapshot().file).toMatchObject({
      status: "clean",
      content: draft,
      modified: false,
    });
    expect(editor.getSnapshot().removedSecretSpans).toBe(0);
  });

  it("adopts the scrubbed text the daemon returns without raising a conflict", async () => {
    const backend = new TestBackend();
    backend.scrub = (content) => ({
      content: content.replace("ghp_fakeTokenDoNotUse1234567890", "[redacted]"),
      removed: 1,
    });
    const { editor } = openEditor(backend);
    editor.edit(`${ORIGINAL}- [rule] token ghp_fakeTokenDoNotUse1234567890\n`);

    await editor.save();

    expect(editor.getSnapshot()).toMatchObject({
      file: {
        status: "clean",
        content: `${ORIGINAL}- [rule] token [redacted]\n`,
        modified: false,
      },
      removedSecretSpans: 1,
      callout: null,
    });

    // The next poll returns what was written; nothing changes and no conflict appears.
    editor.receiveRead(await backend.read());
    expect(editor.getSnapshot().file.status).toBe("clean");
    expect(editor.getSnapshot().callout).toBeNull();
  });

  it("adopts the scrubbed text when the web editor saves through the model (Mod-S)", async () => {
    const backend = new TestBackend();
    backend.scrub = (content) => ({ content: content.replace("secret", "[redacted]"), removed: 1 });
    const { editor } = openEditor(backend);
    editor.edit(`${ORIGINAL}secret\n`);

    await editor.model.save();

    expect(editor.getSnapshot()).toMatchObject({
      file: { status: "clean", content: `${ORIGINAL}[redacted]\n` },
      removedSecretSpans: 1,
    });
  });

  it("keeps the draft and offers Reload and Overwrite on a conflict", async () => {
    const { editor, backend } = openEditor();
    const draft = `${ORIGINAL}- [decision] Mine\n`;
    editor.edit(draft);
    backend.disk = {
      status: "ready",
      content: `${ORIGINAL}- [decision] Theirs\n`,
      modifiedAt: 1500,
    };
    backend.nextWriteError = new TestRpcError("conflict");

    await editor.save();

    expect(editor.getSnapshot()).toMatchObject({
      file: { status: "conflict", content: draft, modified: true },
      callout: { kind: "changed", canOverwrite: true },
    });
  });

  it("writes the draft without an expectedModifiedAt check on Overwrite", async () => {
    const { editor, backend } = openEditor();
    const draft = `${ORIGINAL}- [decision] Mine\n`;
    editor.edit(draft);
    backend.disk = {
      status: "ready",
      content: `${ORIGINAL}- [decision] Theirs\n`,
      modifiedAt: 1500,
    };
    backend.nextWriteError = new TestRpcError("conflict");
    await editor.save();

    await editor.overwrite();

    expect(backend.writes.at(-1)).toEqual({ path: PATH, content: draft });
    expect(editor.getSnapshot()).toMatchObject({
      file: { status: "clean", content: draft, modified: false },
      callout: null,
    });
  });

  it("replaces the draft with the latest note on Reload", async () => {
    const { editor, backend } = openEditor();
    editor.edit(`${ORIGINAL}- [decision] Mine\n`);
    const theirs = `${ORIGINAL}- [decision] Theirs\n`;
    backend.disk = { status: "ready", content: theirs, modifiedAt: 1500 };
    backend.nextWriteError = new TestRpcError("conflict");
    await editor.save();

    await editor.reload();

    expect(editor.getSnapshot()).toMatchObject({
      file: { status: "clean", content: theirs, modified: false },
      callout: null,
    });
  });

  it("raises a conflict when a poll brings a newer note under a dirty draft", () => {
    const { editor } = openEditor();
    editor.edit(`${ORIGINAL}- [decision] Mine\n`);

    editor.receiveRead({ status: "ready", content: `${ORIGINAL}changed\n`, modifiedAt: 2000 });

    expect(editor.getSnapshot().callout).toEqual({ kind: "changed", canOverwrite: true });
  });

  it("follows a newer note while clean and ignores a stale poll", () => {
    const { editor } = openEditor();
    const newer = `${ORIGINAL}newer\n`;

    editor.receiveRead({ status: "ready", content: newer, modifiedAt: 2000 });
    editor.receiveRead({ status: "ready", content: ORIGINAL, modifiedAt: 1000 });

    expect(editor.getSnapshot().file).toMatchObject({ status: "clean", content: newer });
  });

  it("shows the deleted callout, keeping the draft, when the note disappears", () => {
    const { editor } = openEditor();
    const draft = `${ORIGINAL}- [decision] Mine\n`;
    editor.edit(draft);

    editor.receiveRead({ status: "missing" });

    expect(editor.getSnapshot()).toMatchObject({
      file: { status: "conflict", content: draft },
      callout: { kind: "deleted" },
    });
  });

  it("reports a failed write as an error and keeps the draft", async () => {
    const { editor, backend } = openEditor();
    const draft = `${ORIGINAL}x\n`;
    editor.edit(draft);
    backend.nextWriteError = new TestRpcError("kb_operation_failed");

    await editor.save();

    expect(editor.getSnapshot().file).toMatchObject({
      status: "error",
      content: draft,
      error: "kb request failed: kb_operation_failed",
    });
  });
});

describe("KnowledgeNoteEditor.requestLeave", () => {
  it("leaves a clean note without asking", async () => {
    const { editor } = openEditor();
    const ask = vi.fn(async () => "save" as const);

    await expect(editor.requestLeave(ask)).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks Save or Discard for a dirty note and saves on Save", async () => {
    const { editor, backend } = openEditor();
    const draft = `${ORIGINAL}x\n`;
    editor.edit(draft);

    await expect(editor.requestLeave(async () => "save")).resolves.toBe(true);
    expect(backend.writes).toEqual([{ path: PATH, content: draft, expectedModifiedAt: 1000 }]);
  });

  it("drops the draft on Discard without writing", async () => {
    const { editor, backend } = openEditor();
    editor.edit(`${ORIGINAL}x\n`);

    await expect(editor.requestLeave(async () => "discard")).resolves.toBe(true);
    expect(backend.writes).toEqual([]);
    expect(editor.getSnapshot().file).toMatchObject({ status: "clean", content: ORIGINAL });
  });

  it("stays when Save hits a conflict, so the draft and its callout stay on screen", async () => {
    const { editor, backend } = openEditor();
    editor.edit(`${ORIGINAL}x\n`);
    backend.disk = { status: "ready", content: "theirs", modifiedAt: 1500 };
    backend.nextWriteError = new TestRpcError("conflict");

    await expect(editor.requestLeave(async () => "save")).resolves.toBe(false);
    expect(editor.getSnapshot().callout).toEqual({ kind: "changed", canOverwrite: true });
  });
});

describe("KnowledgeNoteEditor.discard (Cancel)", () => {
  it("throws the draft away and shows the saved note", async () => {
    const { editor, backend } = openEditor();
    editor.edit(`${ORIGINAL}x\n`);

    await editor.discard();

    expect(backend.writes).toEqual([]);
    expect(editor.getSnapshot().file).toMatchObject({
      status: "clean",
      content: ORIGINAL,
      modified: false,
    });
  });
});
