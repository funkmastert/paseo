import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import { detectPullRequestCreation } from "./pull-request-ledger-detect.js";
import {
  buildPullRequestLedgerRowId,
  type PullRequestLedgerRow,
  type PullRequestLedgerStore,
} from "./pull-request-ledger-store.js";

/**
 * The slice of `AgentManager` the ledger needs: live detection (`subscribeTimelineRecorded`),
 * boot backfill (`listResidentAgents` + `getTimelineRows`), and the descendant-tree source for
 * `list()` (`listAgentRecordsForPullRequestLedger`). See docs/pull-request-ledger.md.
 */
export interface PullRequestLedgerAgentManager {
  subscribeTimelineRecorded(listener: (agentId: string, row: AgentTimelineRow) => void): () => void;
  listResidentAgents(): Array<{ id: string; title: string | null; cwd: string }>;
  /** The authenticated CLI context a status fetch for this agent's PRs should run from, and the
   * agent's display title. Null when the agent is no longer resident (status fetch then uses the
   * row's last-known cwd). */
  getAgentSummary(agentId: string): { cwd: string; title: string | null } | null;
  getTimelineRows(agentId: string): Promise<AgentTimelineRow[]>;
  listAgentRecordsForPullRequestLedger(): Promise<
    Array<{
      id: string;
      workspaceId: string | null;
      parentAgentId: string | null;
      title: string | null;
    }>
  >;
}

interface BackfillLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface PullRequestLedgerServiceOptions {
  store: PullRequestLedgerStore;
  agentManager: PullRequestLedgerAgentManager;
  now?: () => number;
  sweepIntervalMs?: number;
  logger?: BackfillLogger;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Resolves every descendant of `rootIds` (including archived), via `parentAgentId` labels. */
function resolveDescendantIds(
  rootIds: readonly string[],
  records: ReadonlyArray<{ id: string; parentAgentId: string | null }>,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const record of records) {
    if (!record.parentAgentId) continue;
    const siblings = childrenByParent.get(record.parentAgentId) ?? [];
    siblings.push(record.id);
    childrenByParent.set(record.parentAgentId, siblings);
  }
  const result = new Set<string>(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (result.has(childId)) continue;
      result.add(childId);
      queue.push(childId);
    }
  }
  return result;
}

export class PullRequestLedgerService {
  private readonly store: PullRequestLedgerStore;
  private readonly agentManager: PullRequestLedgerAgentManager;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly logger: BackfillLogger;
  private unsubscribeTimeline: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PullRequestLedgerServiceOptions) {
    this.store = options.store;
    this.agentManager = options.agentManager;
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.logger = options.logger ?? { warn: () => undefined };
  }

  /** Subscribes to live detection and starts the prune/flush sweep. Safe to call once. */
  start(): void {
    if (this.unsubscribeTimeline) return;
    this.unsubscribeTimeline = this.agentManager.subscribeTimelineRecorded((agentId, row) =>
      this.onTimelineRecorded(agentId, row),
    );
    const timer = setInterval(() => {
      const nowMs = this.now();
      this.store.prune(nowMs);
      void this.store.maybeFlush(nowMs);
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  async stop(): Promise<void> {
    this.unsubscribeTimeline?.();
    this.unsubscribeTimeline = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.store.close();
  }

  /**
   * One-time scan of every currently-resident agent's already-hydrated in-memory timeline
   * (docs/pull-request-ledger.md, "Backfill"). Catches PRs created by sessions that have been
   * running since before this feature shipped. A `closed` agent not resident at boot is not
   * covered here — it is caught the next time it is opened, since loading it replays its
   * provider history through the same live path `start()` subscribes to.
   */
  async backfillResidentAgents(): Promise<void> {
    for (const agent of this.agentManager.listResidentAgents()) {
      try {
        const rows = await this.agentManager.getTimelineRows(agent.id);
        for (const row of rows) {
          this.detectAndUpsert(agent.id, agent.title, agent.cwd, row);
        }
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: agent.id },
          "Pull request ledger backfill failed for one agent; continuing with the rest",
        );
      }
      // One agent's timeline can be large; yield to the event loop between agents so backfill
      // never blocks it for the whole resident set in one synchronous stretch.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private onTimelineRecorded(agentId: string, row: AgentTimelineRow): void {
    const summary = this.agentManager.getAgentSummary(agentId);
    this.detectAndUpsert(agentId, summary?.title ?? null, summary?.cwd ?? null, row);
  }

  private detectAndUpsert(
    agentId: string,
    agentTitle: string | null,
    agentCwd: string | null,
    row: AgentTimelineRow,
  ): void {
    const item = row.item;
    if (item.type !== "tool_call" || item.status !== "completed") return;
    const detected = detectPullRequestCreation(item.name, item.detail);
    if (!detected) return;
    const id = buildPullRequestLedgerRowId(detected);
    const existing = this.store.getRow(id);
    const parsedTimestampMs = Date.parse(row.timestamp);
    const detectedAtMs = existing?.detectedAtMs ?? parsedTimestampMs;
    const ledgerRow: PullRequestLedgerRow = {
      id,
      // The first observation wins: a later tool call touching the same PR (a retry, a
      // follow-up `gh api` read) never reassigns credit away from whoever actually created it.
      // `||`, not `??`: an existing row can carry the "" placeholder `ensureTracked` stores for
      // an unknown creator, and that falsy id should still be adopted by a real one.
      agentId: existing?.agentId || agentId,
      agentTitle: existing?.agentTitle ?? agentTitle,
      agentCwd: existing?.agentCwd ?? agentCwd ?? "",
      host: detected.host,
      repoOwner: detected.repoOwner,
      repoName: detected.repoName,
      number: detected.number,
      url: detected.url,
      forge: detected.forge,
      detectedAtMs: Number.isFinite(detectedAtMs) ? detectedAtMs : this.now(),
      status: existing?.status ?? "open",
      lastStatusCheckedAtMs: existing?.lastStatusCheckedAtMs ?? null,
    };
    this.store.upsertRow(ledgerRow);
  }

  /** The store row for this identity, if tracked. */
  getRow(id: string): PullRequestLedgerRow | undefined {
    return this.store.getRow(id);
  }

  /**
   * Tracks a PR discovered outside tool-call detection (the checkout's own current PR, read
   * from the workspace's git/forge snapshot). A no-op when the identity is already tracked —
   * this never overwrites a detected creator with a placeholder one.
   */
  ensureTracked(
    identity: {
      host: string;
      repoOwner: string;
      repoName: string;
      number: number;
      url: string;
      forge: string;
    },
    creator: { agentId: string; agentTitle: string | null; agentCwd: string },
  ): PullRequestLedgerRow {
    const id = buildPullRequestLedgerRowId(identity);
    const existing = this.store.getRow(id);
    if (existing) return existing;
    const row: PullRequestLedgerRow = {
      id,
      agentId: creator.agentId,
      agentTitle: creator.agentTitle,
      agentCwd: creator.agentCwd,
      host: identity.host,
      repoOwner: identity.repoOwner,
      repoName: identity.repoName,
      number: identity.number,
      url: identity.url,
      forge: identity.forge,
      detectedAtMs: this.now(),
      status: "open",
      lastStatusCheckedAtMs: null,
    };
    this.store.upsertRow(row);
    return row;
  }

  /** Marks a tracked PR's refreshed status, releasing it from the poll grid once terminal. */
  recordStatusCheck(id: string, status: PullRequestLedgerRow["status"], atMs: number): void {
    const row = this.store.getRow(id);
    if (!row) return;
    this.store.upsertRow({ ...row, status, lastStatusCheckedAtMs: atMs });
  }

  /**
   * Every PR opened by `workspaceId`'s root agent(s) or any descendant subagent, archived
   * included, newest first. Descendants may live in other workspaces (a leader's children open
   * PRs from their own worktrees) — the walk follows `parentAgentId`, not workspace membership.
   * Dedup against the workspace checkout's own branch PR is the caller's job (it already holds
   * the forge status plumbing this service does not need).
   */
  async list(workspaceId: string): Promise<PullRequestLedgerRow[]> {
    const records = await this.agentManager.listAgentRecordsForPullRequestLedger();
    const rootIds = records.filter((r) => r.workspaceId === workspaceId).map((r) => r.id);
    if (rootIds.length === 0) return [];
    const descendantIds = resolveDescendantIds(rootIds, records);
    return this.store
      .listRows()
      .filter((row) => descendantIds.has(row.agentId))
      .sort((a, b) => b.detectedAtMs - a.detectedAtMs);
  }
}
