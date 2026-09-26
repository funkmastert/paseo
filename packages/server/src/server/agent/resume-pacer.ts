import type { Logger } from "pino";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

/**
 * Paces bulk resumes (restart re-admission, account failover moves, stalled-agent nudges) so a
 * burst of them cannot start a burst of turns. A token bucket at `perMinute` with a burst of the
 * same size: one resume is immediate, eleven after a failover drain over a few minutes. Roots go
 * before children. A child the pacer releases still asks ChildAdmissionController for a slot.
 * See docs/resource-monitor.md, "Child admission and resume pacing".
 */

export interface ResumePacerSettings {
  enabled: boolean;
  perMinute: number;
}

export interface PacedResume {
  agentId: string;
  /** A root is released ahead of every waiting child. */
  root: boolean;
  /** Which bulk path asked, for the log. */
  source: string;
}

/** How a bulk path runs one resume: through the pacer in the daemon, directly in unit tests. */
export type PaceResume = <T>(resume: PacedResume, fn: () => Promise<T>) => Promise<T>;

export const unpacedResume: PaceResume = async (_resume, fn) => await fn();

/** A root is anything without a parent label; roots go ahead of waiting children. */
export function pacedResume(
  agentId: string,
  labels: Record<string, string> | undefined,
  source: string,
): PacedResume {
  return { agentId, root: getParentAgentIdFromLabels(labels) === null, source };
}

interface Waiter {
  resume: PacedResume;
  enqueuedAtMs: number;
  release: () => void;
  reject: (error: Error) => void;
}

export interface ResumePacerOptions {
  readSettings: () => ResumePacerSettings;
  logger: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ResumePacer {
  private tokens: number | null = null;
  private refilledAtMs = 0;
  private readonly waiting: Waiter[] = [];
  private timer: unknown = null;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ResumePacerOptions) {
    this.logger = options.logger.child({ module: "resume-pacer" });
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Runs `resume` once the bucket has a token for it. The caller's own error handling applies. */
  async run<T>(resume: PacedResume, fn: () => Promise<T>): Promise<T> {
    await this.acquire(resume);
    return await fn();
  }

  waitingCount(): number {
    return this.waiting.length;
  }

  /** On shutdown: nothing waiting may start now, so each waiter's caller gets an error. */
  stop(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error("Resume pacer stopped"));
  }

  private acquire(resume: PacedResume): Promise<void> {
    const settings = this.options.readSettings();
    if (!settings.enabled) return Promise.resolve();
    this.refill(settings);
    if (this.waiting.length === 0 && this.tokens! >= 1) {
      this.tokens! -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((release, reject) => {
      const waiter: Waiter = { resume, enqueuedAtMs: this.now(), release, reject };
      // Roots ahead of every child; FIFO within each class.
      const firstChild = resume.root ? this.waiting.findIndex((w) => !w.resume.root) : -1;
      if (firstChild >= 0) this.waiting.splice(firstChild, 0, waiter);
      else this.waiting.push(waiter);
      this.logger.info(
        {
          agentId: resume.agentId,
          source: resume.source,
          root: resume.root,
          waiting: this.waiting.length,
          perMinute: settings.perMinute,
        },
        "Resume paced: waiting for a slot in the resume budget",
      );
      this.schedule();
    });
  }

  private refill(settings: ResumePacerSettings): void {
    const nowMs = this.now();
    const burst = Math.max(1, settings.perMinute);
    if (this.tokens === null) {
      this.tokens = burst;
    } else {
      const elapsed = Math.max(0, nowMs - this.refilledAtMs);
      this.tokens = Math.min(burst, this.tokens + (elapsed * settings.perMinute) / 60_000);
    }
    this.refilledAtMs = nowMs;
  }

  private drain(): void {
    this.timer = null;
    const settings = this.options.readSettings();
    if (!settings.enabled) {
      for (const waiter of this.waiting.splice(0)) waiter.release();
      return;
    }
    this.refill(settings);
    while (this.waiting.length > 0 && this.tokens! >= 1) {
      this.tokens! -= 1;
      const waiter = this.waiting.shift()!;
      this.logger.info(
        {
          agentId: waiter.resume.agentId,
          source: waiter.resume.source,
          waitedMs: this.now() - waiter.enqueuedAtMs,
          waiting: this.waiting.length,
        },
        "Paced resume released",
      );
      waiter.release();
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null || this.waiting.length === 0) return;
    const settings = this.options.readSettings();
    const perMinute = Math.max(settings.perMinute, 0.001);
    const missing = Math.max(0, 1 - (this.tokens ?? 0));
    const delayMs = Math.max(1, Math.ceil((missing * 60_000) / perMinute));
    this.timer = this.setTimer(() => this.drain(), delayMs);
  }
}
