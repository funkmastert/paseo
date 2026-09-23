import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";

/**
 * Records operations that ran longer than their budget, so a wedge report has a suspect.
 *
 * The event-loop monitor says how long the loop was blocked; this says what else was slow around
 * then. Every record is one JSON line in `$PASEO_HOME/diagnostics/slow-ops.jsonl`, rotated by
 * size, and correlated with a wedge by its timestamps.
 *
 * Nothing here may make the daemon slower or throw into a caller: a record is queued and
 * written off the call path, the queue is bounded, and a failed write is counted, not raised.
 * Only an operation that is already slow pays for a record.
 */

export const SLOW_OP_LOG_BASENAME = "slow-ops.jsonl";
export const DEFAULT_SLOW_OP_THRESHOLD_MS = 250;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_ROTATION_COUNT = 3;
const MAX_PENDING_RECORDS = 500;

export type SlowOpKind = "sync" | "async" | "observed";

export interface SlowOpRecord {
  /** ISO time the operation ended. */
  at: string;
  site: string;
  durationMs: number;
  kind: SlowOpKind;
  /** `error` when the operation threw; the duration is how long it ran before it did. */
  outcome: "ok" | "error";
  detail?: Record<string, unknown>;
}

export interface SlowOpRecorderOptions {
  filePath: string;
  thresholdMs?: number;
  maxBytes?: number;
  rotationCount?: number;
  now?: () => number;
  onWriteError?: (error: Error) => void;
}

export interface SlowOpStats {
  recorded: number;
  dropped: number;
  writeErrors: number;
}

export class SlowOpRecorder {
  readonly thresholdMs: number;
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly rotationCount: number;
  private readonly now: () => number;
  private readonly onWriteError: ((error: Error) => void) | undefined;
  private pending: string[] = [];
  private draining: Promise<void> | null = null;
  private size: number | null = null;
  private closed = false;
  private stopGcObserver: (() => void) | null = null;
  private readonly counters: SlowOpStats = { recorded: 0, dropped: 0, writeErrors: 0 };

  constructor(options: SlowOpRecorderOptions) {
    this.filePath = options.filePath;
    this.thresholdMs = options.thresholdMs ?? DEFAULT_SLOW_OP_THRESHOLD_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.rotationCount = options.rotationCount ?? DEFAULT_ROTATION_COUNT;
    this.now = options.now ?? Date.now;
    this.onWriteError = options.onWriteError;
  }

  /** Times a synchronous call, the kind that blocks the loop. */
  runSync<T>(site: string, fn: () => T, detail?: Record<string, unknown>): T {
    const startedAt = performance.now();
    try {
      const result = fn();
      this.finish(site, "sync", startedAt, "ok", detail);
      return result;
    } catch (error) {
      this.finish(site, "sync", startedAt, "error", detail);
      throw error;
    }
  }

  /** Times an async operation end to end. Its wall time includes waiting, not only blocking. */
  async runStage<T>(site: string, fn: () => Promise<T>, detail?: Record<string, unknown>) {
    const startedAt = performance.now();
    try {
      const result = await fn();
      this.finish(site, "async", startedAt, "ok", detail);
      return result;
    } catch (error) {
      this.finish(site, "async", startedAt, "error", detail);
      throw error;
    }
  }

  /** Records a duration measured elsewhere. Below the threshold it is ignored. */
  record(
    site: string,
    durationMs: number,
    detail?: Record<string, unknown>,
    kind: SlowOpKind = "observed",
  ): void {
    this.write({ site, durationMs, kind, outcome: "ok", detail });
  }

  /** Records long garbage collections, the usual non-obvious cause of a short stall. */
  observeGc(): void {
    if (this.stopGcObserver) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < this.thresholdMs) continue;
          const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind;
          this.write(
            {
              site: "gc",
              durationMs: entry.duration,
              kind: "observed",
              outcome: "ok",
              detail: { gcKind: kind },
            },
            performance.timeOrigin + entry.startTime + entry.duration,
          );
        }
      });
      observer.observe({ entryTypes: ["gc"] });
      this.stopGcObserver = () => observer.disconnect();
    } catch {
      // A runtime without GC entries loses this source and nothing else.
    }
  }

  stats(): SlowOpStats {
    return { ...this.counters };
  }

  /** Resolves once everything queued so far is on disk. */
  async flush(): Promise<void> {
    while (this.draining || this.pending.length > 0) {
      if (!this.draining) this.startDrain();
      await this.draining;
    }
  }

  async close(): Promise<void> {
    this.stopGcObserver?.();
    this.stopGcObserver = null;
    await this.flush();
    this.closed = true;
  }

  private finish(
    site: string,
    kind: SlowOpKind,
    startedAt: number,
    outcome: "ok" | "error",
    detail: Record<string, unknown> | undefined,
  ): void {
    this.write({ site, durationMs: performance.now() - startedAt, kind, outcome, detail });
  }

  private write(input: Omit<SlowOpRecord, "at">, endedAtMs: number = this.now()): void {
    if (this.closed || input.durationMs < this.thresholdMs) return;
    if (this.pending.length >= MAX_PENDING_RECORDS) {
      this.counters.dropped += 1;
      return;
    }
    const record: SlowOpRecord = {
      at: new Date(endedAtMs).toISOString(),
      site: input.site,
      durationMs: Math.round(input.durationMs),
      kind: input.kind,
      outcome: input.outcome,
      ...(input.detail ? { detail: input.detail } : {}),
    };
    this.pending.push(`${JSON.stringify(record)}\n`);
    this.counters.recorded += 1;
    if (!this.draining) this.startDrain();
  }

  private startDrain(): void {
    // Off the call path: the caller that just spent 400 ms does not also spend the write.
    this.draining = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          this.drain();
        } catch (error) {
          this.counters.writeErrors += 1;
          this.onWriteError?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.draining = null;
          resolve();
        }
      });
    });
  }

  private drain(): void {
    const lines = this.pending;
    this.pending = [];
    if (lines.length === 0) return;
    const payload = lines.join("");
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (this.size === null) this.size = safeSize(this.filePath);
    if (this.size > 0 && this.size + Buffer.byteLength(payload) > this.maxBytes) {
      this.rotate();
      this.size = 0;
    }
    const fd = openSync(this.filePath, "a", 0o600);
    try {
      writeSync(fd, payload);
      // The point of the file is the run that died right after: get it past the page cache.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.size += Buffer.byteLength(payload);
  }

  private rotate(): void {
    for (let index = this.rotationCount; index >= 1; index -= 1) {
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const target = `${this.filePath}.${index}`;
      if (!existsSync(source)) continue;
      rmSync(target, { force: true });
      renameSync(source, target);
    }
  }
}

function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

// One recorder per daemon, reachable without threading it through constructors, so a later unit
// can time a call site with one import. A no-op while the vitals are off.
let activeRecorder: SlowOpRecorder | null = null;

export function setActiveSlowOpRecorder(recorder: SlowOpRecorder | null): void {
  activeRecorder = recorder;
}

export function withSlowOpSync<T>(site: string, fn: () => T, detail?: Record<string, unknown>): T {
  return activeRecorder ? activeRecorder.runSync(site, fn, detail) : fn();
}

export function withSlowOpStage<T>(
  site: string,
  fn: () => Promise<T>,
  detail?: Record<string, unknown>,
): Promise<T> {
  return activeRecorder ? activeRecorder.runStage(site, fn, detail) : fn();
}
