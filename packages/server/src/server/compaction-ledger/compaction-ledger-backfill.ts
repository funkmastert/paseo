import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  emptyCompactionEpisodeTail,
  type CompactionEpisodeRow,
  type CompactionEpisodeTrigger,
  type CompactionLedgerStore,
  type CompactionStepName,
  type CompactionStepOutcome,
  type CompactionStepRecord,
} from "./compaction-ledger-store.js";

/**
 * One-time backfill from `$PASEO_HOME/daemon.log` and its rotated siblings, guarded by
 * `CompactionLedgerStore`'s `backfillDoneAtMs` marker (docs/insights.md). Reconstructs
 * monitor-driven episodes from the exact fields `agent-leader-compaction-monitor.ts` already logs —
 * "Leader compaction started a step" / "finished a step" / "step did not take" / "gave up". No
 * cost: these log lines carry no `totalTokens` snapshot, so every backfilled row is
 * `costBasis: "unmeasured"`. A line without a numeric `time` is skipped, never dated.
 */

interface ParsedLogLine {
  msg: string;
  agentId?: string;
  step?: string;
  trigger?: string;
  usedTokens?: number;
  attempt?: number;
  next?: string;
  reason?: string;
  compactedFromTokens?: number;
  compactedToTokens?: number;
  time: number;
}

const STARTED_MSG = "Leader compaction started a step";
const FINISHED_MSG = "Leader compaction finished a step";
const RETRY_MSG = "Leader compaction step did not take; will retry";
const GAVE_UP_MSG = "Leader compaction gave up";
const RELEVANT_MESSAGES = new Set([STARTED_MSG, FINISHED_MSG, RETRY_MSG, GAVE_UP_MSG]);
/** Every relevant message starts with this; the reader keeps only lines containing it. */
const LINE_MARKER = "Leader compaction";

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
  if (typeof obj.time !== "number" || !Number.isFinite(obj.time)) return null;
  return obj as unknown as ParsedLogLine;
}

/** The monitor's `describeFailure` text back to its step outcome; "failed" for anything else. */
function failedStepOutcome(reason: unknown): CompactionStepOutcome {
  if (typeof reason !== "string") return "failed";
  if (reason === "the turn was cancelled") return "canceled";
  if (reason.startsWith("the context ")) return "notCompacted";
  return "failed";
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

/** The episodes being rebuilt, per agent, and the ones already closed. */
interface Reconstruction {
  open: Map<string, CompactionEpisodeRow>;
  closed: CompactionEpisodeRow[];
}

function closeEpisode(
  state: Reconstruction,
  episode: CompactionEpisodeRow,
  outcome: CompactionEpisodeRow["outcome"],
  endedAtMs: number,
): void {
  episode.endedAtMs = endedAtMs;
  episode.outcome = outcome;
  state.open.delete(episode.agentId);
  state.closed.push(episode);
}

function onStepStarted(state: Reconstruction, entry: ParsedLogLine & { agentId: string }): void {
  if (!STEP_NAMES.has(entry.step as CompactionStepName)) return;
  let episode = state.open.get(entry.agentId);
  // A first prepare attempt always begins a new episode; one still open was cut off (a restart,
  // or dropped by the planner) and never logged an end.
  if (episode && entry.step === "prepare" && entry.attempt === 1) {
    const last = lastStep(episode);
    const endedAtMs = last ? (last.endedAtMs ?? last.startedAtMs) : episode.startedAtMs;
    closeEpisode(state, episode, "interrupted", endedAtMs);
    episode = undefined;
  }
  if (!episode) {
    episode = newEpisode(entry.agentId, entry.time, entry.trigger, entry.usedTokens);
    state.open.set(entry.agentId, episode);
  }
  episode.steps.push({
    step: entry.step as CompactionStepName,
    startedAtMs: entry.time,
    endedAtMs: null,
    outcome: "completed",
    costWeightedTokens: null,
  });
}

function onStepFinished(
  state: Reconstruction,
  episode: CompactionEpisodeRow,
  entry: ParsedLogLine,
): void {
  const step = lastStep(episode);
  if (step && step.step === entry.step) step.endedAtMs = entry.time;
  if (typeof entry.compactedFromTokens === "number") {
    episode.contextBeforeTokens = entry.compactedFromTokens;
  }
  if (typeof entry.compactedToTokens === "number") {
    episode.contextAfterTokens = entry.compactedToTokens;
  }
  if (entry.next === "settled") closeEpisode(state, episode, "done", entry.time);
}

function onStepFailed(
  state: Reconstruction,
  episode: CompactionEpisodeRow,
  entry: ParsedLogLine,
): void {
  const step = lastStep(episode);
  if (entry.msg === RETRY_MSG) {
    if (step && step.step === entry.step) {
      step.endedAtMs = entry.time;
      step.outcome = failedStepOutcome(entry.reason);
    }
    return;
  }
  if (step) {
    step.endedAtMs ??= entry.time;
    step.outcome = failedStepOutcome(entry.reason);
  }
  closeEpisode(state, episode, "gaveUp", entry.time);
}

/** Pure: lines in, closed episodes out. Open episodes at end of file (daemon still mid-episode
 * when the file was read) are dropped — their outcome cannot be determined yet. */
export function reconstructCompactionEpisodesFromLogLines(lines: string[]): CompactionEpisodeRow[] {
  const state: Reconstruction = { open: new Map(), closed: [] };
  for (const raw of lines) {
    const entry = parseLine(raw);
    if (!entry || typeof entry.agentId !== "string") continue;
    if (entry.msg === STARTED_MSG) {
      onStepStarted(state, { ...entry, agentId: entry.agentId });
      continue;
    }
    const episode = state.open.get(entry.agentId);
    if (!episode) continue;
    if (entry.msg === FINISHED_MSG) onStepFinished(state, episode, entry);
    else onStepFailed(state, episode, entry);
  }
  return state.closed;
}

export interface CompactionLedgerBackfillLogger {
  warn: (obj: object, msg?: string) => void;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * The compaction lines of `daemon.log` and its rotated siblings (`<stamp>-NN-daemon.log`, oldest
 * first by name; docs/development.md), streamed so only the rare matching lines are held. No log
 * yet reads as empty; any other read error throws.
 */
export async function readDaemonLogLines(logPath: string): Promise<string[]> {
  const dir = path.dirname(logPath);
  const base = path.basename(logPath);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const rotated = names.filter((name) => name !== base && name.endsWith(`-${base}`)).sort();
  const files = [...rotated, ...(names.includes(base) ? [base] : [])];
  const lines: string[] = [];
  for (const name of files) {
    const rl = createInterface({
      input: createReadStream(path.join(dir, name), { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      if (line.includes(LINE_MARKER)) lines.push(line);
    }
  }
  return lines;
}

export interface CompactionLedgerBackfillOptions {
  store: CompactionLedgerStore;
  logPath: string;
  /** Defaults to `readDaemonLogLines`; tests supply fixture lines. */
  readLines?: (logPath: string) => Promise<string[]>;
  logger: CompactionLedgerBackfillLogger;
  now?: () => number;
}

/** Runs once, guarded by the store's backfill marker. A log that could not be read leaves the
 * marker unset so the next boot tries again; the rows are keyed by log content, so a rerun
 * rewrites the same ids rather than adding new ones. */
export async function runCompactionLedgerBackfill(
  options: CompactionLedgerBackfillOptions,
): Promise<void> {
  if (options.store.getBackfillDoneAtMs() !== null) return;
  const now = options.now ?? Date.now;
  const readLines = options.readLines ?? readDaemonLogLines;

  let lines: string[];
  try {
    lines = await readLines(options.logPath);
  } catch (error) {
    options.logger.warn(
      { err: error, logPath: options.logPath },
      "Compaction ledger backfill: could not read the daemon log; will try again next boot",
    );
    return;
  }

  for (const row of reconstructCompactionEpisodesFromLogLines(lines)) {
    options.store.upsertEpisode(row);
  }
  options.store.markBackfillDone(now());
  await options.store.flush();
}
