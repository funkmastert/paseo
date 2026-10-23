import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import {
  JEV_CALL_LABEL,
  JEV_SPAWN_LABEL,
  TASK_CLASS_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-labels";

import { writeFileAtomic } from "../atomic-file.js";
import type {
  JevDecisionNote,
  JevDecisionRecord,
  JevDecisionSink,
  JevFeatureId,
} from "./contract.js";
import { JEV_FEATURE_LANES } from "./contract.js";
import { detailForJevDecision, summarizeJevDecision } from "./decision-summary.js";
import { parseJevSpawnLabel } from "./savings-spawn.js";

/**
 * The per-agent decision store (docs/jev.md, "Decision store"). A decision never reaches the
 * agent timeline store, because a row appended there would re-date the agent's last failure for
 * account failover (`agent/account-failover-detector.ts`). With a `filePath` it survives a
 * restart in its own file; pending spawn hints stay in memory.
 */

const DEFAULT_MAX_PER_AGENT = 50;
const DEFAULT_MAX_AGENTS = 500;
const DEFAULT_MAX_PENDING = 500;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
/** The caps alone allow 25,000 records; this keeps a rewrite of the file cheap. */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

const SPAWN_HINT_APPLIED_ACTION = "task class set by JEV at create";

/**
 * The record fields the file keeps: `summary` and `detail` are recomputed, and the subject
 * fields are read-time.
 */
type StoredRecordField = Exclude<
  keyof JevDecisionRecord,
  "summary" | "detail" | "subjectAgentId" | "subjectAgentTitle"
>;

// `satisfies` makes a field added to `JevDecisionRecord` a compile error here until the schema
// keeps it; otherwise `z.object` would strip it at load without a word.
const PERSISTED_RECORD_SCHEMA = z.object({
  agentId: z.string(),
  callId: z.string(),
  feature: z.custom<JevFeatureId>(
    (value) => typeof value === "string" && Object.hasOwn(JEV_FEATURE_LANES, value),
  ),
  question: z.string(),
  verdict: z.string(),
  confidence: z.number().nullable(),
  action: z.string(),
  applied: z.boolean(),
  mode: z.enum(["shadow", "live"]).optional(),
  wouldBe: z.string().nullable().optional(),
  savingsId: z.string().optional(),
  at: z.string(),
  costUsd: z.number().nullable(),
} satisfies Record<StoredRecordField, z.ZodType>);

/** The shape `PERSISTED_FILE_SCHEMA` reads, written by hand so each agent is serialized once. */
const FILE_HEAD = '{"version":1,"agents":[';
const FILE_TAIL = "]}";

const PERSISTED_AGENT_SCHEMA = z.object({ agentId: z.string(), decisions: z.array(z.unknown()) });

/**
 * Agents least- to most-recently written, each one's decisions newest first. Agents and records
 * are checked one at a time on load, so a bad one (or a feature from a newer daemon) costs only
 * itself.
 */
const PERSISTED_FILE_SCHEMA = z.object({ version: z.literal(1), agents: z.array(z.unknown()) });

/**
 * A `JSON.stringify` replacer: `summary` and `detail` are recomputed at load, so the file never
 * carries them.
 */
function withoutSummary(key: string, value: unknown): unknown {
  return key === "summary" || key === "detail" ? undefined : value;
}

/** Computes both read-time fields a decision carries (docs/jev.md, "Feature 11"). */
function attachSummaryFields(record: JevDecisionRecord): void {
  record.summary = summarizeJevDecision(record);
  const detail = detailForJevDecision(record);
  if (detail) record.detail = detail;
}

export interface JevDecisionStoreOptions {
  now?: () => number;
  /** Newest notes kept per agent. */
  maxPerAgent?: number;
  /** Agents kept; the least recently written is evicted past this. */
  maxAgents?: number;
  /** Notes recorded with `agentId: null`, keyed by `callId`, before the agent exists. */
  maxPending?: number;
  costFor?: (callId: string) => number | null;
  /** `$PASEO_HOME/jev/decisions.json`. Without it the store is in memory only. */
  filePath?: string;
  logger?: Logger;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  flushIntervalMs?: number;
  /** The file keeps the most recently written agents that fit; memory keeps all of them. */
  maxFileBytes?: number;
}

export class JevDecisionStore implements JevDecisionSink {
  private readonly now: () => number;
  private readonly maxPerAgent: number;
  private readonly maxAgents: number;
  private readonly maxPending: number;
  private readonly costFor?: (callId: string) => number | null;
  private readonly filePath: string | null;
  private readonly logger: Logger | null;
  private readonly writeFile: (filePath: string, data: string) => Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly maxFileBytes: number;

  /** Newest first. Re-set on every write, so key order is least- to most-recently-written. */
  private readonly byAgent = new Map<string, JevDecisionRecord[]>();
  /** FIFO by callId; a spawn hint recorded before its agent exists. */
  private readonly pending = new Map<string, JevDecisionRecord>();
  /** False until `load()` has read the file, so an early flush cannot write over it. */
  private loaded = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Writes run one after another: an older snapshot landing last would undo a newer one. */
  private writes: Promise<void> = Promise.resolve();

  constructor(options: JevDecisionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxPerAgent = options.maxPerAgent ?? DEFAULT_MAX_PER_AGENT;
    this.maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.costFor = options.costFor;
    this.filePath = options.filePath ?? null;
    this.logger = options.logger?.child({ module: "jev-decisions" }) ?? null;
    this.writeFile =
      options.writeFile ?? ((filePath, data) => writeFileAtomic(filePath, data, { mode: 0o600 }));
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * Reads the file, applying today's caps. Never throws: a missing or unreadable file starts
   * empty, and the next write replaces it. Decisions recorded while it ran stay newest.
   */
  async load(): Promise<void> {
    if (this.filePath === null) return;
    try {
      const loaded = await this.readFile(this.filePath);
      // Rebuilt so the file's agents come first (least recently written) and anything recorded
      // during the read lands after them, ahead of its own agent's loaded decisions.
      const recordedMeanwhile = [...this.byAgent];
      this.byAgent.clear();
      for (const [agentId, list] of loaded) this.setAgent(agentId, list);
      for (const [agentId, list] of recordedMeanwhile) {
        this.setAgent(agentId, [...list, ...(this.byAgent.get(agentId) ?? [])]);
      }
    } catch (error) {
      this.logger?.warn(
        { err: error, filePath: this.filePath },
        "jev: decisions file unreadable, starting empty",
      );
    }
    this.loaded = true;
    if (this.dirty) this.scheduleFlush();
  }

  /** Persists the store if it changed. Never throws; a failed write is retried by the next. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writes = this.writes.then(() => this.writeIfDirty());
    return this.writes;
  }

  async stop(): Promise<void> {
    await this.flush();
  }

  record(note: JevDecisionNote): void {
    try {
      let costUsd: number | null = null;
      try {
        costUsd = this.costFor?.(note.callId) ?? null;
      } catch {
        costUsd = null;
      }
      const record: JevDecisionRecord = {
        ...note,
        at: new Date(this.now()).toISOString(),
        costUsd,
      };
      // Computed once here, not on every `list()` read: cheap either way, but a decision is
      // read on every poll of every open panel it's visible in. The pending spawn-hint note
      // (below) gets its own summary once its `applied`/`wouldBe` resolve at attach time, since
      // this one is incomplete until then.
      attachSummaryFields(record);
      if (note.agentId === null) {
        this.recordPending(note.callId, record);
      } else {
        this.recordForAgent(note.agentId, record);
        this.dirty = true;
        this.scheduleFlush();
      }
    } catch {
      // record() never throws.
    }
  }

  /** Newest first. Attaches the pending spawn hint named by the agent's `paseo.jev-call` label. */
  list(agentId: string, labels: Readonly<Record<string, string>> | null): JevDecisionRecord[] {
    const own = [...(this.byAgent.get(agentId) ?? [])];
    const callId = labels?.[JEV_CALL_LABEL];
    const pendingRecord = callId ? this.pending.get(callId) : undefined;
    if (!pendingRecord) return own;
    const applied = labels?.[TASK_CLASS_SOURCE_LABEL] === "jev";
    // The role router's `paseo.jev-spawn` says what the answer maps to: the note's `wouldBe`.
    const spawn = parseJevSpawnLabel(labels?.[JEV_SPAWN_LABEL]);
    const wouldBe = spawn
      ? { wouldBe: `${spawn.wouldClass ?? "standard"} on ${spawn.wouldModel ?? "?"}` }
      : {};
    const attached: JevDecisionRecord = applied
      ? { ...pendingRecord, ...wouldBe, agentId, applied, action: SPAWN_HINT_APPLIED_ACTION }
      : { ...pendingRecord, ...wouldBe, agentId, applied };
    // Recomputed: the pending note's own summary (set in record(), above) was built before
    // `applied`/`wouldBe` resolved, so it no longer matches this record.
    attachSummaryFields(attached);
    own.push(attached);
    return own;
  }

  private recordForAgent(agentId: string, record: JevDecisionRecord): void {
    const list = this.byAgent.get(agentId) ?? [];
    list.unshift(record);
    this.setAgent(agentId, list);
  }

  /** Caps `list` (newest first) and makes `agentId` the most recently written agent. */
  private setAgent(agentId: string, list: JevDecisionRecord[]): void {
    if (list.length > this.maxPerAgent) list.length = this.maxPerAgent;
    // Re-insert so the key moves to the end: the map's iteration order is least- to
    // most-recently-written, which is what the eviction below needs.
    this.byAgent.delete(agentId);
    this.byAgent.set(agentId, list);
    if (this.byAgent.size > this.maxAgents) {
      const oldest = this.byAgent.keys().next().value;
      if (oldest !== undefined) this.byAgent.delete(oldest);
    }
  }

  private recordPending(callId: string, record: JevDecisionRecord): void {
    this.pending.delete(callId);
    this.pending.set(callId, record);
    if (this.pending.size > this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
  }

  private async readFile(filePath: string): Promise<Array<[string, JevDecisionRecord[]]>> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const file = PERSISTED_FILE_SCHEMA.parse(JSON.parse(text));
    const agents: Array<[string, JevDecisionRecord[]]> = [];
    for (const rawAgent of file.agents) {
      const agent = PERSISTED_AGENT_SCHEMA.safeParse(rawAgent);
      if (!agent.success) continue;
      const list: JevDecisionRecord[] = [];
      for (const rawRecord of agent.data.decisions) {
        const parsed = PERSISTED_RECORD_SCHEMA.safeParse(rawRecord);
        if (!parsed.success) continue;
        const record: JevDecisionRecord = parsed.data;
        attachSummaryFields(record);
        list.push(record);
      }
      agents.push([agent.data.agentId, list]);
    }
    return agents;
  }

  private async writeIfDirty(): Promise<void> {
    if (this.filePath === null || !this.loaded || !this.dirty) return;
    this.dirty = false;
    try {
      await this.writeFile(this.filePath, this.serialize());
    } catch (error) {
      this.dirty = true;
      this.logger?.warn({ err: error, filePath: this.filePath }, "jev: decisions flush failed");
    }
  }

  /**
   * The newest agents that fit in `maxFileBytes`, walked newest first so the cost of a write is
   * bounded by the file, never by the store. Each agent is serialized once.
   */
  private serialize(): string {
    const parts: string[] = [];
    let bytes = FILE_HEAD.length + FILE_TAIL.length;
    for (const [agentId, list] of [...this.byAgent].toReversed()) {
      const part = JSON.stringify({ agentId, decisions: list }, withoutSummary);
      const cost = Buffer.byteLength(part) + (parts.length > 0 ? 1 : 0);
      if (bytes + cost > this.maxFileBytes) break;
      bytes += cost;
      parts.push(part);
    }
    return `${FILE_HEAD}${parts.toReversed().join(",")}${FILE_TAIL}`;
  }

  private scheduleFlush(): void {
    // `loaded` implies a `filePath`: load() returns early without one.
    if (!this.loaded || this.flushTimer) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    timer.unref?.();
    this.flushTimer = timer;
  }
}
