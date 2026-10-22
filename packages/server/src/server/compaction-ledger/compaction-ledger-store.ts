import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../atomic-file.js";

/**
 * File-backed compaction episode ledger. Layout under `$PASEO_HOME/compactions/`:
 *
 *   state.json   every episode row, plus the backfill marker, one file
 *
 * It is a history, so rows are bounded on two axes (docs/insights.md): a hard row-count cap
 * (oldest `startedAtMs` evicted first) and a retention-days cutoff. A file that will not parse is
 * set aside as `state.json.corrupt-<ms>` and the store starts empty; one that exists but cannot be
 * read is never written over. Fields added after the first release are optional on read.
 */

export type CompactionStepName = "prepare" | "compact" | "restore";

export type CompactionStepOutcome = "completed" | "canceled" | "failed" | "busy" | "notCompacted";

export interface CompactionStepRecord {
  step: CompactionStepName;
  startedAtMs: number;
  endedAtMs: number | null;
  outcome: CompactionStepOutcome;
  /** Weighted tokens this step's own turn spent (docs/token-burn.md); null when unmeasured. */
  costWeightedTokens: number | null;
  /** Messages steered into this step's turn; when set, its cost is null (it was shared). */
  steeredIn?: number;
}

export type CompactionEpisodeSource = "monitor" | "native" | "manual" | "backfill";
export type CompactionEpisodeTrigger = "line" | "early" | "auto" | "manual" | "unknown";
export type CompactionEpisodeOutcome = "done" | "gaveUp" | "cancelled" | "interrupted" | "unknown";
export type CompactionCostBasis = "measured" | "unmeasured";

/** How long the quiet gate held the episode's start (docs/leader-compaction.md). */
export interface CompactionQuietGate {
  heldFromMs: number;
  heldUntilMs: number;
  heldMs: number;
}

/** A human prompt the episode carried into its restore message. */
export interface CompactionCarriedPrompt {
  atMs: number;
  text: string;
}

export interface CompactionEpisodeRow {
  id: string;
  agentId: string;
  agentTitle: string | null;
  source: CompactionEpisodeSource;
  trigger: CompactionEpisodeTrigger;
  triggerReason: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  steps: CompactionStepRecord[];
  contextBeforeTokens: number | null;
  contextAfterTokens: number | null;
  outcome: CompactionEpisodeOutcome;
  noteLength: number | null;
  /** The human prompts carried into the restore message; null when there were none. */
  promptsCarried: CompactionCarriedPrompt[] | null;
  /** Set when the quiet gate held the episode's start. */
  quietGate: CompactionQuietGate | null;
  costWeightedTokens: number | null;
  costBasis: CompactionCostBasis;
  estimatedSavedWeightedTokens: number | null;
  /** The request count the payback estimate was last computed against. */
  requestsSincePaybackCountedThrough: number | null;
}

/** The fields every freshly-built row starts with, regardless of source (monitor, native,
 * backfill) -- filled in only once more is known. */
export function emptyCompactionEpisodeTail(): Pick<
  CompactionEpisodeRow,
  | "noteLength"
  | "promptsCarried"
  | "quietGate"
  | "costWeightedTokens"
  | "estimatedSavedWeightedTokens"
  | "requestsSincePaybackCountedThrough"
> {
  return {
    noteLength: null,
    promptsCarried: null,
    quietGate: null,
    costWeightedTokens: null,
    estimatedSavedWeightedTokens: null,
    requestsSincePaybackCountedThrough: null,
  };
}

export interface CompactionLedgerLimits {
  retentionDays: number;
  maxRows: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_COMPACTION_LEDGER_LIMITS: CompactionLedgerLimits = {
  retentionDays: 90,
  maxRows: 5_000,
};

const STEP_NAME_SCHEMA = z.enum(["prepare", "compact", "restore"]);
const STEP_OUTCOME_SCHEMA = z.enum(["completed", "canceled", "failed", "busy", "notCompacted"]);
const STEP_SCHEMA = z.object({
  step: STEP_NAME_SCHEMA,
  startedAtMs: z.number(),
  endedAtMs: z.number().nullable(),
  outcome: STEP_OUTCOME_SCHEMA,
  costWeightedTokens: z.number().nullable(),
  steeredIn: z.number().optional(),
});
const ROW_SCHEMA = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  source: z.enum(["monitor", "native", "manual", "backfill"]),
  trigger: z.enum(["line", "early", "auto", "manual", "unknown"]),
  triggerReason: z.string().nullable(),
  startedAtMs: z.number(),
  endedAtMs: z.number().nullable(),
  steps: z.array(STEP_SCHEMA),
  contextBeforeTokens: z.number().nullable(),
  contextAfterTokens: z.number().nullable(),
  outcome: z.enum(["done", "gaveUp", "cancelled", "interrupted", "unknown"]),
  noteLength: z.number().nullable(),
  promptsCarried: z
    .array(z.object({ atMs: z.number(), text: z.string() }))
    .nullable()
    .optional(),
  quietGate: z
    .object({ heldFromMs: z.number(), heldUntilMs: z.number(), heldMs: z.number() })
    .nullable()
    .optional(),
  costWeightedTokens: z.number().nullable(),
  costBasis: z.enum(["measured", "unmeasured"]),
  estimatedSavedWeightedTokens: z.number().nullable(),
  requestsSincePaybackCountedThrough: z.number().nullable(),
});
const STATE_FILE_SCHEMA = z.object({
  v: z.literal(1),
  backfillDoneAtMs: z.number().nullable(),
  rows: z.array(ROW_SCHEMA),
});

interface StoreLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface CompactionLedgerStoreOptions {
  rootDir: string;
  logger: StoreLogger;
  limits?: Partial<CompactionLedgerLimits>;
  flushIntervalMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export class CompactionLedgerStore {
  private readonly rootDir: string;
  private readonly logger: StoreLogger;
  private readonly limits: CompactionLedgerLimits;
  private readonly flushIntervalMs: number;
  private loaded = false;
  /** False when the file exists but could not be read: writing would destroy what is in it. */
  private writable = true;
  private loadPromise: Promise<void> | null = null;
  private backfillDoneAtMs: number | null = null;
  private readonly rows = new Map<string, CompactionEpisodeRow>();
  private dirty = false;
  private lastFlushMs = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CompactionLedgerStoreOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.limits = { ...DEFAULT_COMPACTION_LEDGER_LIMITS, ...options.limits };
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

  getBackfillDoneAtMs(): number | null {
    return this.backfillDoneAtMs;
  }

  markBackfillDone(nowMs: number): void {
    if (this.backfillDoneAtMs !== null) return;
    this.backfillDoneAtMs = nowMs;
    this.dirty = true;
  }

  /** Inserts a new row or replaces an existing one with the same id. */
  upsertEpisode(row: CompactionEpisodeRow): void {
    if (!this.rows.has(row.id) && this.rows.size >= this.limits.maxRows) {
      this.dropOldestRow();
    }
    this.rows.set(row.id, row);
    this.dirty = true;
  }

  getEpisode(id: string): CompactionEpisodeRow | undefined {
    return this.rows.get(id);
  }

  /** Every row currently held, in no particular order; callers filter and sort. */
  listEpisodes(): CompactionEpisodeRow[] {
    return [...this.rows.values()];
  }

  /** Drops rows past retention. */
  prune(nowMs: number): void {
    const horizonMs = nowMs - this.retentionMs;
    for (const [id, row] of this.rows) {
      if (row.startedAtMs < horizonMs) {
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
      if (row.startedAtMs < oldestMs) {
        oldestMs = row.startedAtMs;
        oldestId = row.id;
      }
    }
    if (oldestId !== null) this.rows.delete(oldestId);
  }

  private async readFile(): Promise<void> {
    const state = await this.readJson();
    if (state) {
      this.backfillDoneAtMs = state.backfillDoneAtMs;
      for (const row of state.rows) {
        // A row the daemon is already building since boot is newer than its saved copy.
        if (this.rows.has(row.id)) continue;
        this.rows.set(row.id, {
          ...row,
          promptsCarried: row.promptsCarried ?? null,
          quietGate: row.quietGate ?? null,
        });
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
        JSON.stringify({
          v: 1,
          backfillDoneAtMs: this.backfillDoneAtMs,
          rows: [...this.rows.values()],
        }),
        { mode: 0o600 },
      );
    } catch (error) {
      // The state stays in memory and the dirty mark is gone; the next change writes it anew.
      this.dirty = true;
      this.logger.warn(
        { err: error, rootDir: this.rootDir },
        "Failed to persist compaction ledger",
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
        "Cannot read the compaction ledger file; leaving it alone and not saving this session",
      );
      return null;
    }
    try {
      return STATE_FILE_SCHEMA.parse(JSON.parse(text));
    } catch (error) {
      // Measured costs cannot be rebuilt from the log, so keep the bytes for a person to look at
      // before the next flush writes a fresh file.
      const asidePath = `${this.statePath()}.corrupt-${Date.now()}`;
      await fs.rename(this.statePath(), asidePath).catch(() => undefined);
      this.logger.warn(
        { err: error, rootDir: this.rootDir, asidePath },
        "Set aside an unparseable compaction ledger file",
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
