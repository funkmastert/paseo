import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { BackgroundWaitClass } from "./background-wait.js";
import type { StallActivity, StallJudgmentBranch } from "./stall-judgment.js";

/**
 * What the stall judgment decided and what came of it, one JSON line each, in
 * `$PASEO_HOME/jev/stall-judgments.jsonl` (0600; one rotation at 2 MB; lines older than 30 days
 * pruned at boot). It is how feature 10 is judged (docs/jev.md, "Pays if"): each JEV call's branch
 * and cost, and each stall episode's outcome beside the label JEV gave it, so the candidate
 * branch, the loop watch and the code-only background-wait rule can be weighed separately.
 *
 * No timeline text: labels, confidences, reasons and times only. The loop's repeated step and the
 * background-wait quote are clipped agent text, the same as the daemon log already carries.
 */

export const STALL_JUDGMENT_LOG_FILE = "stall-judgments.jsonl";
const ROTATED_FILE_NAME = "stall-judgments.1.jsonl";
const MAX_BYTES = 2_000_000;
const RETAIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60_000;

export interface StallJudgmentSummary {
  activity: StallActivity;
  confidence: number;
  /** False for a shadow answer. */
  applied: boolean;
}

export type StallMeasurementLine =
  | {
      type: "judgment";
      at: string;
      branch: StallJudgmentBranch;
      agentId: string;
      /** `stalled-agent:<id>` or `looping-agent:<id>`: joins the ladder's own record. */
      episodeKey: string;
      callId: string | null;
      judgment: StallJudgmentSummary | null;
      /** Why there is no judgment: `excluded`, `agent-hourly-cap`, `unavailable:daily-budget`… */
      reason: string | null;
      /** What code did. */
      action: string;
      /** What an applied answer would have done; differs from `action` in shadow. */
      wouldAction: string;
      costUsd: number | null;
      quietMinutes: number;
    }
  | {
      type: "episode-closed";
      at: string;
      branch: "candidate";
      agentId: string;
      episodeKey: string;
      why: string;
      acted: "nudge" | "handoff" | null;
      /** Minutes from the nudge or handoff to the close; null when nothing acted. */
      minutesAfterAct: number | null;
      /**
       * Still stalled a full recheck window after acting, so the ladder went to rung 2 (an agent,
       * or a person when `personFirst` held). Joined with the ladder's FIXED / NOT FIXED.
       */
      pastRecheck: boolean;
      /** The episode waited out a `progressing` hold. */
      held: boolean;
      /** Closed while held: the agent moved again, as JEV said it would. */
      closedDuringHold: boolean;
      judgment: StallJudgmentSummary | null;
      personFirst: boolean;
    }
  | {
      type: "loop-reported";
      at: string;
      agentId: string;
      episodeKey: string;
      /** False in shadow: it would have gone on the ladder. */
      applied: boolean;
      step: string;
      count: number;
    }
  | {
      type: "loop-closed";
      at: string;
      agentId: string;
      episodeKey: string;
      why: string;
      applied: boolean;
      minutesOpen: number;
    }
  | {
      type: "background-wait";
      at: string;
      agentId: string;
      waitClass: BackgroundWaitClass;
      /** `resumed`, `would-resume`, `capped`, `failed`, `skipped`. */
      action: string;
      quietMinutes: number;
      quote: string;
      /** Own work: what the final turn launched ("a background shell"). */
      launched: string[];
      /** External wait: what it waits on ("CI"). */
      target: string | null;
      detail: string | null;
    }
  | {
      /** What came of a `resumed` or `would-resume` line, at the agent's next idle check. */
      type: "background-wait-outcome";
      at: string;
      agentId: string;
      waitClass: BackgroundWaitClass;
      /** False for `would-resume`: what happened without a resume. */
      resumed: boolean;
      /** What started the next turn: the resume, another prompt, or the agent itself. */
      woke: "resume" | "prompt" | "self";
      toolWork: boolean;
      /** The next turn ended waiting again. */
      rewaited: boolean;
      minutesToNextIdle: number;
    };

export interface StallJudgmentLogOptions {
  dir: string;
  logger: Logger;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export class StallJudgmentLog {
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private writeChain: Promise<void>;
  private currentSize = 0;

  constructor(options: StallJudgmentLogOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.writeChain = this.init();
  }

  get path(): string {
    return path.join(this.dir, STALL_JUDGMENT_LOG_FILE);
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
      this.logger.warn({ err: error }, "stall judgment: log init failed");
    }
  }

  /** Enqueues the line; written off the sweep's path. Never throws. */
  append(line: StallMeasurementLine): void {
    this.writeChain = this.writeChain.then(() =>
      this.appendOne(line).catch((error: unknown) => {
        this.logger.warn({ err: error }, "stall judgment: log append failed");
      }),
    );
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async appendOne(line: StallMeasurementLine): Promise<void> {
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
