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

import type { DoneJanitorAgentSummary } from "./agent/agent-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "./workspace-registry.js";

/**
 * How long after Tyler last used a workspace it still counts as active. `agents.autoPinRecentUseMinutes`
 * overrides it.
 */
export const AUTO_PIN_RECENT_USE_MS = 2 * 60 * 60 * 1000;

/** The longest an expired auto pin waits for a sweep. Short windows sweep at a quarter of theirs. */
const AUTO_PIN_MAX_SWEEP_INTERVAL_MS = 60_000;
const AUTO_PIN_MIN_SWEEP_INTERVAL_MS = 1_000;

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
 */
export async function autoPinWorkspaceOnSessionStart(
  registry: Pick<WorkspaceRegistry, "get" | "update">,
  workspaceId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<PersistedWorkspaceRecord | null> {
  const existing = await registry.get(workspaceId);
  if (!existing) return null;
  if (existing.pinnedAt) return existing;
  return registry.update(workspaceId, (record) => {
    if (record.pinnedAt) return record;
    const timestamp = now();
    return { ...record, pinnedAt: timestamp, pinSource: "auto", updatedAt: timestamp };
  });
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
}

/**
 * Clears an auto pin once its workspace is finished, so the pin means "active" on every client
 * and in the done janitor without either computing it.
 *
 * A use is a session start (the auto-pin trigger) or a client heartbeat that has an agent in the
 * workspace focused while the app is visible, stamped with that client's last input. Uses live in
 * memory. A restart forgets them, so every auto pin gets one fresh window from daemon start rather
 * than dropping something Tyler looked at a minute before.
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
  private readonly startedAtMs: number;
  private readonly lastUsedAtMs = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sweeping: Promise<string[]> | null = null;
  private stopped = false;

  constructor(options: AutoPinExpiryOptions) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.listAgents = options.listAgents;
    this.readConfig = options.readConfig;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  /** Records that a client used `workspaceId` at `atMs` (clamped to now: client clocks drift). */
  noteWorkspaceUsed(workspaceId: string, atMs: number = this.now()): void {
    const usedAtMs = Math.min(Number.isFinite(atMs) ? atMs : this.now(), this.now());
    if (usedAtMs > (this.lastUsedAtMs.get(workspaceId) ?? Number.NEGATIVE_INFINITY)) {
      this.lastUsedAtMs.set(workspaceId, usedAtMs);
    }
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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

  private lastUsedAt(workspace: PersistedWorkspaceRecord): number {
    const pinnedAtMs = workspace.pinnedAt ? Date.parse(workspace.pinnedAt) : Number.NaN;
    return Math.max(
      this.startedAtMs,
      Number.isFinite(pinnedAtMs) ? pinnedAtMs : this.startedAtMs,
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
    for (const workspaceId of this.lastUsedAtMs.keys()) {
      if (!autoPinned.has(workspaceId)) this.lastUsedAtMs.delete(workspaceId);
    }
    if (expired.length > 0) {
      this.logger.info({ workspaceIds: expired }, "auto-pin expiry: cleared finished auto pins");
    }
    return expired;
  }
}
