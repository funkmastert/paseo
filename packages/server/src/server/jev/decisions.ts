import {
  JEV_CALL_LABEL,
  JEV_SPAWN_LABEL,
  TASK_CLASS_SOURCE_LABEL,
} from "@getpaseo/protocol/agent-labels";

import type { JevDecisionNote, JevDecisionRecord, JevDecisionSink } from "./contract.js";
import { parseJevSpawnLabel } from "./savings-spawn.js";

/**
 * The per-agent decision store (docs/jev.md, "Decision store"). In memory only: a decision never
 * reaches the agent timeline store, because a row appended there would re-date the agent's last
 * failure for account failover (`agent/account-failover-detector.ts`).
 */

const DEFAULT_MAX_PER_AGENT = 50;
const DEFAULT_MAX_AGENTS = 500;
const DEFAULT_MAX_PENDING = 500;

const SPAWN_HINT_APPLIED_ACTION = "task class set by JEV at create";

export interface JevDecisionStoreOptions {
  now?: () => number;
  /** Newest notes kept per agent. */
  maxPerAgent?: number;
  /** Agents kept; the least recently written is evicted past this. */
  maxAgents?: number;
  /** Notes recorded with `agentId: null`, keyed by `callId`, before the agent exists. */
  maxPending?: number;
  costFor?: (callId: string) => number | null;
}

export class JevDecisionStore implements JevDecisionSink {
  private readonly now: () => number;
  private readonly maxPerAgent: number;
  private readonly maxAgents: number;
  private readonly maxPending: number;
  private readonly costFor?: (callId: string) => number | null;

  /** Newest first. Re-set on every write, so key order is least- to most-recently-written. */
  private readonly byAgent = new Map<string, JevDecisionRecord[]>();
  /** FIFO by callId; a spawn hint recorded before its agent exists. */
  private readonly pending = new Map<string, JevDecisionRecord>();

  constructor(options: JevDecisionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxPerAgent = options.maxPerAgent ?? DEFAULT_MAX_PER_AGENT;
    this.maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.costFor = options.costFor;
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
      if (note.agentId === null) this.recordPending(note.callId, record);
      else this.recordForAgent(note.agentId, record);
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
    own.push(
      applied
        ? { ...pendingRecord, ...wouldBe, agentId, applied, action: SPAWN_HINT_APPLIED_ACTION }
        : { ...pendingRecord, ...wouldBe, agentId, applied },
    );
    return own;
  }

  private recordForAgent(agentId: string, record: JevDecisionRecord): void {
    const list = this.byAgent.get(agentId) ?? [];
    list.unshift(record);
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
}
