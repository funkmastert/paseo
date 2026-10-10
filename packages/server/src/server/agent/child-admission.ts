import { promises as fs } from "node:fs";
import os from "node:os";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { ResumePacer } from "./resume-pacer.js";

/**
 * Machine-wide admission for child agent turns (docs/resource-monitor.md, "Child admission and
 * resume pacing"). A child is an agent with a parent label; a root is never queued. Only a new
 * turn asks for a slot: steering, out-of-band commands, permission answers and a replacement of
 * a turn that is already running never come here.
 */

export interface ChildAdmissionConfig {
  enabled?: boolean;
  /** Unset means max(2, floor(cores / 2)). */
  maxConcurrentChildTurns?: number;
  bulkResumesPerMinute?: number;
}

export interface ChildAdmissionSettings {
  enabled: boolean;
  maxConcurrentChildTurns: number;
  bulkResumesPerMinute: number;
}

export const DEFAULT_BULK_RESUMES_PER_MINUTE = 4;

export function defaultMaxConcurrentChildTurns(cores: number = os.availableParallelism()): number {
  return Math.max(2, Math.floor(cores / 2));
}

export function resolveChildAdmissionSettings(
  config: ChildAdmissionConfig | undefined,
  cores?: number,
): ChildAdmissionSettings {
  return {
    enabled: config?.enabled ?? true,
    maxConcurrentChildTurns:
      config?.maxConcurrentChildTurns ?? defaultMaxConcurrentChildTurns(cores),
    bulkResumesPerMinute: config?.bulkResumesPerMinute ?? DEFAULT_BULK_RESUMES_PER_MINUTE,
  };
}

/** What slot accounting needs to know about each loaded agent. */
export interface AdmissionAgentView {
  id: string;
  parentAgentId: string | null;
  lifecycle: AgentLifecycleStatus;
}

/**
 * `reloaded`: the child's session is being swapped (a model change, an account move) and the
 * held prompt goes back in line at its old place on the new session; see `detach`.
 */
export type AdmissionDropReason = "canceled" | "closed" | "reloaded";

export type AdmissionOutcome =
  | { outcome: "admitted"; prompt: AgentPromptInput; runOptions?: AgentRunOptions }
  | { outcome: "dropped"; reason: AdmissionDropReason };

export type AdmissionRequestResult =
  | { status: "admitted" }
  | { status: "queued"; queuedAt: string; result: Promise<AdmissionOutcome> };

export interface AdmissionRequest {
  agentId: string;
  parentAgentId: string | null;
  prompt: AgentPromptInput;
  runOptions?: AgentRunOptions;
  /** The agent is replacing a turn it is running now, so it already holds its slot. */
  keepsSlot?: boolean;
  /** A held turn coming back after a reload or a restart keeps its original place in line. */
  queuedAt?: string;
}

const HeldTurnSchema = z.object({
  agentId: z.string(),
  parentAgentId: z.string(),
  prompt: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  runOptions: z.record(z.string(), z.unknown()).optional(),
  queuedAt: z.string(),
});

const QueueFileSchema = z.object({
  version: z.literal(1),
  held: z.array(HeldTurnSchema),
});

/** A held prompt as it is written to `$PASEO_HOME/admission/queue.json`. */
export interface HeldTurn {
  agentId: string;
  parentAgentId: string;
  prompt: AgentPromptInput;
  runOptions?: AgentRunOptions;
  queuedAt: string;
}

interface QueueEntry extends HeldTurn {
  resolve: (outcome: AdmissionOutcome) => void;
}

export async function loadHeldTurns(filePath: string, logger: Logger): Promise<HeldTurn[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err: error, filePath }, "Child admission: queue unreadable; starting empty");
    }
    return [];
  }
  try {
    const parsed = QueueFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.held as HeldTurn[];
    logger.warn({ filePath, issues: parsed.error.issues }, "Child admission: queue invalid");
  } catch (error) {
    logger.warn({ err: error, filePath }, "Child admission: queue is not JSON");
  }
  return [];
}

/**
 * Two prompts to one queued child become one turn. Nothing of the first may be lost: it never
 * reached the provider, so unlike a replaced running turn it is not in the conversation.
 */
export function mergeHeldPrompts(
  first: AgentPromptInput,
  second: AgentPromptInput,
): AgentPromptInput {
  if (typeof first === "string" && typeof second === "string") {
    return `${first}\n\n${second}`;
  }
  const toBlocks = (prompt: AgentPromptInput) =>
    typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt;
  return [...toBlocks(first), ...toBlocks(second)];
}

export interface ChildAdmissionControllerOptions {
  readConfig: () => ChildAdmissionConfig | undefined;
  listAgents: () => AdmissionAgentView[];
  logger: Logger;
  /** Where held prompts survive a restart. Unset keeps the queue in memory only (tests). */
  queueFilePath?: string;
  now?: () => Date;
  cores?: number;
  /** Injectable so tests drive the paced drain after a hold without waiting. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// The drain after a hold never goes slower than this, whatever bulkResumesPerMinute says.
const MIN_DRAIN_PER_MINUTE = 0.001;
/**
 * Nor faster than one resource-monitor sweep (DEFAULT_SWEEP_INTERVAL_MS): the memory brake reads
 * once a sweep, so a faster drain starts turns it has not seen the effect of.
 */
const MIN_DRAIN_INTERVAL_MS = 60_000;

export class ChildAdmissionController {
  private readonly queue: QueueEntry[] = [];
  /** Admitted and not yet running: counted as occupying a slot until the turn starts or fails. */
  private readonly starting = new Set<string>();
  private readonly holds = new Map<string, string>();
  /** Held turns read at boot and not yet re-dispatched; kept in the file until they are. */
  private readonly restoring = new Map<string, HeldTurn>();
  /** Turns kept for the next start because their session is gone; this run never re-sends them. */
  private readonly retainedForNextStart = new Set<string>();
  /** Restoring turns whose re-send is under way, each with what waits for it to land. */
  private readonly redispatching = new Map<
    string,
    { settled: Promise<void>; settle: () => void }
  >();
  private persistTail: Promise<void> = Promise.resolve();
  private persistenceFrozen = false;
  /**
   * Set when the last hold ends with children waiting: the `queuedAt` of the newest of them. That
   * backlog drains one turn per interval instead of filling every free slot at once; a child
   * queued after it is admitted as a slot frees, the way it would be with no hold. Null when no
   * drain is under way.
   */
  private pacedThroughQueuedAt: string | null = null;
  private lastPacedAdmitMs: number | null = null;
  private drainTimer: unknown = null;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ChildAdmissionControllerOptions) {
    this.logger = options.logger.child({ module: "child-admission" });
    this.now = options.now ?? (() => new Date());
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  settings(): ChildAdmissionSettings {
    return resolveChildAdmissionSettings(this.options.readConfig(), this.options.cores);
  }

  request(input: AdmissionRequest): AdmissionRequestResult {
    const settings = this.settings();
    if (!settings.enabled || input.parentAgentId === null) {
      return { status: "admitted" };
    }
    if (input.keepsSlot) {
      this.starting.add(input.agentId);
      return { status: "admitted" };
    }
    // This child is about to run or wait, so its parent is from now on waiting on a child.
    const occupied = this.occupiedSlots(input.agentId, input.parentAgentId);
    const queuedAt = input.queuedAt ?? this.now().toISOString();
    if (
      this.holds.size === 0 &&
      this.nothingAheadOf(queuedAt) &&
      occupied < settings.maxConcurrentChildTurns
    ) {
      this.starting.add(input.agentId);
      return { status: "admitted" };
    }
    let resolve!: (outcome: AdmissionOutcome) => void;
    const result = new Promise<AdmissionOutcome>((r) => {
      resolve = r;
    });
    const entry: QueueEntry = {
      agentId: input.agentId,
      parentAgentId: input.parentAgentId,
      prompt: input.prompt,
      ...(input.runOptions ? { runOptions: input.runOptions } : {}),
      queuedAt,
      resolve,
    };
    const later = this.queue.findIndex((queued) => queued.queuedAt > queuedAt);
    if (later >= 0) this.queue.splice(later, 0, entry);
    else this.queue.push(entry);
    this.logger.info(
      {
        agentId: input.agentId,
        parentAgentId: input.parentAgentId,
        queueLength: this.queue.length,
        occupied,
        cap: settings.maxConcurrentChildTurns,
        holds: this.holdReasons(),
      },
      "Child turn queued",
    );
    this.persist();
    return { status: "queued", queuedAt, result };
  }

  isQueued(agentId: string): boolean {
    return this.queue.some((entry) => entry.agentId === agentId);
  }

  /** In line now, or held across a restart and not yet re-sent. */
  holdsTurnFor(agentId: string): boolean {
    return this.isQueued(agentId) || this.restoring.has(agentId);
  }

  queueLength(): number {
    return this.queue.length;
  }

  /**
   * A second prompt to a queued child joins the held one and keeps its place in line. So does one
   * to a child whose turn was held across a restart and has not been re-sent yet: it joins that
   * turn, which keeps its original `queuedAt`, on disk. Returns false when there is neither.
   */
  mergeHeld(agentId: string, prompt: AgentPromptInput, runOptions?: AgentRunOptions): boolean {
    const entry =
      this.queue.find((candidate) => candidate.agentId === agentId) ??
      (this.redispatching.has(agentId) || this.retainedForNextStart.has(agentId)
        ? undefined
        : this.restoring.get(agentId));
    if (!entry) return false;
    entry.prompt = mergeHeldPrompts(entry.prompt, prompt);
    if (runOptions) entry.runOptions = { ...entry.runOptions, ...runOptions };
    this.logger.info(
      { agentId, queueLength: this.queue.length, restoring: this.restoring.has(agentId) },
      "Held child turn merged a second prompt",
    );
    this.persist();
    return true;
  }

  /**
   * Resolves once the re-send of this child's restored turn has landed (in line, started, or let
   * go). Null when no re-send is under way. A message that arrives in between waits for it, so it
   * goes after the older prompt instead of racing it.
   */
  restoreInFlight(agentId: string): Promise<void> | null {
    return this.redispatching.get(agentId)?.settled ?? null;
  }

  /** Drops a queued child. Returns false when it was not queued. */
  drop(agentId: string, reason: AdmissionDropReason): boolean {
    const index = this.queue.findIndex((entry) => entry.agentId === agentId);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    this.logger.info(
      { agentId, reason, queueLength: this.queue.length },
      "Queued child turn dropped",
    );
    entry!.resolve({ outcome: "dropped", reason });
    this.persist();
    return true;
  }

  /**
   * Takes a queued child's held turn out of line for a session reload; the caller re-requests it
   * with the returned `queuedAt` once the new session is up. Null when it was not queued.
   */
  detach(agentId: string): HeldTurn | null {
    const index = this.queue.findIndex((entry) => entry.agentId === agentId);
    if (index < 0) return null;
    const [entry] = this.queue.splice(index, 1);
    const { resolve, ...held } = entry!;
    resolve({ outcome: "dropped", reason: "reloaded" });
    this.persist();
    return held;
  }

  /** The admitted turn started or failed to; either way it is now visible in lifecycle state. */
  settleStart(agentId: string): void {
    if (this.starting.delete(agentId)) this.pump();
  }

  /**
   * Holds admission for `source` (the resource monitor's CPU and memory brake, for one). Admission
   * resumes when no source holds, and then the waiting children drain one at a time: on 09-28 a
   * release started six turns in one millisecond into 0.2 GB of free memory. Queued children stay
   * queued; running turns and roots are never touched.
   */
  setHold(source: string, held: boolean, reason?: string): void {
    const wasHeld = this.holds.has(source);
    if (held === wasHeld) {
      // Still held, for a different reason: what holds it changed (the resource monitor's CPU
      // and memory conditions share one source), and the queue lines should say what it is now.
      if (held && reason !== undefined && reason !== this.holds.get(source)) {
        this.holds.set(source, reason);
        this.logger.info({ source, reason }, "Child admission hold reason changed");
      }
      return;
    }
    if (held) this.holds.set(source, reason ?? source);
    else this.holds.delete(source);
    this.logger.info(
      { source, held, reason, holds: this.holdReasons(), queueLength: this.queue.length },
      held ? "Child admission held" : "Child admission hold released",
    );
    if (held) return;
    if (this.holds.size === 0 && this.queue.length > 0) {
      this.pacedThroughQueuedAt = this.queue.at(-1)!.queuedAt;
    }
    this.pump();
  }

  isHeld(): boolean {
    return this.holds.size > 0;
  }

  /**
   * Admits the oldest waiting child while admission is held, if a slot is free. The caller
   * vouches that one more turn is safe: the resource monitor's trickle under a long memory hold,
   * once a sweep. Returns the admitted child, or null.
   */
  admitNextWhileHeld(why: string): string | null {
    const settings = this.settings();
    if (!settings.enabled || this.queue.length === 0) return null;
    if (this.occupiedSlots() >= settings.maxConcurrentChildTurns) return null;
    const entry = this.queue.shift()!;
    this.admit(entry, why);
    // A release right after it waits a full interval before the drain's first turn.
    this.lastPacedAdmitMs = this.now().getTime();
    this.persist();
    return entry.agentId;
  }

  /**
   * Admits queued children FIFO while slots are free. While the backlog a hold left drains, that
   * backlog goes one per pacing interval and later children fill the free slots behind it. Cheap
   * when the queue is empty.
   */
  pump(): void {
    if (this.queue.length === 0) {
      this.endPacedDrain();
      return;
    }
    const settings = this.settings();
    if (!settings.enabled) {
      for (const entry of this.queue.splice(0)) this.admit(entry, "admission disabled");
      this.endPacedDrain();
      this.persist();
      return;
    }
    if (this.holds.size > 0) return;
    if (this.pacedThroughQueuedAt !== null && !this.isBacklog(this.queue[0]!)) {
      this.endPacedDrain();
    }
    let admitted = this.pacedThroughQueuedAt !== null && this.pumpPaced(settings);
    // Everything past the backlog is admitted as it would be with no hold.
    while (this.occupiedSlots() < settings.maxConcurrentChildTurns) {
      const index = this.queue.findIndex((entry) => !this.isBacklog(entry));
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      this.admit(entry!, "slot free");
      admitted = true;
    }
    if (this.queue.length === 0) this.endPacedDrain();
    if (admitted) this.persist();
  }

  /**
   * The backlog's head goes at once, then one per interval, and never past the cap: a turn ending
   * pumps again. A hold set in between stops the drain where it is (`pump` returns early).
   * Returns whether it admitted one.
   */
  private pumpPaced(settings: ChildAdmissionSettings): boolean {
    const intervalMs = Math.max(
      60_000 / Math.max(settings.bulkResumesPerMinute, MIN_DRAIN_PER_MINUTE),
      MIN_DRAIN_INTERVAL_MS,
    );
    const nowMs = this.now().getTime();
    const dueAtMs = this.lastPacedAdmitMs === null ? nowMs : this.lastPacedAdmitMs + intervalMs;
    if (nowMs < dueAtMs) {
      this.scheduleDrain(dueAtMs - nowMs);
      return false;
    }
    if (this.occupiedSlots() >= settings.maxConcurrentChildTurns) return false;
    this.admit(this.queue.shift()!, "paced after a hold");
    this.lastPacedAdmitMs = nowMs;
    const next = this.queue[0];
    if (next && this.isBacklog(next)) this.scheduleDrain(intervalMs);
    else this.endPacedDrain();
    return true;
  }

  /** In the line a hold left behind, which drains paced. */
  private isBacklog(entry: HeldTurn): boolean {
    return this.pacedThroughQueuedAt !== null && entry.queuedAt <= this.pacedThroughQueuedAt;
  }

  /**
   * Whether a child asking now at `queuedAt` has nobody in line ahead of it. During a drain the
   * backlog is not ahead of a later child: it is paced, and the later child fills a free slot.
   */
  private nothingAheadOf(queuedAt: string): boolean {
    if (this.queue.length === 0) return true;
    if (this.pacedThroughQueuedAt === null || queuedAt <= this.pacedThroughQueuedAt) return false;
    return this.queue.every((entry) => this.isBacklog(entry));
  }

  private holdReasons(): string[] {
    return [...this.holds.values()];
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = this.setTimer(
      () => {
        this.drainTimer = null;
        this.pump();
      },
      Math.max(1, Math.ceil(delayMs)),
    );
  }

  private endPacedDrain(): void {
    this.pacedThroughQueuedAt = null;
    this.lastPacedAdmitMs = null;
    if (this.drainTimer !== null) this.clearTimer(this.drainTimer);
    this.drainTimer = null;
  }

  heldTurns(): HeldTurn[] {
    return this.queue.map(({ resolve: _resolve, ...held }) => held);
  }

  /**
   * Adopts what the last run left in the file. They stay in it until `markRestored`, so a second
   * restart in the middle of a paced restore loses none of them.
   */
  adoptRestored(held: readonly HeldTurn[]): void {
    // Never over an entry already adopted: a message may have merged into it since.
    for (const turn of held) {
      if (!this.restoring.has(turn.agentId)) this.restoring.set(turn.agentId, turn);
    }
  }

  /**
   * The restored turn as it stands now, with any prompt merged into it since boot, marked as being
   * re-sent. Null when it is no longer restoring.
   */
  beginRedispatch(agentId: string): HeldTurn | null {
    const turn = this.restoring.get(agentId);
    if (!turn) return null;
    if (!this.redispatching.has(agentId)) {
      let settle = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      this.redispatching.set(agentId, { settled, settle });
    }
    return turn;
  }

  /**
   * Keeps a held turn that could not be put back in line (its agent's session is gone) in the file,
   * so the next start re-sends it like one held across a restart.
   */
  retainForRestart(turn: HeldTurn): void {
    this.retainedForNextStart.add(turn.agentId);
    this.restoring.set(turn.agentId, turn);
    this.persist();
  }

  markRestored(agentId: string): void {
    const redispatch = this.redispatching.get(agentId);
    this.redispatching.delete(agentId);
    this.retainedForNextStart.delete(agentId);
    if (this.restoring.delete(agentId)) this.persist();
    redispatch?.settle();
  }

  /**
   * On the way down every agent is closed, and a close drops a queued child. That is not the
   * child's outcome, so the file keeps what was held and the next start re-admits it. The held
   * set is captured now: a write still pending would otherwise read the queue after the closes.
   */
  prepareForShutdown(): void {
    this.endPacedDrain();
    if (this.persistenceFrozen) return;
    const held = this.fileContents();
    this.persist(held);
    this.persistenceFrozen = true;
  }

  /** Resolves once every queued write has landed. */
  async flush(): Promise<void> {
    await this.persistTail;
  }

  private admit(entry: QueueEntry, why: string): void {
    this.starting.add(entry.agentId);
    const waitedMs = this.now().getTime() - Date.parse(entry.queuedAt);
    this.logger.info(
      { agentId: entry.agentId, why, waitedMs, queueLength: this.queue.length },
      "Queued child turn admitted",
    );
    entry.resolve({
      outcome: "admitted",
      prompt: entry.prompt,
      ...(entry.runOptions ? { runOptions: entry.runOptions } : {}),
    });
  }

  /**
   * Running child turns, counted from lifecycle state whatever path started them, plus admitted
   * turns not yet running. A child whose own children are running or queued does not count: it
   * is waiting on them, and if waiting sub-leaders held every slot their children could never
   * run.
   */
  private occupiedSlots(excludeAgentId?: string, waitingParentId?: string): number {
    const views = this.options.listAgents();
    const queued = new Set(this.queue.map((entry) => entry.agentId));
    const waitingOnChildren = new Set<string>(waitingParentId ? [waitingParentId] : []);
    for (const view of views) {
      if (view.parentAgentId !== null && view.lifecycle === "running") {
        waitingOnChildren.add(view.parentAgentId);
      }
    }
    const occupied = new Set<string>();
    for (const view of views) {
      if (
        view.parentAgentId !== null &&
        view.lifecycle === "running" &&
        !queued.has(view.id) &&
        !waitingOnChildren.has(view.id)
      ) {
        occupied.add(view.id);
      }
    }
    for (const id of this.starting) occupied.add(id);
    if (excludeAgentId) occupied.delete(excludeAgentId);
    return occupied.size;
  }

  private fileContents(): HeldTurn[] {
    const live = this.heldTurns();
    const liveIds = new Set(live.map((turn) => turn.agentId));
    return [...[...this.restoring.values()].filter((turn) => !liveIds.has(turn.agentId)), ...live];
  }

  /** Queues a write of `held`, or of the queue as it is when the write runs. */
  private persist(held?: HeldTurn[]): void {
    const filePath = this.options.queueFilePath;
    if (!filePath || this.persistenceFrozen) return;
    this.persistTail = this.persistTail
      .then(() => writeJsonFileAtomic(filePath, { version: 1, held: held ?? this.fileContents() }))
      .catch((error) => {
        this.logger.warn({ err: error, filePath }, "Child admission: failed to save the queue");
      });
  }
}

export interface RestoreHeldTurnsInput {
  controller: ChildAdmissionController;
  pacer: ResumePacer;
  held: readonly HeldTurn[];
  /** Sends the held prompt again: it passes admission like any new turn, and may queue again. */
  dispatch: (turn: HeldTurn) => Promise<void>;
  logger: Logger;
}

/**
 * Re-admits what was queued when the daemon went down, oldest first, through the resume pacer.
 * A turn whose agent is gone (deleted, archived) is logged and let go.
 */
export async function restoreHeldTurns(input: RestoreHeldTurnsInput): Promise<void> {
  const { controller, pacer, logger } = input;
  if (input.held.length === 0) return;
  controller.adoptRestored(input.held);
  logger.info({ count: input.held.length }, "Re-admitting child turns held across a restart");
  const ordered = [...input.held].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  await Promise.all(
    ordered.map((turn) =>
      pacer
        .run({ agentId: turn.agentId, root: false, source: "restart" }, () =>
          // Whatever was merged into the turn while it waited goes with it.
          input.dispatch(controller.beginRedispatch(turn.agentId) ?? turn),
        )
        .catch((error: unknown) => {
          logger.warn(
            { err: error, agentId: turn.agentId },
            "Could not re-admit a held child turn after restart; dropping it",
          );
        })
        .finally(() => controller.markRestored(turn.agentId)),
    ),
  );
}
