/**
 * Auto-pinning: a workspace gets pinned automatically the first time Tyler starts a session in
 * it — a brand new workspace, or a new agent tab in an existing one — so it sorts to the top of
 * the sidebar while it's active. Only a human-attributable create does this; agent- and
 * daemon-triggered creates (MCP `create_workspace`/`create_agent`, Hub executions, schedules,
 * heartbeats, remediation, restart recovery) never do, because they happen constantly and would
 * flood the pinned list.
 *
 * An auto pin lasts only while the workspace is active (isWorkspaceActiveForAutoPin). Once it is
 * finished, AutoPinExpiry clears the pin, and every client groups the workspace as unpinned
 * because `pinnedAt` is the only pin state any of them read. The pin this sets is not the same
 * guarantee as a pin Tyler sets by hand: see isProtectivePin.
 * See docs/done-janitor.md#manual-pin-vs-auto-pin.
 */

import { readFile } from "node:fs/promises";

import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";
import type { DoneJanitorAgentSummary } from "./agent/agent-manager.js";
import type {
  PersistedWorkspaceRecord,
  WorkspaceMutationContext,
  WorkspaceRegistry,
} from "./workspace-registry.js";

/**
 * How long after Tyler last used a workspace it still counts as active. `agents.autoPinRecentUseMinutes`
 * overrides it.
 */
export const AUTO_PIN_RECENT_USE_MS = 24 * 60 * 60 * 1000;

/** The longest an expired auto pin waits for a sweep. Short windows sweep at a quarter of theirs. */
const AUTO_PIN_MAX_SWEEP_INTERVAL_MS = 60_000;
const AUTO_PIN_MIN_SWEEP_INTERVAL_MS = 1_000;

/** How long a burst of uses waits before the uses file is rewritten. */
const AUTO_PIN_USES_PERSIST_DEBOUNCE_MS = 2_000;

const PersistedUsesSchema = z.record(z.string(), z.number());

type AgentWorkFields = Pick<
  DoneJanitorAgentSummary,
  "lifecycle" | "busy" | "pendingPermissionCount"
>;

/**
 * What a live agent is doing that counts as work, or null when it is doing nothing: running or
 * initializing, a turn in flight, or waiting on a permission. The done janitor's last look before
 * a deletion reads the same rule.
 */
export function describeAgentWork(agent: AgentWorkFields): string | null {
  if (agent.lifecycle === "running" || agent.lifecycle === "initializing") {
    return `is ${agent.lifecycle}`;
  }
  if (agent.busy) return "has a turn in flight";
  if (agent.pendingPermissionCount > 0) return "is waiting on a permission";
  return null;
}

/**
 * The definition of "active" for an auto-pinned workspace; "finished" is not active.
 *
 * Active means an agent in it (by `workspaceId`) is working (describeAgentWork), or a client used
 * it within `recentUseMs` of `nowMs`. `lastUsedAtMs` is the newest use AutoPinExpiry knows of.
 */
export function isWorkspaceActiveForAutoPin(input: {
  workspaceId: string;
  agents: readonly (AgentWorkFields & Pick<DoneJanitorAgentSummary, "workspaceId">)[];
  lastUsedAtMs: number;
  nowMs: number;
  recentUseMs: number;
}): boolean {
  if (input.nowMs - input.lastUsedAtMs < input.recentUseMs) return true;
  return input.agents.some(
    (agent) => agent.workspaceId === input.workspaceId && describeAgentWork(agent) !== null,
  );
}

/**
 * Whether a workspace's `pinnedAt` still protects it from the done janitor's dead pass, its
 * finished-question pass, and worktree reclamation. A manual pin — Tyler's own gesture, or any
 * record written before `pinSource` existed — always does. An auto pin only holds the workspace
 * at the top of the sidebar while it's active; once the janitor's normal quiet-and-done rules
 * would otherwise reclaim it, an auto pin no longer stands in the way.
 */
export function isProtectivePin(
  workspace: Pick<PersistedWorkspaceRecord, "pinnedAt" | "pinSource">,
): boolean {
  return Boolean(workspace.pinnedAt) && workspace.pinSource !== "auto";
}

/**
 * Pins `workspaceId` as `"auto"` unless it is already pinned by any means. Pinning by hand always
 * takes precedence and is never downgraded or overwritten here — this only ever moves a workspace
 * from unpinned to auto-pinned.
 *
 * Callers gate this on a human-attributable create (see docs/done-janitor.md#manual-pin-vs-auto-pin for the
 * signal and its known gap) and on the `agents.autoPinSessions` config flag.
 *
 * `context.expectsInitialAgent` rides on the pin's mutation for a workspace created with its first
 * agent still to come: without it, clients get the pinned workspace as done until the agent exists.
 */
export async function autoPinWorkspaceOnSessionStart(
  registry: Pick<WorkspaceRegistry, "get" | "update">,
  workspaceId: string,
  options: { now?: () => string; context?: WorkspaceMutationContext } = {},
): Promise<PersistedWorkspaceRecord | null> {
  const now = options.now ?? (() => new Date().toISOString());
  const existing = await registry.get(workspaceId);
  if (!existing) return null;
  if (existing.pinnedAt) return existing;
  return registry.update(
    workspaceId,
    (record) => {
      if (record.pinnedAt) return record;
      const timestamp = now();
      return { ...record, pinnedAt: timestamp, pinSource: "auto", updatedAt: timestamp };
    },
    options.context,
  );
}

export interface AutoPinExpiryConfig {
  autoPinRecentUseMinutes?: number;
}

export interface AutoPinExpiryOptions {
  workspaceRegistry: Pick<WorkspaceRegistry, "list" | "update">;
  listAgents: () => readonly (AgentWorkFields & Pick<DoneJanitorAgentSummary, "workspaceId">)[];
  readConfig: () => AutoPinExpiryConfig;
  logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
  now?: () => number;
  /**
   * Where uses are persisted, atomically and debounced, so a restart recovers them instead of
   * giving every auto pin a fresh window from daemon start. Omit to keep uses in memory only
   * (tests that don't care about restart durability).
   */
  usesFilePath?: string;
  persistDebounceMs?: number;
}

/**
 * Clears an auto pin once its workspace is finished, so the pin means "active" on every client
 * and in the done janitor without either computing it.
 *
 * A use is a session start (the auto-pin trigger) or a client heartbeat that has an agent in the
 * workspace focused while the app is visible, stamped with that client's last input. Uses are
 * held in memory and mirrored to `usesFilePath`, debounced, so a restart recovers them instead of
 * giving every auto pin a fresh window from daemon start.
 *
 * Expiry never re-pins. A workspace whose agent resumes stays unpinned until Tyler starts a new
 * session there.
 */
export class AutoPinExpiry {
  private readonly workspaceRegistry: AutoPinExpiryOptions["workspaceRegistry"];
  private readonly listAgents: AutoPinExpiryOptions["listAgents"];
  private readonly readConfig: AutoPinExpiryOptions["readConfig"];
  private readonly logger: AutoPinExpiryOptions["logger"];
  private readonly now: () => number;
  private readonly usesFilePath: string | undefined;
  private readonly persistDebounceMs: number;
  private readonly lastUsedAtMs = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeping: Promise<string[]> | null = null;
  private stopped = false;

  constructor(options: AutoPinExpiryOptions) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.listAgents = options.listAgents;
    this.readConfig = options.readConfig;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.usesFilePath = options.usesFilePath;
    this.persistDebounceMs = options.persistDebounceMs ?? AUTO_PIN_USES_PERSIST_DEBOUNCE_MS;
  }

  /** Records that a client used `workspaceId` at `atMs` (clamped to now: client clocks drift). */
  noteWorkspaceUsed(workspaceId: string, atMs: number = this.now()): void {
    const usedAtMs = Math.min(Number.isFinite(atMs) ? atMs : this.now(), this.now());
    if (usedAtMs > (this.lastUsedAtMs.get(workspaceId) ?? Number.NEGATIVE_INFINITY)) {
      this.lastUsedAtMs.set(workspaceId, usedAtMs);
      this.schedulePersist();
    }
  }

  async start(): Promise<void> {
    await this.loadPersistedUses();
    this.stopped = false;
    this.schedule();
  }

  /** Awaits a pending debounced write so a shutdown never races it off disk. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      await this.flushPersistedUses().catch((error) =>
        this.logger.warn({ err: error }, "auto-pin uses: failed to flush on stop"),
      );
    }
  }

  /** Loads uses recorded before a restart. Missing or unreadable is treated as no prior uses. */
  private async loadPersistedUses(): Promise<void> {
    if (!this.usesFilePath) return;
    let raw: string;
    try {
      raw = await readFile(this.usesFilePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.warn({ err: error }, "auto-pin uses: failed to read persisted uses");
      }
      return;
    }
    try {
      const parsed = PersistedUsesSchema.parse(JSON.parse(raw));
      for (const [workspaceId, usedAtMs] of Object.entries(parsed)) {
        this.lastUsedAtMs.set(workspaceId, usedAtMs);
      }
    } catch (error) {
      this.logger.warn({ err: error }, "auto-pin uses: failed to parse persisted uses");
    }
  }

  private schedulePersist(): void {
    if (!this.usesFilePath || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPersistedUses().catch((error) =>
        this.logger.warn({ err: error }, "auto-pin uses: failed to persist"),
      );
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  /** Writes the current uses to `usesFilePath`. Exposed so tests don't need to wait on a timer. */
  async flushPersistedUses(): Promise<void> {
    if (!this.usesFilePath) return;
    await writeJsonFileAtomic(this.usesFilePath, Object.fromEntries(this.lastUsedAtMs));
  }

  /** Clears every auto pin whose workspace is finished; returns their ids. */
  sweep(): Promise<string[]> {
    this.sweeping ??= this.runSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private recentUseMs(): number {
    const minutes = this.readConfig().autoPinRecentUseMinutes;
    return minutes === undefined ? AUTO_PIN_RECENT_USE_MS : minutes * 60_000;
  }

  private schedule(): void {
    if (this.stopped) return;
    const intervalMs = Math.min(
      AUTO_PIN_MAX_SWEEP_INTERVAL_MS,
      Math.max(AUTO_PIN_MIN_SWEEP_INTERVAL_MS, this.recentUseMs() / 4),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sweep()
        .catch((error) => this.logger.warn({ err: error }, "auto-pin expiry sweep failed"))
        .finally(() => this.schedule());
    }, intervalMs);
    this.timer.unref?.();
  }

  /**
   * The newest moment this workspace counts as used: when it was first auto-pinned (always a
   * use), or a later use the uses map knows of — restored from `usesFilePath` on a restart, so a
   * relaunch never gives a workspace a fresher clock than it actually had.
   */
  private lastUsedAt(workspace: PersistedWorkspaceRecord): number {
    const pinnedAtMs = workspace.pinnedAt ? Date.parse(workspace.pinnedAt) : Number.NaN;
    return Math.max(
      Number.isFinite(pinnedAtMs) ? pinnedAtMs : Number.NEGATIVE_INFINITY,
      this.lastUsedAtMs.get(workspace.workspaceId) ?? Number.NEGATIVE_INFINITY,
    );
  }

  private isFinishedAutoPin(workspace: PersistedWorkspaceRecord): boolean {
    if (!workspace.pinnedAt || workspace.pinSource !== "auto" || workspace.archivedAt) return false;
    return !isWorkspaceActiveForAutoPin({
      workspaceId: workspace.workspaceId,
      agents: this.listAgents(),
      lastUsedAtMs: this.lastUsedAt(workspace),
      nowMs: this.now(),
      recentUseMs: this.recentUseMs(),
    });
  }

  private async runSweep(): Promise<string[]> {
    const workspaces = await this.workspaceRegistry.list();
    const autoPinned = new Set<string>();
    const expired: string[] = [];
    for (const workspace of workspaces) {
      if (workspace.pinSource === "auto" && workspace.pinnedAt) {
        autoPinned.add(workspace.workspaceId);
      }
      if (!this.isFinishedAutoPin(workspace)) continue;
      let cleared = false;
      // Decided again on the record as it is now: a hand pin or a new session since the list wins.
      await this.workspaceRegistry.update(workspace.workspaceId, (record) => {
        if (!this.isFinishedAutoPin(record)) return record;
        cleared = true;
        // updatedAt stays: expiry is not activity, and the done janitor's quiet clock reads it.
        return { ...record, pinnedAt: null, pinSource: undefined };
      });
      if (cleared) {
        autoPinned.delete(workspace.workspaceId);
        expired.push(workspace.workspaceId);
      }
    }
    // Uses matter only to a live auto pin; a new one starts from its own session start.
    let pruned = false;
    for (const workspaceId of this.lastUsedAtMs.keys()) {
      if (!autoPinned.has(workspaceId)) {
        this.lastUsedAtMs.delete(workspaceId);
        pruned = true;
      }
    }
    if (pruned) this.schedulePersist();
    if (expired.length > 0) {
      this.logger.info({ workspaceIds: expired }, "auto-pin expiry: cleared finished auto pins");
    }
    return expired;
  }
}
