import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic-file.js";

/**
 * File-backed PR-creation ledger. Layout under `$PASEO_HOME/pull-requests/`:
 *
 *   state.json   every detected PR row, one file
 *
 * It is a history, so rows are bounded on two axes (docs/pull-request-ledger.md): a hard
 * row-count cap (oldest `detectedAtMs` evicted first) and a retention-days cutoff. A file that
 * will not parse is set aside as `state.json.corrupt-<ms>` and the store starts empty; one that
 * exists but cannot be read is never written over. Fields added after the first release are
 * optional on read.
 *
 * Rows are keyed by forge identity (`host/repoOwner/repoName#number`), not by agent+time: the
 * same PR detected twice (a retry, or a later status transition) upserts the same row rather
 * than duplicating it.
 */

export type PullRequestLedgerStatus = "open" | "merged" | "closed";

export interface PullRequestLedgerRow {
  id: string;
  agentId: string;
  agentTitle: string | null;
  host: string;
  repoOwner: string;
  repoName: string;
  number: number;
  url: string;
  forge: string;
  detectedAtMs: number;
  status: PullRequestLedgerStatus;
  lastStatusCheckedAtMs: number | null;
}

export function buildPullRequestLedgerRowId(identity: {
  host: string;
  repoOwner: string;
  repoName: string;
  number: number;
}): string {
  return `${identity.host}/${identity.repoOwner}/${identity.repoName}#${identity.number}`;
}

export interface PullRequestLedgerLimits {
  retentionDays: number;
  maxRows: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PULL_REQUEST_LEDGER_LIMITS: PullRequestLedgerLimits = {
  retentionDays: 180,
  maxRows: 2_000,
};

const ROW_SCHEMA = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  host: z.string(),
  repoOwner: z.string(),
  repoName: z.string(),
  number: z.number(),
  url: z.string(),
  forge: z.string(),
  detectedAtMs: z.number(),
  status: z.enum(["open", "merged", "closed"]),
  lastStatusCheckedAtMs: z.number().nullable().optional(),
});
const STATE_FILE_SCHEMA = z.object({
  v: z.literal(1),
  rows: z.array(ROW_SCHEMA),
});

interface StoreLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface PullRequestLedgerStoreOptions {
  rootDir: string;
  logger: StoreLogger;
  limits?: Partial<PullRequestLedgerLimits>;
  flushIntervalMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export class PullRequestLedgerStore {
  private readonly rootDir: string;
  private readonly logger: StoreLogger;
  private readonly limits: PullRequestLedgerLimits;
  private readonly flushIntervalMs: number;
  private loaded = false;
  /** False when the file exists but could not be read: writing would destroy what is in it. */
  private writable = true;
  private loadPromise: Promise<void> | null = null;
  private readonly rows = new Map<string, PullRequestLedgerRow>();
  private dirty = false;
  private lastFlushMs = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: PullRequestLedgerStoreOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.limits = { ...DEFAULT_PULL_REQUEST_LEDGER_LIMITS, ...options.limits };
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  get retentionMs(): number {
    return this.limits.retentionDays * DAY_MS;
  }

  /** Reads the state file once. Safe to call repeatedly and concurrently. */
  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loadPromise ??= this.readFile();
    return this.loadPromise;
  }

  /** Inserts a new row or replaces an existing one with the same identity. */
  upsertRow(row: PullRequestLedgerRow): void {
    if (!this.rows.has(row.id) && this.rows.size >= this.limits.maxRows) {
      this.dropOldestRow();
    }
    this.rows.set(row.id, row);
    this.dirty = true;
  }

  getRow(id: string): PullRequestLedgerRow | undefined {
    return this.rows.get(id);
  }

  /** Every row currently held, in no particular order; callers filter and sort. */
  listRows(): PullRequestLedgerRow[] {
    return [...this.rows.values()];
  }

  /** Drops rows past retention. */
  prune(nowMs: number): void {
    const horizonMs = nowMs - this.retentionMs;
    for (const [id, row] of this.rows) {
      if (row.detectedAtMs < horizonMs) {
        this.rows.delete(id);
        this.dirty = true;
      }
    }
  }

  /** Flushes when the interval has passed since the last flush. */
  async maybeFlush(nowMs: number): Promise<void> {
    if (nowMs - this.lastFlushMs >= this.flushIntervalMs) await this.flush(nowMs);
  }

  /** Persists when dirty. Safe at any time; concurrent calls run in order. */
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

  private dropOldestRow(): void {
    let oldestId: string | null = null;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const row of this.rows.values()) {
      if (row.detectedAtMs < oldestMs) {
        oldestMs = row.detectedAtMs;
        oldestId = row.id;
      }
    }
    if (oldestId !== null) this.rows.delete(oldestId);
  }

  private async readFile(): Promise<void> {
    const state = await this.readJson();
    if (state) {
      for (const row of state.rows) {
        // A row the daemon is already building since boot is newer than its saved copy.
        if (this.rows.has(row.id)) continue;
        this.rows.set(row.id, { ...row, lastStatusCheckedAtMs: row.lastStatusCheckedAtMs ?? null });
      }
    }
    this.loaded = true;
  }

  private async writeDirty(): Promise<void> {
    // Before the load, the rows in memory are only what arrived since boot: writing them would
    // drop every saved row.
    if (!this.dirty || !this.loaded || !this.writable) return;
    try {
      this.dirty = false;
      await writeFileAtomic(
        this.statePath(),
        JSON.stringify({ v: 1, rows: [...this.rows.values()] }),
        {
          mode: 0o600,
        },
      );
    } catch (error) {
      // The state stays in memory and the dirty mark is gone; the next change writes it anew.
      this.dirty = true;
      this.logger.warn(
        { err: error, rootDir: this.rootDir },
        "Failed to persist pull request ledger",
      );
    }
  }

  private async readJson(): Promise<z.infer<typeof STATE_FILE_SCHEMA> | null> {
    let text: string;
    try {
      text = await fs.readFile(this.statePath(), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      this.writable = false;
      this.logger.warn(
        { err: error, rootDir: this.rootDir },
        "Cannot read the pull request ledger file; leaving it alone and not saving this session",
      );
      return null;
    }
    try {
      return STATE_FILE_SCHEMA.parse(JSON.parse(text));
    } catch (error) {
      const asidePath = `${this.statePath()}.corrupt-${Date.now()}`;
      await fs.rename(this.statePath(), asidePath).catch(() => undefined);
      this.logger.warn(
        { err: error, rootDir: this.rootDir, asidePath },
        "Set aside an unparseable pull request ledger file",
      );
      return null;
    }
  }

  private statePath(): string {
    return path.join(this.rootDir, "state.json");
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
