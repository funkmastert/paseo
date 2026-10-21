import {
  emptyCompactionEpisodeTail,
  type CompactionEpisodeRow,
  type CompactionEpisodeTrigger,
  type CompactionLedgerStore,
  type CompactionStepName,
  type CompactionStepRecord,
} from "./compaction-ledger-store.js";

/**
 * One-time backfill from `$PASEO_HOME/daemon.log`, guarded by `CompactionLedgerStore`'s
 * `backfillDoneAtMs` marker (docs/insights.md). Reconstructs monitor-driven episodes from the
 * exact fields `agent-leader-compaction-monitor.ts` already logs — "Leader compaction started a
 * step" / "finished a step" / "gave up". No cost: these log lines carry no `totalTokens` snapshot,
 * so every backfilled row is `costBasis: "unmeasured"`.
 */

interface ParsedLogLine {
  msg: string;
  agentId?: string;
  step?: string;
  trigger?: string;
  usedTokens?: number;
  next?: string;
  compactedFromTokens?: number;
  compactedToTokens?: number;
  time?: number;
}

const STARTED_MSG = "Leader compaction started a step";
const FINISHED_MSG = "Leader compaction finished a step";
const GAVE_UP_MSG = "Leader compaction gave up";
const RELEVANT_MESSAGES = new Set([STARTED_MSG, FINISHED_MSG, GAVE_UP_MSG]);

const STEP_NAMES = new Set<CompactionStepName>(["prepare", "compact", "restore"]);
const TRIGGER_KINDS = new Set<CompactionEpisodeTrigger>(["line", "early"]);

function parseLine(raw: string): ParsedLogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.msg !== "string" || !RELEVANT_MESSAGES.has(obj.msg)) return null;
  return obj as unknown as ParsedLogLine;
}

function newEpisode(
  agentId: string,
  atMs: number,
  trigger: unknown,
  usedTokens: unknown,
): CompactionEpisodeRow {
  return {
    id: `${agentId}:${atMs}`,
    agentId,
    agentTitle: null,
    source: "backfill",
    trigger: TRIGGER_KINDS.has(trigger as CompactionEpisodeTrigger)
      ? (trigger as CompactionEpisodeTrigger)
      : "unknown",
    triggerReason: null,
    startedAtMs: atMs,
    endedAtMs: null,
    steps: [],
    contextBeforeTokens: typeof usedTokens === "number" ? usedTokens : null,
    contextAfterTokens: null,
    outcome: "unknown",
    costBasis: "unmeasured",
    ...emptyCompactionEpisodeTail(),
  };
}

function lastStep(episode: CompactionEpisodeRow): CompactionStepRecord | undefined {
  return episode.steps[episode.steps.length - 1];
}

/** Pure: lines in, closed episodes out. Open episodes at end of file (daemon still mid-episode
 * when the file was read) are dropped — their outcome cannot be determined yet. */
export function reconstructCompactionEpisodesFromLogLines(lines: string[]): CompactionEpisodeRow[] {
  const open = new Map<string, CompactionEpisodeRow>();
  const closed: CompactionEpisodeRow[] = [];

  for (const raw of lines) {
    const entry = parseLine(raw);
    if (!entry || typeof entry.agentId !== "string") continue;
    const atMs = typeof entry.time === "number" ? entry.time : 0;

    if (entry.msg === STARTED_MSG) {
      if (!STEP_NAMES.has(entry.step as CompactionStepName)) continue;
      let episode = open.get(entry.agentId);
      if (!episode) {
        episode = newEpisode(entry.agentId, atMs, entry.trigger, entry.usedTokens);
        open.set(entry.agentId, episode);
      }
      episode.steps.push({
        step: entry.step as CompactionStepName,
        startedAtMs: atMs,
        endedAtMs: null,
        outcome: "completed",
        costWeightedTokens: null,
      });
      continue;
    }

    const episode = open.get(entry.agentId);
    if (!episode) continue;

    if (entry.msg === FINISHED_MSG) {
      const step = lastStep(episode);
      if (step && step.step === entry.step) step.endedAtMs = atMs;
      if (typeof entry.compactedFromTokens === "number") {
        episode.contextBeforeTokens = entry.compactedFromTokens;
      }
      if (typeof entry.compactedToTokens === "number") {
        episode.contextAfterTokens = entry.compactedToTokens;
      }
      if (entry.next === "settled") {
        episode.endedAtMs = atMs;
        episode.outcome = "done";
        open.delete(entry.agentId);
        closed.push(episode);
      }
      continue;
    }

    if (entry.msg === GAVE_UP_MSG) {
      const step = lastStep(episode);
      if (step) step.outcome = "notCompacted";
      episode.endedAtMs = atMs;
      episode.outcome = "gaveUp";
      open.delete(entry.agentId);
      closed.push(episode);
    }
  }

  return closed;
}

export interface CompactionLedgerBackfillLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface CompactionLedgerBackfillOptions {
  store: CompactionLedgerStore;
  logPath: string;
  /** Injected so tests supply fixture lines without touching the real filesystem. */
  readLines: (logPath: string) => Promise<string[]>;
  logger: CompactionLedgerBackfillLogger;
  now?: () => number;
}

/** Runs once, guarded by the store's backfill marker. An empty or unreadable log still marks the
 * backfill done — there is nothing more to find, and a daemon with no history should not retry
 * this on every restart. */
export async function runCompactionLedgerBackfill(
  options: CompactionLedgerBackfillOptions,
): Promise<void> {
  if (options.store.getBackfillDoneAtMs() !== null) return;
  const now = options.now ?? Date.now;

  let lines: string[] = [];
  try {
    lines = await options.readLines(options.logPath);
  } catch (error) {
    options.logger.warn(
      { err: error, logPath: options.logPath },
      "Compaction ledger backfill: could not read the daemon log",
    );
  }

  for (const row of reconstructCompactionEpisodesFromLogLines(lines)) {
    options.store.upsertEpisode(row);
  }
  options.store.markBackfillDone(now());
  await options.store.flush();
}
