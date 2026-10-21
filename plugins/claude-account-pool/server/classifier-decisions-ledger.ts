/**
 * The durable classifier-decisions ledger (docs/arena-ranking.md, "Decisions
 * ledger and dashboard"). Written at the same point `decision-log.ts` writes
 * its `classifier-decision` line, so a day's arena picks survive log
 * rotation and a daemon restart.
 *
 * A decision is noted (`notePending`) before the agent it belongs to exists
 * — the `before("agent.create")` hook that decides it runs before the
 * daemon mints an agent id — and resolved (`resolveAgent`) once the
 * `agent.created` event names that id, correlated by `index.server.ts`'s own
 * `CLASSIFIER_DECISION_ID_LABEL` token (a sibling of `decision-log.ts`'s
 * `DECISION_TOKEN_LABEL`, but never stripped, since the ledger needs it to
 * still be on the agent once `agent.created` fires). A pending row that
 * never resolves (the create was refused, or the daemon never reports it)
 * ages out rather than leaking memory.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  ClassifierDecisionArenaSchema,
  ClassifierDecisionsFileSchema,
  type ClassifierDecisionArena,
  type ClassifierDecisionRow,
  type ClassifierDecisionsFile,
} from "../shared/classifier-decisions-schema";

/** Bounds the durable file: oldest rows drop first. */
const MAX_ROWS = 5_000;
/** How long a decision waits for its agent's `agent.created` event before it is dropped. */
const PENDING_TTL_MS = 2 * 60_000;
/** Backstop against a flood of never-resolved pending entries. */
const MAX_PENDING = 1024;
/** How often an append is flushed to disk, mirroring `server/jev/ledger.ts`'s shape. */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export type PendingClassifierDecisionRow = Omit<ClassifierDecisionRow, "agentId" | "agentTitle" | "backfilled">;

export interface ClassifierDecisionsLedger {
  /** The role hook's decision, before the agent it belongs to exists. */
  notePending(token: string, row: PendingClassifierDecisionRow): void;
  /** `agent.created`: names the real agent for a pending decision. A token nothing is pending for is a no-op. */
  resolveAgent(token: string, agentId: string, agentTitle: string | null): void;
  /** Durable rows, newest first. Does not include unresolved pending entries. */
  all(): readonly ClassifierDecisionRow[];
  /** U3's one-time backfill result: appended once, and only when `backfilledAt()` is unset. */
  appendBackfill(rows: readonly ClassifierDecisionRow[]): Promise<void>;
  backfilledAt(): string | undefined;
  /** Forces an out-of-cycle flush; awaited on plugin shutdown. */
  flush(): Promise<void>;
}

export interface ClassifierDecisionsLedgerOptions {
  /** `$PASEO_HOME/classifier/decisions.json`. */
  filePath: string;
  now?: () => number;
  flushIntervalMs?: number;
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, data: string) => Promise<void>;
}

type Pending = { row: PendingClassifierDecisionRow; atMs: number };

function defaultReadFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

async function defaultWriteFile(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tempPath, data, "utf-8");
  await fs.rename(tempPath, filePath);
}

/**
 * Loads the ledger file, replacing rather than crashing on anything that
 * will not parse — this is a history, not a record anyone's correctness
 * depends on (docs/data-model.md's convention for this kind of store).
 */
export async function loadClassifierDecisionsLedger(
  options: ClassifierDecisionsLedgerOptions,
): Promise<ClassifierDecisionsLedger> {
  const now = options.now ?? Date.now;
  const readFile = options.readFile ?? defaultReadFile;
  const writeFile = options.writeFile ?? defaultWriteFile;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  let state: ClassifierDecisionsFile = { v: 1, rows: [] };
  try {
    const raw = await readFile(options.filePath);
    const parsed = ClassifierDecisionsFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      state = parsed.data;
    }
  } catch {
    // Missing or unparseable: start fresh, same as a fresh install.
  }

  const pending = new Map<string, Pending>();
  let dirty = false;
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  const prunePending = (nowMs: number) => {
    for (const [token, entry] of pending) {
      if (nowMs - entry.atMs >= PENDING_TTL_MS) {
        pending.delete(token);
      }
    }
    for (const token of pending.keys()) {
      if (pending.size < MAX_PENDING) break;
      pending.delete(token);
    }
  };

  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    await writeFile(options.filePath, JSON.stringify(state, null, 2));
  };

  flushTimer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  flushTimer.unref?.();

  return {
    notePending(token, row) {
      prunePending(now());
      pending.set(token, { row, atMs: now() });
    },
    resolveAgent(token, agentId, agentTitle) {
      const entry = pending.get(token);
      if (!entry) {
        return;
      }
      pending.delete(token);
      const full: ClassifierDecisionRow = { ...entry.row, agentId, agentTitle, backfilled: false };
      state = { ...state, rows: [full, ...state.rows].slice(0, MAX_ROWS) };
      dirty = true;
    },
    all() {
      return state.rows;
    },
    async appendBackfill(rows) {
      if (state.backfilledAt !== undefined) {
        return;
      }
      const merged = [...rows, ...state.rows].slice(0, MAX_ROWS);
      state = { ...state, rows: merged, backfilledAt: new Date(now()).toISOString() };
      dirty = true;
      await flush();
    },
    backfilledAt() {
      return state.backfilledAt;
    },
    async flush() {
      clearInterval(flushTimer);
      await flush();
    },
  };
}

/**
 * Builds the ledger's `arena` field from `decision-log.ts`'s already-serialized `model.ranking`
 * (`describeRanking()`'s output) — the ledger reuses its field names, including `credit`, which
 * this schema drops since every row is already attributed collectively (docs/arena-ranking.md).
 */
export function arenaFromDecisionLine(ranking: unknown): ClassifierDecisionArena | undefined {
  const parsed = ClassifierDecisionArenaSchema.safeParse(ranking);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Builds the pending row `index.server.ts`'s account hook hands to `notePending`, from the
 * structured object `decision-log.ts`'s `finish()` returns (its `describe()`/`describeUnknown()`
 * output) plus the work-kind label read off the routed request. Returns `undefined` when the
 * decision never reached an arena outcome at all (a leader create, `decideModel` never calls
 * `decideArenaPick` for one) — nothing to buffer, since R1 scopes the ledger to arena-eligible
 * decisions only.
 */
export function buildPendingRowFromDecisionLine(
  id: string,
  at: string,
  line: Record<string, unknown> | undefined,
  workKind: string | undefined,
): PendingClassifierDecisionRow | undefined {
  const model = line?.model;
  if (typeof model !== "object" || model === null) {
    return undefined;
  }
  const modelFields = model as Record<string, unknown>;
  const arena = arenaFromDecisionLine(modelFields.ranking);
  if (!arena) {
    return undefined;
  }
  const role = line?.role;
  const roleId = typeof role === "object" && role !== null ? (role as Record<string, unknown>).id : undefined;
  const taskClass = line?.taskClass;
  const taskClassValue =
    typeof taskClass === "object" && taskClass !== null ? (taskClass as Record<string, unknown>).value : undefined;
  return {
    id,
    at,
    role: typeof roleId === "string" ? roleId : null,
    taskClass: typeof taskClassValue === "string" ? taskClassValue : null,
    workKind: workKind ?? null,
    modelRan: typeof modelFields.final === "string" ? modelFields.final : null,
    arena,
  };
}
