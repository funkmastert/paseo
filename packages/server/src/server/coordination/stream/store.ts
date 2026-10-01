import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  StreamEntrySchema,
  type StreamEntry,
  type StreamEntryPage,
  type StreamListFilter,
  type StreamUrgency,
} from "@getpaseo/protocol/coordination/stream-schemas";
import { writeFileAtomic } from "../../atomic-file.js";
import { readJsonlFile } from "../jsonl.js";

// OR-A2: the fleet event log. entries.jsonl holds `entry` lines and `archive` markers, so an
// append and a soft archive are each one line. Compaction rewrites the file with the retained
// entries and their archive stamps folded in. See docs/work-queue.md#stream.

const StreamLineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("header"), nextSeq: z.number().int().positive() }),
  z.object({ kind: z.literal("entry"), entry: StreamEntrySchema }),
  z.object({ kind: z.literal("archive"), id: z.string(), at: z.string() }),
]);
type StreamLine = z.infer<typeof StreamLineSchema>;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export interface StreamRetention {
  maxEntries: number;
  maxAgeMs: number;
}

export interface AppendStreamEntryInput {
  id: string;
  type: string;
  source: string;
  summary: string;
  urgency?: StreamUrgency;
  tags?: string[];
  subject?: string;
  data?: Record<string, unknown>;
}

export interface StreamStoreOptions {
  // `$PASEO_HOME/coordination/stream`.
  rootDir: string;
  retention: StreamRetention;
  logger: Logger;
}

export class StreamStore {
  private readonly filePath: string;
  private entries: StreamEntry[] = [];
  private nextSeq = 1;
  private fileLines = 0;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: StreamStoreOptions) {
    this.filePath = path.join(options.rootDir, "entries.jsonl");
  }

  static async open(options: StreamStoreOptions): Promise<StreamStore> {
    const store = new StreamStore(options);
    await store.load();
    return store;
  }

  // Idempotent on `id`: a repeat returns the entry already logged.
  append(input: AppendStreamEntryInput, at: string): Promise<StreamEntry> {
    return this.serialize(async () => {
      const existing = this.entries.find((entry) => entry.id === input.id);
      if (existing) return existing;
      const entry = StreamEntrySchema.parse({ ...input, seq: this.nextSeq, at });
      await this.appendLine({ kind: "entry", entry });
      this.nextSeq += 1;
      this.entries.push(entry);
      // Bounded without a timer: once the file holds twice the cap, rewrite it.
      if (this.fileLines >= this.options.retention.maxEntries * 2) await this.compactNow(at);
      return entry;
    });
  }

  // Soft archive: the entry stays in the log, hidden from default reads. Returns null when the
  // entry is unknown (never logged, or already past retention).
  archive(id: string, at: string): Promise<StreamEntry | null> {
    return this.serialize(async () => {
      const index = this.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const current = this.entries[index];
      if (current.archivedAt) return current;
      await this.appendLine({ kind: "archive", id, at });
      const archived = { ...current, archivedAt: at };
      this.entries[index] = archived;
      return archived;
    });
  }

  list(filter: StreamListFilter): Promise<StreamEntryPage> {
    return this.serialize(async () => {
      const limit = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
      const before = filter.cursor ? decodeCursor(filter.cursor) : Number.POSITIVE_INFINITY;
      const matches: StreamEntry[] = [];
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const entry = this.entries[i];
        if (entry.seq >= before) continue;
        if (!filter.includeArchived && entry.archivedAt) continue;
        if (filter.types && !filter.types.includes(entry.type)) continue;
        if (filter.subject && entry.subject !== filter.subject) continue;
        if (filter.tags && !filter.tags.some((tag) => entry.tags?.includes(tag))) continue;
        matches.push(entry);
        if (matches.length > limit) break;
      }
      const page = matches.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page,
        nextCursor: matches.length > limit && last ? String(last.seq) : undefined,
      };
    });
  }

  // Drops entries older than `maxAgeMs`, then the oldest beyond `maxEntries`. The stream is a
  // feed, not a record of work; the queue journal and its archive are the record.
  compact(now: string): Promise<void> {
    return this.serialize(() => this.compactNow(now));
  }

  private async compactNow(now: string): Promise<void> {
    const cutoff = Date.parse(now) - this.options.retention.maxAgeMs;
    const fresh = this.entries.filter((entry) => Date.parse(entry.at) >= cutoff);
    const kept = fresh.slice(Math.max(0, fresh.length - this.options.retention.maxEntries));
    const lines: StreamLine[] = [
      { kind: "header", nextSeq: this.nextSeq },
      ...kept.map((entry) => ({ kind: "entry" as const, entry })),
    ];
    await writeFileAtomic(
      this.filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    this.entries = kept;
    this.fileLines = lines.length;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async appendLine(line: StreamLine): Promise<void> {
    await fs.mkdir(this.options.rootDir, { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(line)}\n`);
    this.fileLines += 1;
  }

  private async load(): Promise<void> {
    const lines = await readJsonlFile(
      this.filePath,
      (value) => {
        const result = StreamLineSchema.safeParse(value);
        return result.success ? result.data : null;
      },
      this.options.logger,
    );
    const byId = new Map<string, StreamEntry>();
    for (const line of lines) {
      if (line.kind === "header") {
        this.nextSeq = Math.max(this.nextSeq, line.nextSeq);
      } else if (line.kind === "entry") {
        byId.set(line.entry.id, line.entry);
        this.nextSeq = Math.max(this.nextSeq, line.entry.seq + 1);
      } else {
        const entry = byId.get(line.id);
        if (entry && !entry.archivedAt) byId.set(line.id, { ...entry, archivedAt: line.at });
      }
    }
    this.entries = [...byId.values()].sort((a, b) => a.seq - b.seq);
    this.fileLines = lines.length;
  }
}

function decodeCursor(cursor: string): number {
  const seq = Number(cursor);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(
      "That cursor is not one this stream returned. Pass the nextCursor from the previous page.",
    );
  }
  return seq;
}
