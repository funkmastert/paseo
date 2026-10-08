import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import {
  FileEditorModel,
  getFileConflictCallout,
  type FileConflictCallout,
  type FileEditorFile,
  type FileEditorObservation,
  type FileEditorSnapshot,
  type FileObservationSource,
} from "@/file-pane/editor/model";
import { isKnowledgeBaseError, knowledgeBaseErrorMessage } from "./rpc-error";

/** File versions carry a workspace cwd; a note has none, so every note shares this one. */
const KNOWLEDGE_BASE_CWD = "knowledge-base";

export interface KnowledgeNote {
  path: string;
  content: string;
  modifiedAt: number;
}

export type KnowledgeNoteRead =
  | { status: "ready"; content: string; modifiedAt: number }
  | { status: "missing" };

export interface KnowledgeNoteWriteInput {
  path: string;
  content: string;
  /** Omitted only by Overwrite, which writes the draft over whatever is on disk. */
  expectedModifiedAt?: number;
}

export interface KnowledgeNoteWritten {
  /** The text as written, after the daemon's secret scrub (KTD-10). */
  content: string;
  modifiedAt: number;
  removedSecretSpans: number;
}

export interface KnowledgeNoteEditorBackend {
  /** Throws the `kb.note.write` rpc error; code `conflict` means the note changed since. */
  write(input: KnowledgeNoteWriteInput): Promise<KnowledgeNoteWritten>;
  read(path: string): Promise<KnowledgeNoteRead>;
}

export interface KnowledgeNoteEditorSnapshot {
  file: FileEditorSnapshot;
  callout: FileConflictCallout | null;
  /** How many secret-shaped spans the daemon removed on the last save; null before one. */
  removedSecretSpans: number | null;
}

export type KnowledgeNoteLeaveDecision = "save" | "discard";

/**
 * The note editor (KTD-11): the file pane's `FileEditorModel` with autosave off, writing through
 * `kb.note.write`. Tyler saves explicitly; a save adopts the scrubbed text the daemon returns as
 * the saved state; a `conflict` keeps the draft and offers Reload and Overwrite; a note deleted
 * under the editor shows the model's `deleted` callout. Polls of the open note arrive through
 * `receiveRead`.
 */
export class KnowledgeNoteEditor {
  readonly model: FileEditorModel;
  private readonly path: string;
  private readonly backend: KnowledgeNoteEditorBackend;
  private readonly listeners = new Set<() => void>();
  private readonly observationListeners = new Set<() => void>();
  private readonly unsubscribeModel: () => void;
  private observation: FileEditorObservation | null = null;
  private latestModifiedAt: number;
  private overwriting = false;
  private written: KnowledgeNoteWritten | null = null;
  private removedSecretSpans: number | null = null;
  private refreshing: Promise<void> | null = null;
  private snapshot: KnowledgeNoteEditorSnapshot;

  constructor(input: { note: KnowledgeNote; backend: KnowledgeNoteEditorBackend }) {
    this.path = input.note.path;
    this.backend = input.backend;
    this.latestModifiedAt = input.note.modifiedAt;
    this.model = new FileEditorModel({
      file: editorFile(this.path, input.note.content, input.note.modifiedAt),
      session: { write: (request) => this.write(request) },
      autosave: false,
    });
    this.model.connectFileObservations(this.observationSource());
    // Adopt on settle rather than after `save()` returns: the web editor's Mod-S calls the
    // model's own save, and its write must land the same way as the Save button's.
    this.unsubscribeModel = this.model.subscribe(() => {
      if (this.written && this.model.getSnapshot().status !== "saving") this.adoptWritten();
      else this.publish();
    });
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): KnowledgeNoteEditorSnapshot => this.snapshot;

  edit(content: string): void {
    this.model.edit(content);
  }

  async save(): Promise<void> {
    await this.model.save();
  }

  async overwrite(): Promise<void> {
    this.overwriting = true;
    try {
      await this.model.overwrite();
    } finally {
      this.overwriting = false;
    }
  }

  /** Conflict's Reload: fetch the note now and replace the draft with it. */
  async reload(): Promise<void> {
    this.receiveRead(await this.backend.read(this.path));
    await this.model.reload();
  }

  /** Cancel: drop the draft and show the last note this editor knows about. */
  async discard(): Promise<void> {
    await this.model.reload();
    await this.refreshing;
  }

  /**
   * Leaving a note (another note, a wiki link, back): a dirty draft asks Save or Discard.
   * Resolves false when the save did not land, so the caller stays and the callout shows.
   */
  async requestLeave(ask: () => Promise<KnowledgeNoteLeaveDecision>): Promise<boolean> {
    if (!this.model.getSnapshot().modified) return true;
    const decision = await ask();
    if (decision === "discard") {
      await this.discard();
      return true;
    }
    await this.save();
    return !this.model.getSnapshot().modified;
  }

  /** A poll of the open note. Older than what the editor already holds means it is stale. */
  receiveRead(read: KnowledgeNoteRead): void {
    if (read.status === "ready") {
      if (read.modifiedAt < this.latestModifiedAt) return;
      this.latestModifiedAt = read.modifiedAt;
    }
    this.observation = editorObservation(this.path, read);
    for (const listener of this.observationListeners) listener();
  }

  dispose(): void {
    this.unsubscribeModel();
    this.model.dispose();
    this.listeners.clear();
    this.observationListeners.clear();
  }

  private async write(request: {
    content: string;
    expectedModifiedAt: string;
  }): Promise<FileWriteResult> {
    const input: KnowledgeNoteWriteInput = this.overwriting
      ? { path: this.path, content: request.content }
      : {
          path: this.path,
          content: request.content,
          expectedModifiedAt: Number(request.expectedModifiedAt),
        };
    try {
      const written = await this.backend.write(input);
      this.written = written;
      return {
        status: "written",
        modifiedAt: String(written.modifiedAt),
        size: written.content.length,
      };
    } catch (error) {
      if (!isKnowledgeBaseError(error, "conflict")) {
        return { status: "error", error: knowledgeBaseErrorMessage(error) };
      }
      const read = await this.backend.read(this.path);
      if (read.status === "ready")
        this.latestModifiedAt = Math.max(this.latestModifiedAt, read.modifiedAt);
      return {
        status: "conflict",
        version: observationVersion(editorObservation(this.path, read)),
      };
    }
  }

  /** The model settles on the draft it sent; the daemon's scrubbed text replaces it here. */
  private adoptWritten(): void {
    const written = this.written;
    if (!written) return;
    this.written = null;
    this.removedSecretSpans = written.removedSecretSpans;
    this.receiveRead({ status: "ready", content: written.content, modifiedAt: written.modifiedAt });
    this.publish();
  }

  private observationSource(): FileObservationSource {
    return {
      subscribe: (listener) => {
        this.observationListeners.add(listener);
        return () => this.observationListeners.delete(listener);
      },
      getObservation: () => this.observation,
      refresh: () => {
        this.refreshing = this.refresh();
      },
    };
  }

  private async refresh(): Promise<void> {
    try {
      this.receiveRead(await this.backend.read(this.path));
    } catch {
      // The open note's next poll delivers it; the draft and its callout stay meanwhile.
    } finally {
      this.refreshing = null;
    }
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): KnowledgeNoteEditorSnapshot {
    const file = this.model.getSnapshot();
    return {
      file,
      callout: getFileConflictCallout(file),
      removedSecretSpans: this.removedSecretSpans,
    };
  }
}

function editorFile(path: string, content: string, modifiedAt: number): FileEditorFile {
  return {
    content,
    hasBom: false,
    version: {
      status: "ready",
      cwd: KNOWLEDGE_BASE_CWD,
      path,
      size: content.length,
      modifiedAt: String(modifiedAt),
    },
  };
}

function editorObservation(path: string, read: KnowledgeNoteRead): FileEditorObservation {
  if (read.status === "missing") return { status: "missing", cwd: KNOWLEDGE_BASE_CWD, path };
  return { status: "ready", file: editorFile(path, read.content, read.modifiedAt) };
}

function observationVersion(observation: FileEditorObservation): FileVersion {
  return observation.status === "ready" ? observation.file.version : observation;
}
