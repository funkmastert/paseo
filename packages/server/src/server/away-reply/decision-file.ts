import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

/**
 * What the away auto-reply decided, one JSON line per decision, in
 * `$PASEO_HOME/jev/away-reply-decisions.jsonl` (0600; one rotation at 4 MB; lines older than 14
 * days pruned at boot). This file is how Tyler decides to turn the feature live (docs/jev.md,
 * "Feature 14", D6): in a dry run it holds the exact text the job would have sent, JEV's verdicts,
 * and a later `followup` line saying what Tyler chose when he answered himself.
 *
 * No thread text: the sent text is a fixed template naming an option by its id, and Tyler's own
 * answer is recorded as the option it picked, never as what he wrote.
 */

const FILE_NAME = "away-reply-decisions.jsonl";
const ROTATED_FILE_NAME = "away-reply-decisions.1.jsonl";
const MAX_BYTES = 4_000_000;
const RETAIN_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

export type AwayReplyDecisionLine =
  | {
      type: "decision";
      at: string;
      agentId: string;
      title: string | null;
      episode: string;
      episodeKey: string;
      waitedMinutes: number;
      dryRun: boolean;
      /** `replied`, `would-reply`, `no-reply`, `not-sent`. */
      action: string;
      reason: string;
      callId: string | null;
      verdicts: string[];
      optionId: string | null;
      /** The exact text sent, or that a dry run would have sent. */
      text: string | null;
      /** For a request: how it was, or would have been, answered. */
      response: { behavior: "allow"; selectedActionId: string | null } | null;
    }
  | {
      type: "skip";
      at: string;
      agentId: string;
      title: string | null;
      episode: string;
      episodeKey: string;
      dryRun: boolean;
      reason: string;
    }
  | {
      type: "followup";
      at: string;
      agentId: string;
      episodeKey: string;
      callId: string | null;
      /** `tyler-message`, `tyler-answered-request`, or `no-tyler-action-24h`. */
      outcome: string;
      minutesAfterDecision: number;
      would: { kind: string; optionId: string | null };
      /** What Tyler picked, as far as code can read it: an option id, `approve`, `deny`, or null. */
      tyler: string | null;
      /** Whether Tyler chose what the job chose; null when that cannot be read. */
      sameChoice: boolean | null;
    };

export interface AwayReplyDecisionFileOptions {
  dir: string;
  logger: Logger;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export class AwayReplyDecisionFile {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private writeChain: Promise<void>;
  private currentSize = 0;

  constructor(options: AwayReplyDecisionFileOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.writeChain = this.init();
  }

  get path(): string {
    return path.join(this.dir, FILE_NAME);
  }

  private get rotatedPath(): string {
    return path.join(this.dir, ROTATED_FILE_NAME);
  }

  private get fileMode(): { mode: number } | undefined {
    return this.platform === "win32" ? undefined : { mode: 0o600 };
  }

  private async init(): Promise<void> {
    try {
      await fs.mkdir(
        this.dir,
        this.platform === "win32" ? { recursive: true } : { recursive: true, mode: 0o700 },
      );
      for (const file of [this.path, this.rotatedPath]) await this.prune(file);
      const stat = await fs.stat(this.path).catch(() => null);
      this.currentSize = stat?.size ?? 0;
    } catch (error) {
      this.logger.warn({ err: error }, "away-reply: decision file init failed");
    }
  }

  /** Enqueues the line; written off the caller's path. Never throws. */
  append(line: AwayReplyDecisionLine): void {
    this.writeChain = this.writeChain.then(() =>
      this.appendOne(line).catch((error: unknown) => {
        this.logger.warn({ err: error }, "away-reply: decision file append failed");
      }),
    );
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async appendOne(line: AwayReplyDecisionLine): Promise<void> {
    const text = `${JSON.stringify({ v: 1, ...line })}\n`;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.currentSize + bytes > MAX_BYTES) {
      await fs.rm(this.rotatedPath, { force: true });
      await fs.rename(this.path, this.rotatedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.currentSize = 0;
    }
    await fs.appendFile(this.path, text, this.fileMode);
    if (this.fileMode) await fs.chmod(this.path, this.fileMode.mode);
    this.currentSize += bytes;
  }

  private async prune(file: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    const horizon = this.now() - RETAIN_DAYS * DAY_MS;
    const lines = text.split("\n").filter((line) => line.length > 0);
    const kept = lines.filter((line) => {
      try {
        const at = Date.parse((JSON.parse(line) as { at?: string }).at ?? "");
        return !Number.isFinite(at) || at >= horizon;
      } catch {
        return true;
      }
    });
    if (kept.length === lines.length) return;
    await fs.writeFile(file, kept.length > 0 ? `${kept.join("\n")}\n` : "", this.fileMode);
  }
}
