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
}

export class ChildAdmissionController {
  private readonly queue: QueueEntry[] = [];
  /** Admitted and not yet running: counted as occupying a slot until the turn starts or fails. */
  private readonly starting = new Set<string>();
  private readonly holds = new Map<string, string>();
  /** Held turns read at boot and not yet re-dispatched; kept in the file until they are. */
  private readonly restoring = new Map<string, HeldTurn>();
  private persistTail: Promise<void> = Promise.resolve();
  private persistenceFrozen = false;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly options: ChildAdmissionControllerOptions) {
    this.logger = options.logger.child({ module: "child-admission" });
    this.now = options.now ?? (() => new Date());
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
    if (
      this.holds.size === 0 &&
      this.queue.length === 0 &&
      occupied < settings.maxConcurrentChildTurns
    ) {
      this.starting.add(input.agentId);
      return { status: "admitted" };
    }
    const queuedAt = input.queuedAt ?? this.now().toISOString();
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
        holds: [...this.holds.keys()],
      },
      "Child turn queued",
    );
    this.persist();
    return { status: "queued", queuedAt, result };
  }

  isQueued(agentId: string): boolean {
    return this.queue.some((entry) => entry.agentId === agentId);
  }

  queueLength(): number {
    return this.queue.length;
  }

  /**
   * A second prompt to a queued child joins the held one and keeps its place in line. Returns
   * false when the agent is not queued.
   */
  mergeHeld(agentId: string, prompt: AgentPromptInput, runOptions?: AgentRunOptions): boolean {
    const entry = this.queue.find((candidate) => candidate.agentId === agentId);
    if (!entry) return false;
    entry.prompt = mergeHeldPrompts(entry.prompt, prompt);
    if (runOptions) entry.runOptions = { ...entry.runOptions, ...runOptions };
    this.logger.info(
      { agentId, queueLength: this.queue.length },
      "Queued child turn merged a second prompt",
    );
    this.persist();
    return true;
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
   * Holds admission for `source` (the saturation rung, for one). Admission resumes when no source
   * holds. Queued children stay queued; running turns and roots are never touched.
   */
  setHold(source: string, held: boolean, reason?: string): void {
    const wasHeld = this.holds.has(source);
    if (held === wasHeld) return;
    if (held) this.holds.set(source, reason ?? source);
    else this.holds.delete(source);
    this.logger.info(
      { source, held, reason, holds: [...this.holds.keys()], queueLength: this.queue.length },
      held ? "Child admission held" : "Child admission hold released",
    );
    if (!held) this.pump();
  }

  isHeld(): boolean {
    return this.holds.size > 0;
  }

  /** Admits queued children FIFO while slots are free. Cheap when the queue is empty. */
  pump(): void {
    if (this.queue.length === 0) return;
    const settings = this.settings();
    if (!settings.enabled) {
      for (const entry of this.queue.splice(0)) this.admit(entry, "admission disabled");
      this.persist();
      return;
    }
    if (this.holds.size > 0) return;
    let admitted = false;
    while (this.queue.length > 0 && this.occupiedSlots() < settings.maxConcurrentChildTurns) {
      this.admit(this.queue.shift()!, "slot free");
      admitted = true;
    }
    if (admitted) this.persist();
  }

  heldTurns(): HeldTurn[] {
    return this.queue.map(({ resolve: _resolve, ...held }) => held);
  }

  /**
   * Adopts what the last run left in the file. They stay in it until `markRestored`, so a second
   * restart in the middle of a paced restore loses none of them.
   */
  adoptRestored(held: readonly HeldTurn[]): void {
    for (const turn of held) this.restoring.set(turn.agentId, turn);
  }

  /**
   * Keeps a held turn that could not be put back in line (its agent's session is gone) in the file,
   * so the next start re-sends it like one held across a restart.
   */
  retainForRestart(turn: HeldTurn): void {
    this.restoring.set(turn.agentId, turn);
    this.persist();
  }

  markRestored(agentId: string): void {
    if (this.restoring.delete(agentId)) this.persist();
  }

  /**
   * On the way down every agent is closed, and a close drops a queued child. That is not the
   * child's outcome, so the file keeps what was held and the next start re-admits it.
   */
  prepareForShutdown(): void {
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

  private persist(): void {
    const filePath = this.options.queueFilePath;
    if (!filePath || this.persistenceFrozen) return;
    this.persistTail = this.persistTail
      .then(() => writeJsonFileAtomic(filePath, { version: 1, held: this.fileContents() }))
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
        .run({ agentId: turn.agentId, root: false, source: "restart" }, () => input.dispatch(turn))
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
