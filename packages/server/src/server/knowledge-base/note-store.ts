/**
 * The daemon's single write path for note files (KTD-2): atomic writes, a per-note promise queue so
 * two writers to the same note never interleave, and an optimistic-concurrency check against the
 * file's own mtime so an Obsidian edit racing a daemon write becomes a conflict instead of lost
 * content. Every write is scrubbed (`scrub.ts`) before it reaches disk.
 */

import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.js";
import { createInboxNote, serializeNote } from "./note-format.js";
import { scrubText } from "./scrub.js";

export class NoteConflictError extends Error {
  constructor(public readonly relativePath: string) {
    super(`Note at ${relativePath} was modified since it was read`);
    this.name = "NoteConflictError";
  }
}

export class InvalidNotePathError extends Error {
  constructor(public readonly relativePath: string) {
    super(`Note path escapes the notes directory: ${relativePath}`);
    this.name = "InvalidNotePathError";
  }
}

export interface NoteRecord {
  path: string;
  content: string;
  modifiedAt: number;
}

export interface NoteWriteResult {
  modifiedAt: number;
  removedSecretSpans: number;
}

export interface NoteWriteOptions {
  /**
   * Omit to overwrite blindly. Pass the `modifiedAt` from a prior `read` to require the file be
   * unchanged since, or `null` to require that the note does not yet exist.
   */
  expectedModifiedAt?: number | null;
}

export class NoteStore {
  private readonly notesDir: string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(notesDir: string) {
    this.notesDir = path.resolve(notesDir);
  }

  /** Relative paths (forward-slashed) of every `.md` note under the notes directory, sorted. */
  async list(): Promise<string[]> {
    const results: string[] = [];
    await this.walk(this.notesDir, results);
    return results.sort();
  }

  async read(relativePath: string): Promise<NoteRecord | null> {
    const absolute = this.resolve(relativePath);
    const stats = await statOrNull(absolute);
    if (!stats) return null;
    const content = await fs.readFile(absolute, "utf8");
    return { path: relativePath, content, modifiedAt: stats.mtimeMs };
  }

  async write(
    relativePath: string,
    content: string,
    options?: NoteWriteOptions,
  ): Promise<NoteWriteResult> {
    const absolute = this.resolve(relativePath);
    return this.enqueue(absolute, async () => {
      if (options && "expectedModifiedAt" in options) {
        const current = await statOrNull(absolute);
        const currentModifiedAt = current?.mtimeMs ?? null;
        if (currentModifiedAt !== options.expectedModifiedAt) {
          throw new NoteConflictError(relativePath);
        }
      }
      const { text, removed } = scrubText(content);
      await writeFileAtomic(absolute, text);
      const stats = await fs.stat(absolute);
      return { modifiedAt: stats.mtimeMs, removedSecretSpans: removed };
    });
  }

  async move(fromRelativePath: string, toRelativePath: string): Promise<void> {
    const from = this.resolve(fromRelativePath);
    const to = this.resolve(toRelativePath);
    await this.enqueue(from, async () => {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
    });
  }

  async delete(relativePath: string): Promise<void> {
    const absolute = this.resolve(relativePath);
    await this.enqueue(absolute, async () => {
      await fs.rm(absolute, { force: true });
    });
  }

  /** Reads `inbox.md`, creating it if absent. Safe under concurrent callers. */
  async ensureInbox(): Promise<NoteRecord> {
    const existing = await this.read("inbox.md");
    if (existing) return existing;
    const content = serializeNote(createInboxNote(new Date().toISOString()));
    try {
      await this.write("inbox.md", content, { expectedModifiedAt: null });
    } catch (error) {
      if (!(error instanceof NoteConflictError)) throw error;
    }
    const record = await this.read("inbox.md");
    if (!record) throw new Error("Inbox note disappeared immediately after being written");
    return record;
  }

  private async walk(dir: string, results: string[]): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(absolute, results);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(path.relative(this.notesDir, absolute).split(path.sep).join("/"));
      }
    }
  }

  private resolve(relativePath: string): string {
    const absolute = path.resolve(this.notesDir, relativePath);
    if (absolute !== this.notesDir && !absolute.startsWith(this.notesDir + path.sep)) {
      throw new InvalidNotePathError(relativePath);
    }
    return absolute;
  }

  /** Chains `fn` behind whatever is already queued for `key`, so same-note calls never interleave. */
  private async enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

async function statOrNull(absolute: string) {
  try {
    return await fs.stat(absolute);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
