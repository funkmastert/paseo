import type { LeaderCompactionEpisodeObserver } from "../agent-leader-compaction-monitor.js";
import { estimatedSavedWeightedTokens, stepCost } from "./compaction-ledger-cost.js";
import {
  emptyCompactionEpisodeTail,
  type CompactionCarriedPrompt,
  type CompactionEpisodeOutcome,
  type CompactionEpisodeRow,
  type CompactionEpisodeSource,
  type CompactionLedgerStore,
  type CompactionStepOutcome,
  type CompactionStepRecord,
} from "./compaction-ledger-store.js";

/**
 * Wires `AgentLeaderCompactionMonitor`'s episode observer (docs/leader-compaction.md) to the
 * ledger store, computing each step's cost from `totalTokens` snapshots and maintaining the live
 * payback estimate via a per-request subscription (docs/token-burn.md). See docs/insights.md.
 */

export type CompactionRange = "today" | "7d" | "all";

export interface CompactionEpisodeFilter {
  agentId?: string;
  range?: CompactionRange;
}

export interface CompactionEpisodeSummary {
  count: number;
  totalCostWeightedTokens: number;
  averageCostWeightedTokens: number;
  totalEstimatedSavedWeightedTokens: number;
  measuredCount: number;
  unmeasuredCount: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** The same cut the monitor applies to the restore message (MAX_PROMPT_CHARS). */
const MAX_STORED_PROMPT_CHARS = 2_000;

/** Local midnight `daysBack` days before `nowMs`'s day: the host's day, as the JEV dashboard counts. */
function startOfLocalDayMs(nowMs: number, daysBack: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();
}

function rangeStartMs(range: CompactionRange | undefined, nowMs: number): number {
  switch (range) {
    case "today":
      return startOfLocalDayMs(nowMs, 0);
    case "7d":
      return startOfLocalDayMs(nowMs, 6);
    default:
      return Number.NEGATIVE_INFINITY;
  }
}

function storedPrompts(
  prompts: readonly CompactionCarriedPrompt[] | undefined,
): CompactionCarriedPrompt[] | null {
  if (!prompts || prompts.length === 0) return null;
  return prompts.map((prompt) => ({
    atMs: prompt.atMs,
    text:
      prompt.text.length > MAX_STORED_PROMPT_CHARS
        ? `${prompt.text.slice(0, MAX_STORED_PROMPT_CHARS)}…`
        : prompt.text,
  }));
}

/** When an episode that stopped early ended: its last step's end, or start if that never ended. */
function lastActivityMs(episode: CompactionEpisodeRow): number {
  const last = episode.steps[episode.steps.length - 1];
  return last ? (last.endedAtMs ?? last.startedAtMs) : episode.startedAtMs;
}

export interface CompactionLedgerServiceOptions {
  store: CompactionLedgerStore;
  /** AgentManager.subscribeTokenBurn; absent in tests that don't exercise payback counting. */
  subscribeTokenBurn?: (listener: (agentId: string, tokens: number) => void) => () => void;
  now?: () => number;
  sweepIntervalMs?: number;
}

export class CompactionLedgerService implements LeaderCompactionEpisodeObserver {
  private readonly store: CompactionLedgerStore;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  /** The episode each agent's monitor-driven compaction is building, keyed by agentId. */
  private readonly openEpisodes = new Map<string, CompactionEpisodeRow>();
  /** Which closed episode is still counting requests toward its payback estimate, per agent. */
  private readonly payingBackEpisodeId = new Map<string, string>();
  private unsubscribeTokenBurn: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CompactionLedgerServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (options.subscribeTokenBurn) {
      this.unsubscribeTokenBurn = options.subscribeTokenBurn((agentId, tokens) =>
        this.onTokenBurn(agentId, tokens),
      );
    }
  }

  /** Starts the prune/flush sweep. Safe to call once; a second call is a no-op. */
  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      const nowMs = this.now();
      this.store.prune(nowMs);
      void this.store.maybeFlush(nowMs);
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribeTokenBurn?.();
    await this.store.close();
  }

  /**
   * Closes rows a previous daemon left open (docs/insights.md): their episode died with that
   * process, so nothing will ever finish them. Also resumes payback counting for each agent's
   * newest closed episode. Call once, after the store has loaded.
   */
  reconcileAfterLoad(): void {
    const newestClosed = new Map<string, CompactionEpisodeRow>();
    for (const row of this.store.listEpisodes()) {
      if (row.endedAtMs === null && !this.openEpisodes.has(row.agentId)) {
        const closed: CompactionEpisodeRow = { ...row, steps: [...row.steps] };
        this.closeEpisode(closed, "interrupted", lastActivityMs(closed));
        this.store.upsertEpisode(closed);
        continue;
      }
      if (row.endedAtMs === null) continue;
      const newest = newestClosed.get(row.agentId);
      if (!newest || row.startedAtMs > newest.startedAtMs) newestClosed.set(row.agentId, row);
    }
    for (const [agentId, row] of newestClosed) {
      if (!this.openEpisodes.has(agentId) && !this.payingBackEpisodeId.has(agentId)) {
        this.payingBackEpisodeId.set(agentId, row.id);
      }
    }
  }

  onStepStarted(input: Parameters<LeaderCompactionEpisodeObserver["onStepStarted"]>[0]): void {
    let episode = this.openEpisodes.get(input.agentId);
    // A first prepare attempt always begins a new episode. One still open here was dropped
    // without the monitor saying so; close it rather than append to it.
    // A prepare the agent deferred or was refused is asked again as attempt 1 but is the same
    // episode: `reask` says so.
    if (episode && input.step === "prepare" && input.attempt === 1 && !input.reask) {
      this.abandon(episode, lastActivityMs(episode));
      episode = undefined;
    }
    if (!episode) {
      episode = this.openEpisode(
        input.agentId,
        input.agentTitle,
        input.trigger,
        input.usedTokens,
        input.atMs,
      );
      if (input.quietGate) {
        episode.quietGate = {
          ...input.quietGate,
          heldMs: input.quietGate.heldUntilMs - input.quietGate.heldFromMs,
        };
      }
      this.openEpisodes.set(input.agentId, episode);
      // A new episode starting ends the previous one's payback-counting window.
      this.payingBackEpisodeId.delete(input.agentId);
    }
    if (input.carriedPrompts) episode.promptsCarried = storedPrompts(input.carriedPrompts);
    episode.steps.push({
      step: input.step,
      startedAtMs: input.atMs,
      endedAtMs: null,
      outcome: "completed",
      costWeightedTokens: null,
    });
    this.store.upsertEpisode({ ...episode, steps: [...episode.steps] });
  }

  onStepFinished(input: Parameters<LeaderCompactionEpisodeObserver["onStepFinished"]>[0]): void {
    const episode = this.openEpisodes.get(input.agentId);
    if (!episode) return;
    const stepRecord: CompactionStepRecord | undefined = episode.steps[episode.steps.length - 1];
    if (stepRecord && stepRecord.step === input.step) {
      stepRecord.endedAtMs = input.atMs;
      stepRecord.outcome = input.outcome as CompactionStepOutcome;
      const steeredIn = input.steeredIn ?? 0;
      // Another message joined the turn: its spend includes answering that, so it is not the
      // compaction's own cost (docs/insights.md).
      stepRecord.costWeightedTokens =
        steeredIn > 0 ? null : stepCost(input.totalTokensAtStart, input.totalTokensAtEnd);
      if (steeredIn > 0) stepRecord.steeredIn = steeredIn;
    }
    if (input.compactedFromTokens !== null) episode.contextBeforeTokens = input.compactedFromTokens;
    if (input.compactedToTokens !== null) episode.contextAfterTokens = input.compactedToTokens;
    if (input.noteLength !== null) episode.noteLength = input.noteLength;
    if (input.carriedPrompts) episode.promptsCarried = storedPrompts(input.carriedPrompts);
    if (input.deferral !== undefined) episode.deferrals = input.deferral;

    if (input.episodeEnded) {
      this.closeEpisode(episode, input.episodeEnded, input.atMs);
      this.openEpisodes.delete(input.agentId);
      this.payingBackEpisodeId.set(input.agentId, episode.id);
    }
    this.store.upsertEpisode({ ...episode, steps: [...episode.steps] });
  }

  /** The monitor dropped the episode without finishing it (`onEpisodeAbandoned`). */
  onEpisodeAbandoned(input: { agentId: string; atMs: number }): void {
    const episode = this.openEpisodes.get(input.agentId);
    if (episode) this.abandon(episode, input.atMs);
  }

  /** Claude's own auto-compact, or a user's manual `/compact` (docs/leader-compaction.md). No
   * step boundaries exist for these, so cost is always unmeasured. */
  recordNativeCompaction(input: {
    agentId: string;
    agentTitle: string | null;
    trigger: "auto" | "manual";
    preTokens: number | null;
    postTokens: number | null;
    atMs: number;
  }): void {
    const id = `${input.agentId}:${input.atMs}:native`;
    this.store.upsertEpisode({
      id,
      agentId: input.agentId,
      agentTitle: input.agentTitle,
      source: input.trigger === "manual" ? "manual" : "native",
      trigger: input.trigger,
      triggerReason: null,
      startedAtMs: input.atMs,
      endedAtMs: input.atMs,
      steps: [],
      contextBeforeTokens: input.preTokens,
      contextAfterTokens: input.postTokens,
      outcome: "done",
      costBasis: "unmeasured",
      ...emptyCompactionEpisodeTail(),
    });
    this.payingBackEpisodeId.set(input.agentId, id);
  }

  list(filter: CompactionEpisodeFilter): CompactionEpisodeRow[] {
    const startMs = rangeStartMs(filter.range, this.now());
    return this.store
      .listEpisodes()
      .filter((row) => (filter.agentId ? row.agentId === filter.agentId : true))
      .filter((row) => row.startedAtMs >= startMs)
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  /** `list()`, sliced for the RPC: a cursor is the previous page's last row's `startedAtMs`. */
  page(filter: CompactionEpisodeFilter & { cursor?: string; limit?: number }): {
    episodes: CompactionEpisodeRow[];
    nextCursor: string | null;
  } {
    const rows = this.list(filter);
    const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
    const cursorMs = filter.cursor !== undefined ? Number(filter.cursor) : null;
    const afterCursor =
      cursorMs !== null && Number.isFinite(cursorMs)
        ? rows.filter((row) => row.startedAtMs < cursorMs)
        : rows;
    const episodes = afterCursor.slice(0, limit);
    const nextCursor =
      afterCursor.length > limit ? String(episodes[episodes.length - 1]?.startedAtMs) : null;
    return { episodes, nextCursor };
  }

  summary(filter: CompactionEpisodeFilter): CompactionEpisodeSummary {
    const rows = this.list(filter);
    let totalCost = 0;
    let totalSaved = 0;
    let measuredCount = 0;
    for (const row of rows) {
      if (row.costWeightedTokens !== null) {
        totalCost += row.costWeightedTokens;
        measuredCount += 1;
      }
      totalSaved += row.estimatedSavedWeightedTokens ?? 0;
    }
    return {
      count: rows.length,
      totalCostWeightedTokens: totalCost,
      averageCostWeightedTokens: measuredCount > 0 ? totalCost / measuredCount : 0,
      totalEstimatedSavedWeightedTokens: totalSaved,
      measuredCount,
      unmeasuredCount: rows.length - measuredCount,
    };
  }

  private openEpisode(
    agentId: string,
    agentTitle: string | null,
    trigger: Parameters<LeaderCompactionEpisodeObserver["onStepStarted"]>[0]["trigger"],
    usedTokens: number | undefined,
    atMs: number,
  ): CompactionEpisodeRow {
    const source: CompactionEpisodeSource = "monitor";
    return {
      id: `${agentId}:${atMs}`,
      agentId,
      agentTitle,
      source,
      trigger: trigger.kind,
      triggerReason: trigger.kind === "early" ? trigger.reason : null,
      startedAtMs: atMs,
      endedAtMs: null,
      steps: [],
      contextBeforeTokens: usedTokens ?? null,
      contextAfterTokens: null,
      outcome: "unknown",
      costBasis: "measured",
      ...emptyCompactionEpisodeTail(),
    };
  }

  /** Closes an open episode that stopped early, keeping what its finished steps cost. */
  private abandon(episode: CompactionEpisodeRow, atMs: number): void {
    this.closeEpisode(episode, "interrupted", atMs);
    this.openEpisodes.delete(episode.agentId);
    this.payingBackEpisodeId.set(episode.agentId, episode.id);
    this.store.upsertEpisode({ ...episode, steps: [...episode.steps] });
  }

  private closeEpisode(
    episode: CompactionEpisodeRow,
    reason: "done" | "gaveUp" | "interrupted",
    atMs: number,
  ): void {
    episode.endedAtMs = atMs;
    episode.outcome = reason satisfies CompactionEpisodeOutcome;
    const allMeasured = episode.steps.every((step) => step.costWeightedTokens !== null);
    episode.costBasis = allMeasured ? "measured" : "unmeasured";
    episode.costWeightedTokens = allMeasured
      ? episode.steps.reduce((sum, step) => sum + (step.costWeightedTokens ?? 0), 0)
      : null;
  }

  private onTokenBurn(agentId: string, _tokens: number): void {
    const episodeId = this.payingBackEpisodeId.get(agentId);
    if (!episodeId) return;
    const row = this.store.getEpisode(episodeId);
    if (!row) {
      this.payingBackEpisodeId.delete(agentId);
      return;
    }
    const requestsSince = (row.requestsSincePaybackCountedThrough ?? 0) + 1;
    const saved = estimatedSavedWeightedTokens(
      row.contextBeforeTokens,
      row.contextAfterTokens,
      requestsSince,
    );
    this.store.upsertEpisode({
      ...row,
      requestsSincePaybackCountedThrough: requestsSince,
      estimatedSavedWeightedTokens: saved,
    });
  }
}
