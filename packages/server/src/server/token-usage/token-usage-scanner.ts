import { createReadStream, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { TokenUsageRole } from "@getpaseo/protocol/token-usage/rpc-schemas";
import { resolveRole } from "./token-usage-attribution.js";
import type {
  FileScanState,
  TokenUsageStore,
  TranscriptProvider,
  UsageBooking,
} from "./token-usage-store.js";
import {
  createCodexParseState,
  parseClaudeTranscriptLine,
  parseCodexTranscriptLine,
  type CodexParseState,
  type TokenCounts,
} from "./transcript-parsers.js";

/**
 * Tails the Claude and Codex transcript trees into the store (docs/token-usage.md). Each sweep
 * stats every transcript touched in the window, reads only bytes appended since the last sweep
 * up to the last complete line, dedupes responses, books each under its session's role, and
 * stops when its time budget is spent; the next sweep resumes at the stored offset. The first
 * sweeps are therefore the 30-day backfill, spread out so the event loop never wedges.
 */

export interface TranscriptRoot {
  provider: TranscriptProvider;
  dir: string;
}

export interface TokenUsageSweepResult {
  /** Transcripts touched within the window. */
  filesTotal: number;
  /** Of those, read to their end. */
  filesDone: number;
  /** False when the time budget ran out before every file was read. */
  complete: boolean;
  /** Responses newly counted this sweep. */
  responses: number;
  /** Milliseconds spent walking the trees, then reading. */
  walkMs: number;
  scanMs: number;
  /** The longest stretch the scan held the event loop between yields. */
  longestBlockMs: number;
}

interface ScannerLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface TokenUsageScannerOptions {
  store: TokenUsageStore;
  roots: readonly TranscriptRoot[];
  logger: ScannerLogger;
  now?: () => number;
  /** Reading stops after this much work in one sweep. */
  budgetMs?: number;
  /** Lines between yields to the event loop. */
  yieldEveryLines?: number;
  /** Transcripts last modified longer ago than this are not read. */
  windowDays?: number;
  /** How long a session no agent claims stays unread after its transcript starts. */
  graceMs?: number;
}

interface DiscoveredFile {
  path: string;
  provider: TranscriptProvider;
  size: number;
  mtimeMs: number;
  /** When the transcript started: birth time where the platform has one, else mtime. */
  startedMs: number;
  /** Claude: the session the path names. A subagent file lives under its session's folder. */
  sessionHint: string | null;
}

type ScanOutcome = "done" | "deferred" | "budget";
type LineOutcome = "ok" | "defer";

interface SweepContext {
  roles: ReadonlyMap<string, TokenUsageRole>;
  nowMs: number;
  horizonMs: number;
  deadline: number;
  firstIds: Map<string, Set<string>>;
  responses: number;
  lastYield: number;
  longestBlockMs: number;
}

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_BUDGET_MS = 1_500;
const DEFAULT_YIELD_EVERY_LINES = 250;
const DEFAULT_WINDOW_DAYS = 30;
const READ_CHUNK_BYTES = 256 * 1024;
/** A longer line is skipped unread rather than buffered: no usage line comes near this. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;
/** Reading a fork's parents for their response ids stops here. */
const MAX_FORK_PARENT_BYTES = 256 * 1024 * 1024;
/** How far behind the file's newest response a response may be before it is a replayed copy. */
const REPLAY_SLACK_MS = 5 * 60_000;
/** Directories in a Claude project folder that never hold transcripts. */
const SKIPPED_DIRS = new Set(["tool-results", "memory"]);
const MAX_WALK_DEPTH = 6;
const STAT_CONCURRENCY = 4;

const CLAUDE_PREFILTER = Buffer.from('"usage"');
const CODEX_PREFILTERS = [
  Buffer.from('"token_usage_record"'),
  Buffer.from('"turn_context"'),
  Buffer.from('"thread_settings_applied"'),
];

export class TokenUsageScanner {
  private readonly store: TokenUsageStore;
  private readonly roots: readonly TranscriptRoot[];
  private readonly logger: ScannerLogger;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly yieldEveryLines: number;
  private readonly windowMs: number;
  private readonly graceMs: number | undefined;
  /** Roots whose last listing failed, so the failure is logged once rather than every sweep. */
  private readonly unlistableRoots = new Set<string>();
  /** Response ids of each fork's parents, held while the fork's copied prefix is being read. */
  private readonly forkParentIds = new Map<string, Set<string>>();

  constructor(options: TokenUsageScannerOptions) {
    this.store = options.store;
    this.roots = options.roots;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    this.yieldEveryLines = options.yieldEveryLines ?? DEFAULT_YIELD_EVERY_LINES;
    this.windowMs = (options.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
    this.graceMs = options.graceMs;
  }

  async sweep(input: {
    roles: ReadonlyMap<string, TokenUsageRole>;
  }): Promise<TokenUsageSweepResult> {
    await this.store.load();
    const walkStart = performance.now();
    const nowMs = this.now();
    const files = await this.discover(nowMs);
    const walkMs = performance.now() - walkStart;

    const scanStart = performance.now();
    const ctx: SweepContext = {
      roles: input.roles,
      nowMs,
      horizonMs: nowMs - this.store.retentionMs,
      deadline: scanStart + this.budgetMs,
      firstIds: this.indexFirstIds(),
      responses: 0,
      lastYield: scanStart,
      longestBlockMs: 0,
    };
    // Newest first, so the short ranges fill before the long tail of the backfill.
    const work = files
      .filter((file) => !this.isCaughtUp(file))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let complete = true;
    for (const [index, file] of work.entries()) {
      // The first file always starts, so every sweep makes progress whatever the budget.
      if (index > 0 && performance.now() >= ctx.deadline) {
        complete = false;
        break;
      }
      const outcome = await this.scanFile(file, ctx);
      if (outcome === "budget") {
        complete = false;
        break;
      }
    }
    this.store.prune(nowMs);
    return {
      filesTotal: files.length,
      filesDone: files.filter((file) => this.isCaughtUp(file)).length,
      complete,
      responses: ctx.responses,
      walkMs,
      scanMs: performance.now() - scanStart,
      longestBlockMs: ctx.longestBlockMs,
    };
  }

  private isCaughtUp(file: DiscoveredFile): boolean {
    const entry = this.store.getFile(file.path);
    return entry !== undefined && entry.size === file.size && entry.offset <= file.size;
  }

  /** Every transcript in the window, by real path; entries for files that are gone are dropped. */
  private async discover(nowMs: number): Promise<DiscoveredFile[]> {
    const seenRoots = new Set<string>();
    const found = new Map<string, DiscoveredFile>();
    const walkedRoots: string[] = [];
    for (const root of this.roots) {
      let realRoot: string;
      try {
        realRoot = await fs.realpath(root.dir);
      } catch {
        continue;
      }
      // Pool account homes link their `projects` to one real folder: read it once.
      if (seenRoots.has(realRoot)) continue;
      seenRoots.add(realRoot);
      try {
        await this.walk({ provider: root.provider, root: realRoot }, realRoot, 0, nowMs, found);
        walkedRoots.push(realRoot);
        this.unlistableRoots.delete(realRoot);
      } catch (error) {
        // A tree not listed in full keeps its entries: a file missing from a partial listing is
        // not gone, and dropping its entry would read it all again and count it twice.
        if (!this.unlistableRoots.has(realRoot)) {
          this.logger.warn({ err: error, root: realRoot }, "Failed to list transcripts");
        }
        this.unlistableRoots.add(realRoot);
      }
    }
    for (const [filePath] of this.store.listFiles()) {
      if (found.has(filePath)) continue;
      if (walkedRoots.some((root) => isInside(root, filePath))) this.store.deleteFile(filePath);
    }
    return [...found.values()];
  }

  private async walk(
    root: { provider: TranscriptProvider; root: string },
    dir: string,
    depth: number,
    nowMs: number,
    found: Map<string, DiscoveredFile>,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // Removed since its parent was listed: what it held is gone. Anything else fails the walk.
      if (depth > 0 && isMissing(error)) return;
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth + 1 < MAX_WALK_DEPTH && !SKIPPED_DIRS.has(entry.name)) {
          await this.walk(root, path.join(dir, entry.name), depth + 1, nowMs, found);
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(dir, entry.name));
      }
    }
    for (let index = 0; index < files.length; index += STAT_CONCURRENCY) {
      await Promise.all(
        files.slice(index, index + STAT_CONCURRENCY).map(async (filePath) => {
          let stat: Awaited<ReturnType<typeof fs.stat>>;
          try {
            stat = await fs.stat(filePath);
          } catch (error) {
            if (isMissing(error)) return;
            throw error;
          }
          if (nowMs - stat.mtimeMs > this.windowMs) return;
          const birthMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
          found.set(filePath, {
            path: filePath,
            provider: root.provider,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            startedMs: Math.min(birthMs, stat.mtimeMs),
            sessionHint:
              root.provider === "claude" ? claudeSessionFromPath(root.root, filePath) : null,
          });
        }),
      );
    }
  }

  private indexFirstIds(): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    for (const [filePath, entry] of this.store.listFiles()) {
      if (entry.firstId) addToIndex(index, entry.firstId, filePath);
    }
    return index;
  }

  private async scanFile(file: DiscoveredFile, ctx: SweepContext): Promise<ScanOutcome> {
    let entry = this.store.getFile(file.path);
    if (!entry || file.size < entry.offset) {
      // New, or shorter than what was read: rewritten, so it starts over.
      entry = { provider: file.provider, offset: 0, size: 0, mtimeMs: 0 };
      this.forkParentIds.delete(file.path);
    }
    const codexState = createCodexParseState(entry.model ?? null);
    const result = await this.readLines(file, entry, ctx, (line) =>
      this.processLine({ line, file, entry, codexState, ctx }),
    );
    entry.offset = result.consumed;
    // Always current, even mid-read: retention and pruning go by it.
    entry.mtimeMs = file.mtimeMs;
    if (file.provider === "codex") entry.model = codexState.model;
    if (result.outcome === "done") {
      entry.size = file.size;
      // Read again from its parents if the file grows while still inside the copy.
      this.forkParentIds.delete(file.path);
    }
    this.store.setFile(file.path, entry);
    return result.outcome;
  }

  /**
   * Streams `[offset, size)` line by line. Stops before a line `onLine` defers, or at the time
   * budget, always on a line boundary, so `consumed` is where the next sweep starts.
   */
  private async readLines(
    file: DiscoveredFile,
    entry: FileScanState,
    ctx: SweepContext,
    onLine: (line: Buffer) => Promise<LineOutcome>,
  ): Promise<{ outcome: ScanOutcome; consumed: number }> {
    let consumed = entry.offset;
    if (file.size <= consumed) return { outcome: "done", consumed };
    const stream = createReadStream(file.path, {
      start: consumed,
      end: file.size - 1,
      highWaterMark: READ_CHUNK_BYTES,
    });
    const splitter = new LineSplitter(consumed);
    let lines = 0;
    try {
      for await (const chunk of stream) {
        for (const { line, end } of splitter.push(chunk as Buffer)) {
          if (line && (await onLine(line)) === "defer") return { outcome: "deferred", consumed };
          consumed = end;
          lines += 1;
          if (lines % this.yieldEveryLines === 0 && (await this.yieldAndCheck(ctx))) {
            return { outcome: "budget", consumed };
          }
        }
        if (await this.yieldAndCheck(ctx)) return { outcome: "budget", consumed };
      }
    } catch (error) {
      // A file removed or unreadable mid-read: keep what was consumed and try again next sweep.
      this.logger.warn({ err: error, filePath: file.path }, "Failed to read transcript");
      return { outcome: "deferred", consumed };
    } finally {
      stream.destroy();
    }
    return { outcome: "done", consumed };
  }

  /** Yields to the event loop; true when the sweep's budget is spent. */
  private async yieldAndCheck(ctx: SweepContext): Promise<boolean> {
    const before = performance.now();
    ctx.longestBlockMs = Math.max(ctx.longestBlockMs, before - ctx.lastYield);
    await new Promise<void>((resolve) => setImmediate(resolve));
    ctx.lastYield = performance.now();
    return ctx.lastYield >= ctx.deadline;
  }

  private async processLine(input: {
    line: Buffer;
    file: DiscoveredFile;
    entry: FileScanState;
    codexState: CodexParseState;
    ctx: SweepContext;
  }): Promise<LineOutcome> {
    const { line, file, entry, codexState, ctx } = input;
    if (file.provider === "codex") {
      if (!CODEX_PREFILTERS.some((needle) => line.includes(needle))) return "ok";
      const record = parseCodexTranscriptLine(line.toString("utf8"), codexState);
      if (!record || record.timestampMs < ctx.horizonMs) return "ok";
      return this.book({
        id: record.responseId,
        sessionId: record.sessionId,
        atMs: record.timestampMs,
        model: record.model,
        counts: record,
        file,
        entry,
        ctx,
      });
    }
    if (!line.includes(CLAUDE_PREFILTER)) return "ok";
    const record = parseClaudeTranscriptLine(line.toString("utf8"));
    if (!record) return "ok";
    // Claude sometimes writes earlier responses again further down the same file, with their
    // original timestamps. A response well behind the newest one already read is such a copy.
    if (entry.newestMs !== undefined && record.timestampMs < entry.newestMs - REPLAY_SLACK_MS) {
      return "ok";
    }
    entry.newestMs = Math.max(entry.newestMs ?? record.timestampMs, record.timestampMs);
    if (await this.isForkCopy(record.messageId, file, entry, ctx)) return "ok";
    if (record.timestampMs < ctx.horizonMs) return "ok";
    return this.book({
      id: record.messageId,
      // Every line of a transcript names its session; a subagent file names its parent's.
      sessionId: record.sessionId ?? file.sessionHint,
      atMs: record.timestampMs,
      model: record.model,
      counts: record,
      file,
      entry,
      ctx,
    });
  }

  /**
   * A forked Claude session starts with a verbatim copy of its parent's transcript, with the same
   * response ids and timestamps. Both files' first response id is then the same, which is how a
   * fork is recognised; its copied prefix is skipped against the ids the parents already hold.
   */
  private async isForkCopy(
    messageId: string | null,
    file: DiscoveredFile,
    entry: FileScanState,
    ctx: SweepContext,
  ): Promise<boolean> {
    if (!messageId) return false;
    if (!entry.firstId) {
      entry.firstId = messageId;
      const parents = [...(ctx.firstIds.get(messageId) ?? [])].filter((p) => p !== file.path);
      addToIndex(ctx.firstIds, messageId, file.path);
      if (parents.length > 0) entry.forkOf = parents;
    }
    if (!entry.forkOf) return false;
    let parentIds = this.forkParentIds.get(file.path);
    if (!parentIds) {
      parentIds = await this.readResponseIds(entry.forkOf, ctx);
      this.forkParentIds.set(file.path, parentIds);
    }
    if (parentIds.has(messageId)) return true;
    // The first response the parents do not hold ends the copy.
    delete entry.forkOf;
    this.forkParentIds.delete(file.path);
    return false;
  }

  private async readResponseIds(paths: readonly string[], ctx: SweepContext): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const parentPath of paths) {
      let size: number;
      try {
        size = (await fs.stat(parentPath)).size;
      } catch {
        continue;
      }
      const parent: DiscoveredFile = {
        path: parentPath,
        provider: "claude",
        size: Math.min(size, MAX_FORK_PARENT_BYTES),
        mtimeMs: 0,
        startedMs: 0,
        sessionHint: null,
      };
      // Not budgeted: a fork is rare, and stopping halfway would leave its copy half-skipped.
      const unbudgeted = { ...ctx, deadline: Number.POSITIVE_INFINITY };
      await this.readLines(
        parent,
        { provider: "claude", offset: 0, size: 0, mtimeMs: 0 },
        unbudgeted,
        async (line) => {
          if (!line.includes(CLAUDE_PREFILTER)) return "ok";
          const id = parseClaudeTranscriptLine(line.toString("utf8"))?.messageId;
          if (id) ids.add(id);
          return "ok";
        },
      );
      ctx.lastYield = unbudgeted.lastYield;
      ctx.longestBlockMs = Math.max(ctx.longestBlockMs, unbudgeted.longestBlockMs);
    }
    return ids;
  }

  private book(input: {
    id: string | null;
    sessionId: string | null;
    atMs: number;
    model: string;
    counts: TokenCounts;
    file: DiscoveredFile;
    entry: FileScanState;
    ctx: SweepContext;
  }): LineOutcome {
    const { ctx } = input;
    const role = resolveRole({
      sessionId: input.sessionId,
      roles: ctx.roles,
      fileStartedMs: input.file.startedMs,
      nowMs: ctx.nowMs,
      graceMs: this.graceMs,
    });
    if (role === "defer") return "defer";
    const counted = countOnce(input.entry, input.id, input.counts, this.store.recentLimit);
    if (!counted) return "ok";
    const booking: UsageBooking = {
      atMs: input.atMs,
      provider: input.file.provider,
      model: input.model,
      role,
      ...counted.counts,
      responses: counted.responses,
    };
    this.store.add(booking);
    ctx.responses += counted.responses;
    return "ok";
  }
}

/**
 * Splits a byte stream into complete lines, each with the file offset just past its newline. A
 * trailing partial line waits for the next chunk; a line past MAX_LINE_BYTES is passed over
 * (`line: null`) without being buffered.
 */
class LineSplitter {
  private position: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private skipping = false;

  constructor(start: number) {
    this.position = start;
  }

  *push(chunk: Buffer): Generator<{ line: Buffer | null; end: number }> {
    const chunkStart = this.position;
    this.position += chunk.length;
    let from = 0;
    let newline = chunk.indexOf(10, from);
    while (newline !== -1) {
      const piece = chunk.subarray(from, newline);
      const line = this.skipping ? null : this.takeLine(piece);
      this.skipping = false;
      yield { line, end: chunkStart + newline + 1 };
      from = newline + 1;
      newline = chunk.indexOf(10, from);
    }
    if (!this.skipping && from < chunk.length) this.hold(chunk.subarray(from));
  }

  private takeLine(piece: Buffer): Buffer {
    const line = this.pending.length > 0 ? Buffer.concat([...this.pending, piece]) : piece;
    this.pending = [];
    this.pendingBytes = 0;
    return line;
  }

  private hold(rest: Buffer): void {
    this.pending.push(rest);
    this.pendingBytes += rest.length;
    if (this.pendingBytes > MAX_LINE_BYTES) {
      this.skipping = true;
      this.pending = [];
      this.pendingBytes = 0;
    }
  }
}

/**
 * Counts a response once. Claude writes one response as several lines with the same id; in a
 * subagent's transcript the later lines report more output as it streams. So a repeat adds only
 * what it reports beyond the largest count already booked for that id.
 */
function countOnce(
  entry: FileScanState,
  id: string | null,
  counts: TokenCounts,
  limit: number,
): { counts: TokenCounts; responses: number } | null {
  const own: TokenCounts = {
    input: counts.input,
    cacheWrite: counts.cacheWrite,
    cacheRead: counts.cacheRead,
    output: counts.output,
  };
  if (!id) return { counts: own, responses: 1 };
  const recent = (entry.recent ??= []);
  const seen = recent.find((response) => response[0] === id);
  if (!seen) {
    recent.push([id, own.input, own.cacheWrite, own.cacheRead, own.output]);
    if (recent.length > limit) recent.splice(0, recent.length - limit);
    return { counts: own, responses: 1 };
  }
  const delta: TokenCounts = {
    input: Math.max(0, own.input - seen[1]),
    cacheWrite: Math.max(0, own.cacheWrite - seen[2]),
    cacheRead: Math.max(0, own.cacheRead - seen[3]),
    output: Math.max(0, own.output - seen[4]),
  };
  seen[1] += delta.input;
  seen[2] += delta.cacheWrite;
  seen[3] += delta.cacheRead;
  seen[4] += delta.output;
  if (delta.input + delta.cacheWrite + delta.cacheRead + delta.output === 0) return null;
  return { counts: delta, responses: 0 };
}

/** `<root>/<project>/<session>.jsonl`, or `<root>/<project>/<session>/subagents/.../x.jsonl`. */
function claudeSessionFromPath(root: string, filePath: string): string | null {
  const parts = path.relative(root, filePath).split(path.sep);
  if (parts.length === 2) return path.basename(parts[1] ?? "", ".jsonl") || null;
  if (parts.length > 2 && parts[2] === "subagents") return parts[1] ?? null;
  return null;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const set = index.get(key) ?? new Set<string>();
  set.add(value);
  index.set(key, set);
}
