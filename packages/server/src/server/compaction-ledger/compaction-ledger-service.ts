import type { LeaderCompactionEpisodeObserver } from "../agent-leader-compaction-monitor.js";
import { estimatedSavedWeightedTokens, stepCost } from "./compaction-ledger-cost.js";
import {
  emptyCompactionEpisodeTail,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

function rangeStartMs(range: CompactionRange | undefined, nowMs: number): number {
  switch (range) {
    case "today":
      return nowMs - (nowMs % DAY_MS);
    case "7d":
      return nowMs - 7 * DAY_MS;
    default:
      return Number.NEGATIVE_INFINITY;
  }
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

  onStepStarted(input: Parameters<LeaderCompactionEpisodeObserver["onStepStarted"]>[0]): void {
    let episode = this.openEpisodes.get(input.agentId);
    if (!episode) {
      episode = this.openEpisode(
        input.agentId,
        input.agentTitle,
        input.trigger,
        input.usedTokens,
        input.atMs,
      );
      this.openEpisodes.set(input.agentId, episode);
      // A new episode starting ends the previous one's payback-counting window.
      this.payingBackEpisodeId.delete(input.agentId);
    }
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
      stepRecord.costWeightedTokens = stepCost(input.totalTokensAtStart, input.totalTokensAtEnd);
    }
    if (input.compactedFromTokens !== null) episode.contextBeforeTokens = input.compactedFromTokens;
    if (input.compactedToTokens !== null) episode.contextAfterTokens = input.compactedToTokens;
    if (input.noteLength !== null) episode.noteLength = input.noteLength;

    if (input.episodeEnded) {
      this.closeEpisode(episode, input.episodeEnded, input.atMs);
      this.openEpisodes.delete(input.agentId);
      this.payingBackEpisodeId.set(input.agentId, episode.id);
    }
    this.store.upsertEpisode({ ...episode, steps: [...episode.steps] });
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

  private closeEpisode(
    episode: CompactionEpisodeRow,
    reason: "done" | "gaveUp",
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
