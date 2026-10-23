import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The daemon's last words. A clean stop, a failed stop, a stop that ran out of budget and a
 * crash each leave a different receipt; a daemon killed outright leaves none. That difference is
 * what lets the next start, and restart recovery, tell "it stopped when asked" from "it died".
 *
 * Written synchronously and atomically (temp file, then rename) because it is written on the way
 * to `process.exit`, where an async write would never finish.
 */

export const SHUTDOWN_RECEIPT_FILENAME = "daemon-shutdown.json";
export const PREVIOUS_SHUTDOWN_RECEIPT_FILENAME = "daemon-shutdown.previous.json";
export const SHUTDOWN_RECEIPT_SCHEMA = "paseo.daemon-shutdown/v1";
/** The whole-shutdown budget the worker enforces. Matches the forced exit it always had. */
export const DAEMON_SHUTDOWN_BUDGET_MS = 10_000;

export const ShutdownReceiptSchema = z.object({
  schema: z.literal(SHUTDOWN_RECEIPT_SCHEMA),
  pid: z.number(),
  /** `clean`: everything stopped. `failed`: a step threw. `timed-out`: the budget ran out.
   * `crashed`: an uncaught exception or unhandled rejection took the process down. */
  outcome: z.enum(["clean", "failed", "timed-out", "crashed"]),
  /** What asked for the stop: a signal, the supervisor, a websocket intent, or the fault. */
  reason: z.string(),
  signal: z.string().nullable(),
  /** The step that was running when the outcome was decided. */
  phase: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  budgetMs: z.number(),
  exitCode: z.number(),
  failures: z.array(z.object({ phase: z.string(), error: z.string() })),
});

export type ShutdownReceipt = z.infer<typeof ShutdownReceiptSchema>;
export type ShutdownOutcome = ShutdownReceipt["outcome"];

export function shutdownReceiptPath(paseoHome: string): string {
  return path.join(paseoHome, SHUTDOWN_RECEIPT_FILENAME);
}

export type ShutdownReceiptRead =
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "ok"; receipt: ShutdownReceipt };

export function readShutdownReceipt(
  paseoHome: string,
  filename: string = SHUTDOWN_RECEIPT_FILENAME,
): ShutdownReceiptRead {
  let raw: string;
  try {
    raw = readFileSync(path.join(paseoHome, filename), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { status: "ok", receipt: ShutdownReceiptSchema.parse(JSON.parse(raw)) };
  } catch (error) {
    return { status: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The receipt describing the last run that ended. While a daemon is running, its own receipt does
 * not exist yet (startup moved the previous one aside), so the last shutdown is the `.previous`
 * file; once it has stopped, it is the current one.
 */
export function readLastShutdownReceipt(
  paseoHome: string,
  daemonRunning: boolean,
): ShutdownReceiptRead {
  return readShutdownReceipt(
    paseoHome,
    daemonRunning ? PREVIOUS_SHUTDOWN_RECEIPT_FILENAME : SHUTDOWN_RECEIPT_FILENAME,
  );
}

export interface ShutdownRecorderOptions {
  paseoHome: string;
  reason: string;
  signal: string | null;
  budgetMs?: number;
  now?: () => number;
}

export interface FinishOptions {
  outcome: ShutdownOutcome;
  exitCode: number;
}

/**
 * Tracks one shutdown. `enter` names the step in progress so a timeout can say where it hung;
 * `finish` writes the receipt exactly once. A second call is ignored, so the crash handler and
 * the forced-exit timer cannot overwrite an outcome that was already decided.
 */
export class ShutdownRecorder {
  private readonly options: ShutdownRecorderOptions;
  private readonly startedAtMs: number;
  private phase = "starting";
  private readonly failures: ShutdownReceipt["failures"] = [];
  private written: ShutdownReceipt | null = null;

  constructor(options: ShutdownRecorderOptions) {
    this.options = options;
    this.startedAtMs = (options.now ?? Date.now)();
  }

  get budgetMs(): number {
    return this.options.budgetMs ?? DAEMON_SHUTDOWN_BUDGET_MS;
  }

  enter(phase: string): void {
    this.phase = phase;
  }

  fail(error: unknown): void {
    this.failures.push({
      phase: this.phase,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /** Returns the write error, or null. It never throws: this runs on the way to exit. */
  finish(options: FinishOptions): { receipt: ShutdownReceipt; writeError: Error | null } {
    if (this.written) return { receipt: this.written, writeError: null };
    const receipt: ShutdownReceipt = {
      schema: SHUTDOWN_RECEIPT_SCHEMA,
      pid: process.pid,
      outcome: options.outcome,
      reason: this.options.reason,
      signal: this.options.signal,
      phase: options.outcome === "clean" ? "complete" : (this.failures[0]?.phase ?? this.phase),
      startedAt: new Date(this.startedAtMs).toISOString(),
      completedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      budgetMs: this.budgetMs,
      exitCode: options.exitCode,
      failures: this.failures,
    };
    this.written = receipt;
    try {
      writeReceiptAtomically(shutdownReceiptPath(this.options.paseoHome), receipt);
      return { receipt, writeError: null };
    } catch (error) {
      return { receipt, writeError: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

function writeReceiptAtomically(filePath: string, receipt: ShutdownReceipt): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(receipt)}\n`);
    renameSync(temp, filePath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export type PreviousShutdown =
  | { status: "none" }
  | { status: "unreadable"; error: string }
  | { status: "receipt"; receipt: ShutdownReceipt };

/**
 * Called once at startup. Moves the last run's receipt aside so a stale `clean` can never
 * describe a run that then crashed, and reports what it said. "none" means the previous run left
 * no receipt: it was killed, lost power, or this is the first run.
 */
export function consumePreviousShutdownReceipt(paseoHome: string): PreviousShutdown {
  const read = readShutdownReceipt(paseoHome);
  if (read.status === "missing") return { status: "none" };
  try {
    renameSync(
      shutdownReceiptPath(paseoHome),
      path.join(paseoHome, PREVIOUS_SHUTDOWN_RECEIPT_FILENAME),
    );
  } catch {
    // Leaving it in place is safe: the next shutdown overwrites it atomically.
  }
  if (read.status === "unreadable") return { status: "unreadable", error: read.error };
  return { status: "receipt", receipt: read.receipt };
}
