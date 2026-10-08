import { promises as fs } from "node:fs";
import path from "node:path";
import type { TokenUsageRow } from "@getpaseo/protocol/token-usage/rpc-schemas";
import { z } from "zod";
import { weighTokenUsage } from "../agent/token-rate-tracker.js";
import { writeFileAtomic } from "../atomic-file.js";
import type { TokenUsageInternalRole } from "./token-usage-attribution.js";
import { UNKNOWN_MODEL, type TokenCounts } from "./transcript-parsers.js";

/**
 * File-backed token usage by hour, provider, model and role, plus where the transcript scan got
 * to. Layout under `$PASEO_HOME/token-usage/`:
 *
 *   state.json     hourly buckets and per-file scan state, one file
 *   sessions.json  provider session id -> Paseo agent, recorded as the daemon sees them
 *
 * Buckets and scan state share a file on purpose: a crash between two separate writes would
 * either count a stretch of transcript twice or lose it. One atomic write keeps them in step.
 *
 * It is a history, so every axis is bounded (docs/token-usage.md): buckets and file entries
 * expire after `retentionDays`, and buckets, models, files, recent ids and sessions each have a
 * hard cap. A file that will not parse is replaced; the scan then rebuilds it from transcripts.
 * Flushes are debounced to `flushIntervalMs` and forced on `close`.
 */

export type TranscriptProvider = "claude" | "codex";

/** One `[id, input, cacheWrite, cacheRead, output]` per recently counted response. */
export type RecentResponse = [string, number, number, number, number];

export interface FileScanState {
  provider: TranscriptProvider;
  /** Bytes consumed: always the end of a complete line. */
  offset: number;
  /** Size when the file was last read to its end. Equal on the next stat: nothing new. */
  size: number;
  /** The file's mtime at the last read, finished or not. Retention goes by it. */
  mtimeMs: number;
  /** Codex: the model the thread was on where the scan stopped. */
  model?: string | null;
  /** Claude: the file's first response id. A fork copies its parent's, so equal ids mean a copy. */
  firstId?: string | null;
  /** Claude: the files whose responses this file's copied prefix repeats. Cleared when it ends. */
  forkOf?: string[];
  /** The last few responses counted, so a repeat after a sweep boundary is still caught. */
  recent?: RecentResponse[];
  /** Claude: the newest response timestamp read, to recognise a response written again later. */
  newestMs?: number;
}

export interface UsageBooking extends TokenCounts {
  atMs: number;
  provider: TranscriptProvider;
  model: string;
  role: TokenUsageInternalRole;
  /** 1 for a new response, 0 for a later line of one already counted that reported more. */
  responses: number;
}

export interface SessionIndexEntry {
  sessionId: string;
  agentId: string;
  parentAgentId: string | null;
  lastSeenMs: number;
}

export interface TokenUsageLimits {
  retentionDays: number;
  maxBuckets: number;
  maxModelsPerProvider: number;
  maxFiles: number;
  maxRecentPerFile: number;
  /** A file idle longer than this keeps no recent ids: a response's lines arrive together. */
  recentKeepMs: number;
  maxSessions: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_TOKEN_USAGE_LIMITS: TokenUsageLimits = {
  // The longest range is 30 days; the extra day keeps the range's first hour whole.
  retentionDays: 31,
  maxBuckets: 100_000,
  maxModelsPerProvider: 128,
  maxFiles: 100_000,
  maxRecentPerFile: 16,
  recentKeepMs: DAY_MS,
  maxSessions: 50_000,
};

const ROLE_SCHEMA = z.enum(["leader", "worker", "outside"]);
const PROVIDER_SCHEMA = z.enum(["claude", "codex"]);
const COUNT_SCHEMA = z.number().nonnegative();
const BUCKET_SCHEMA = z.tuple([
  z.number(),
  PROVIDER_SCHEMA,
  z.string(),
  ROLE_SCHEMA,
  COUNT_SCHEMA,
  COUNT_SCHEMA,
  COUNT_SCHEMA,
  COUNT_SCHEMA,
  COUNT_SCHEMA,
]);
const FILE_SCHEMA = z.object({
  path: z.string(),
  provider: PROVIDER_SCHEMA,
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  model: z.string().nullable().optional(),
  firstId: z.string().nullable().optional(),
  forkOf: z.array(z.string()).optional(),
  recent: z
    .array(z.tuple([z.string(), COUNT_SCHEMA, COUNT_SCHEMA, COUNT_SCHEMA, COUNT_SCHEMA]))
    .optional(),
  newestMs: z.number().optional(),
});
const STATE_FILE_SCHEMA = z.object({
  v: z.literal(1),
  recordingSinceMs: z.number().nullable(),
  backfillDoneAtMs: z.number().nullable(),
  buckets: z.array(BUCKET_SCHEMA),
  files: z.array(FILE_SCHEMA),
});
const SESSIONS_FILE_SCHEMA = z.object({
  v: z.literal(1),
  sessions: z.array(z.tuple([z.string(), z.string(), z.string().nullable(), z.number()])),
});

type BucketTuple = z.infer<typeof BUCKET_SCHEMA>;

interface StoreLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface TokenUsageStoreOptions {
  rootDir: string;
  logger: StoreLogger;
  limits?: Partial<TokenUsageLimits>;
  flushIntervalMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5 * MINUTE_MS;

export class TokenUsageStore {
  private readonly rootDir: string;
  private readonly logger: StoreLogger;
  private readonly limits: TokenUsageLimits;
  private readonly flushIntervalMs: number;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private recordingSinceMs: number | null = null;
  private backfillDoneAtMs: number | null = null;
  private readonly buckets = new Map<string, BucketTuple>();
  private readonly modelsByProvider = new Map<TranscriptProvider, Set<string>>();
  private readonly files = new Map<string, FileScanState>();
  private readonly sessions = new Map<string, SessionIndexEntry>();
  private stateDirty = false;
  private sessionsDirty = false;
  private lastFlushMs = 0;
  private filesCapWarned = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TokenUsageStoreOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.limits = { ...DEFAULT_TOKEN_USAGE_LIMITS, ...options.limits };
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  get retentionMs(): number {
    return this.limits.retentionDays * DAY_MS;
  }

  /** Reads both files once. Safe to call repeatedly and concurrently. */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loadPromise ??= this.readFiles();
    return this.loadPromise;
  }

  getRecordingSinceMs(): number | null {
    return this.recordingSinceMs;
  }

  markRecordingSince(nowMs: number): void {
    if (this.recordingSinceMs !== null) return;
    this.recordingSinceMs = nowMs;
    this.stateDirty = true;
  }

  getBackfillDoneAtMs(): number | null {
    return this.backfillDoneAtMs;
  }

  markBackfillDone(nowMs: number): void {
    if (this.backfillDoneAtMs !== null) return;
    this.backfillDoneAtMs = nowMs;
    this.stateDirty = true;
  }

  /** Adds one response (or the growth of one already counted) to its hour. */
  add(booking: UsageBooking): void {
    const hourMs = Math.floor(booking.atMs / HOUR_MS) * HOUR_MS;
    const model = this.admitModel(booking.provider, booking.model);
    const key = bucketKey(hourMs, booking.provider, model, booking.role);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.limits.maxBuckets) this.dropOldestBuckets();
      bucket = [hourMs, booking.provider, model, booking.role, 0, 0, 0, 0, 0];
      this.buckets.set(key, bucket);
    }
    bucket[4] += booking.input;
    bucket[5] += booking.cacheWrite;
    bucket[6] += booking.cacheRead;
    bucket[7] += booking.output;
    bucket[8] += booking.responses;
    this.stateDirty = true;
  }

  /** One row per provider x model x role with any usage from `startMs` on, heaviest first. */
  query(startMs: number): TokenUsageRow[] {
    const rows = new Map<string, TokenUsageRow>();
    for (const bucket of this.buckets.values()) {
      const [hourMs, provider, model, role, input, cacheWrite, cacheRead, output, responses] =
        bucket;
      if (hourMs < startMs) continue;
      const key = `${provider}\u0000${model}\u0000${role}`;
      const row = rows.get(key) ?? {
        provider,
        model,
        role,
        input: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        weighted: 0,
        responses: 0,
      };
      row.input += input;
      row.cacheWrite += cacheWrite;
      row.cacheRead += cacheRead;
      row.output += output;
      row.responses += responses;
      rows.set(key, row);
    }
    const result: TokenUsageRow[] = [];
    for (const row of rows.values()) {
      row.weighted = weighTokenUsage({
        inputTokens: row.input,
        cacheCreationInputTokens: row.cacheWrite,
        cacheReadInputTokens: row.cacheRead,
        outputTokens: row.output,
      });
      if (row.responses > 0 || row.weighted > 0) result.push(row);
    }
    return result.sort((a, b) => b.weighted - a.weighted || a.model.localeCompare(b.model));
  }

  getFile(filePath: string): FileScanState | undefined {
    return this.files.get(filePath);
  }

  setFile(filePath: string, state: FileScanState): void {
    if (!this.files.has(filePath) && this.files.size >= this.limits.maxFiles) {
      // Refuse the new file rather than evicting an existing entry (the parallel policy to
      // `admitModel`'s unknown-model fallback): `prune()` already clears entries past retention,
      // so every tracked file here is still in-window and possibly still being appended to. An
      // evicted file looks unseen to `scanFile`, which re-reads it from byte 0 and double-books
      // every response it already counted, with no ledger to undo that.
      if (!this.filesCapWarned) {
        this.logger.warn(
          { maxFiles: this.limits.maxFiles },
          "Token usage file cap reached; new transcripts are not tracked until older ones age out",
        );
        this.filesCapWarned = true;
      }
      return;
    }
    this.files.set(filePath, state);
    this.stateDirty = true;
  }

  deleteFile(filePath: string): void {
    if (this.files.delete(filePath)) this.stateDirty = true;
  }

  listFiles(): Array<[string, FileScanState]> {
    return [...this.files.entries()];
  }

  get recentLimit(): number {
    return this.limits.maxRecentPerFile;
  }

  recordSession(entry: SessionIndexEntry): void {
    const existing = this.sessions.get(entry.sessionId);
    if (
      existing &&
      existing.agentId === entry.agentId &&
      existing.parentAgentId === entry.parentAgentId &&
      entry.lastSeenMs - existing.lastSeenMs < HOUR_MS
    ) {
      return;
    }
    if (!existing && this.sessions.size >= this.limits.maxSessions) this.dropOldestSession();
    this.sessions.set(entry.sessionId, entry);
    this.sessionsDirty = true;
  }

  listSessions(): SessionIndexEntry[] {
    return [...this.sessions.values()];
  }

  /** Drops buckets, file entries and sessions past retention, and stale recent ids. */
  prune(nowMs: number): void {
    const horizonMs = nowMs - this.retentionMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket[0] < horizonMs) {
        this.buckets.delete(key);
        this.stateDirty = true;
      }
    }
    this.rebuildModelIndex();
    for (const [filePath, file] of this.files) {
      if (file.mtimeMs < horizonMs) {
        this.files.delete(filePath);
        this.stateDirty = true;
      } else if (file.recent && nowMs - file.mtimeMs > this.limits.recentKeepMs) {
        delete file.recent;
        this.stateDirty = true;
      }
    }
    for (const [sessionId, entry] of this.sessions) {
      if (entry.lastSeenMs < horizonMs) {
        this.sessions.delete(sessionId);
        this.sessionsDirty = true;
      }
    }
  }

  /** Flushes when the interval has passed since the last flush. */
  async maybeFlush(nowMs: number): Promise<void> {
    if (nowMs - this.lastFlushMs >= this.flushIntervalMs) await this.flush(nowMs);
  }

  /** Persists whatever is dirty. Safe at any time; concurrent calls run in order. */
  flush(nowMs: number = Date.now()): Promise<void> {
    this.lastFlushMs = nowMs;
    const run = this.writeChain.then(() => this.writeDirty());
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (!this.loaded) return;
    await this.flush();
  }

  private admitModel(provider: TranscriptProvider, model: string): string {
    let models = this.modelsByProvider.get(provider);
    if (!models) {
      models = new Set();
      this.modelsByProvider.set(provider, models);
    }
    if (models.has(model)) return model;
    // A flood of distinct model strings must not grow the file without bound.
    if (models.size >= this.limits.maxModelsPerProvider) return UNKNOWN_MODEL;
    models.add(model);
    return model;
  }

  private rebuildModelIndex(): void {
    this.modelsByProvider.clear();
    for (const bucket of this.buckets.values()) {
      const models = this.modelsByProvider.get(bucket[1]) ?? new Set<string>();
      models.add(bucket[2]);
      this.modelsByProvider.set(bucket[1], models);
    }
  }

  private dropOldestBuckets(): void {
    let oldest = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets.values()) oldest = Math.min(oldest, bucket[0]);
    for (const [key, bucket] of this.buckets) {
      if (bucket[0] === oldest) this.buckets.delete(key);
    }
  }

  private dropOldestSession(): void {
    let oldestId: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const entry of this.sessions.values()) {
      if (entry.lastSeenMs < oldestMs) {
        oldestMs = entry.lastSeenMs;
        oldestId = entry.sessionId;
      }
    }
    if (oldestId !== null) this.sessions.delete(oldestId);
  }

  private async readFiles(): Promise<void> {
    const state = await this.readJson(this.statePath(), STATE_FILE_SCHEMA);
    if (state) {
      this.recordingSinceMs = state.recordingSinceMs;
      this.backfillDoneAtMs = state.backfillDoneAtMs;
      for (const bucket of state.buckets) {
        this.buckets.set(bucketKey(bucket[0], bucket[1], bucket[2], bucket[3]), bucket);
      }
      for (const { path: filePath, ...file } of state.files) {
        this.files.set(filePath, file);
      }
      this.rebuildModelIndex();
    }
    const sessions = await this.readJson(this.sessionsPath(), SESSIONS_FILE_SCHEMA);
    for (const [sessionId, agentId, parentAgentId, lastSeenMs] of sessions?.sessions ?? []) {
      // A session recorded before the load finished is newer than what was on disk.
      if (this.sessions.has(sessionId)) continue;
      this.sessions.set(sessionId, { sessionId, agentId, parentAgentId, lastSeenMs });
    }
    this.loaded = true;
  }

  private async writeDirty(): Promise<void> {
    try {
      if (this.stateDirty) {
        this.stateDirty = false;
        await writeFileAtomic(
          this.statePath(),
          JSON.stringify({
            v: 1,
            recordingSinceMs: this.recordingSinceMs,
            backfillDoneAtMs: this.backfillDoneAtMs,
            buckets: [...this.buckets.values()],
            files: this.serializeFiles(),
          }),
        );
      }
      if (this.sessionsDirty) {
        this.sessionsDirty = false;
        await writeFileAtomic(
          this.sessionsPath(),
          JSON.stringify({
            v: 1,
            sessions: [...this.sessions.values()].map((entry) => [
              entry.sessionId,
              entry.agentId,
              entry.parentAgentId,
              entry.lastSeenMs,
            ]),
          }),
        );
      }
    } catch (error) {
      // The state stays in memory and dirty marks are gone; the next change writes it anew.
      this.stateDirty = true;
      this.sessionsDirty = true;
      this.logger.warn({ err: error, rootDir: this.rootDir }, "Failed to persist token usage");
    }
  }

  private serializeFiles(): Array<FileScanState & { path: string }> {
    const files: Array<FileScanState & { path: string }> = [];
    for (const [filePath, file] of this.files) files.push(Object.assign({ path: filePath }, file));
    return files;
  }

  private async readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch (error) {
      // Rebuildable from the transcripts: a file that will not parse starts over and the next
      // flush replaces it.
      this.logger.warn({ err: error, filePath }, "Ignoring unreadable token usage file");
      return null;
    }
  }

  private statePath(): string {
    return path.join(this.rootDir, "state.json");
  }

  private sessionsPath(): string {
    return path.join(this.rootDir, "sessions.json");
  }
}

function bucketKey(
  hourMs: number,
  provider: TranscriptProvider,
  model: string,
  role: TokenUsageInternalRole,
): string {
  return `${hourMs}\u0000${provider}\u0000${model}\u0000${role}`;
}
