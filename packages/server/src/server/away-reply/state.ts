import { readFileSync } from "node:fs";
import type { Logger } from "pino";

import type { AgentOperatorSignal } from "../agent/agent-manager.js";
import { writeFileAtomic } from "../atomic-file.js";
import type { AwayReplyWaitKind } from "./detect.js";

/**
 * The away auto-reply's own record (docs/jev.md, "Feature 14"), kept by the daemon in
 * `$PASEO_HOME/jev/away-reply-state.json` (0600) and never in agent labels: `update_agent` lets
 * an agent rewrite its own labels, so a streak or an opt-out kept there could be unlocked by the
 * agent it limits. Survives restarts, so the daily caps do too.
 *
 * Every failure here fails toward sending nothing: a file that cannot be read starts empty, which
 * forgets who Tyler is (so no thread has a Tyler message, and nothing is answered) but never lifts
 * an opt-out that was written, because an unreadable file is kept aside rather than overwritten.
 */

const MAX_ANSWERED = 20;
const MAX_SENT_HASHES = 10;
const MAX_HUMAN_MESSAGE_IDS = 50;
const MAX_FOLLOW_UPS = 200;
const IDLE_ENTRY_MS = 30 * 24 * 60 * 60_000;

export interface AwayReplyAgentState {
  /** Auto-replies since Tyler last acted on this agent from an app client. */
  streak: number;
  lastRepliedAt: number | null;
  /** Episode keys already answered, newest last. */
  answered: string[];
  /** sha256 of each text sent, newest last, to tell our own replies apart in the timeline. */
  sentHashes: string[];
  /** Set the first time the opt-out label is seen. Removing the label does not clear it. */
  optedOutAt: number | null;
  /** `clientMessageId`s of messages Tyler sent from an app client, newest last. */
  humanMessageIds: string[];
  /** Tyler's last message or request answer from an app client. */
  lastHumanAt: number | null;
  lastCanceledAt: number | null;
  lastCancelReason: string | null;
  touchedAt: number;
}

/** An evaluated episode nothing was sent for, waiting to learn what Tyler chose instead. */
export interface AwayReplyFollowUp {
  callId: string | null;
  agentId: string;
  episodeKey: string;
  episode: AwayReplyWaitKind;
  decidedAt: number;
  requestId: string | null;
  would: {
    /** `option`, `recommendation`, `keep-going`, `approve-permission`, or `none`. */
    kind: string;
    optionId: string | null;
  };
  /** The leader's options, so Tyler's answer can be read back as one of them. */
  options: Array<{ id: string; label: string }>;
}

interface AwayReplyStateData {
  v: 1;
  day: string;
  total: number;
  perAgent: Record<string, number>;
  agents: Record<string, AwayReplyAgentState>;
  followUps: AwayReplyFollowUp[];
}

export function localDay(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyAgent(nowMs: number): AwayReplyAgentState {
  return {
    streak: 0,
    lastRepliedAt: null,
    answered: [],
    sentHashes: [],
    optedOutAt: null,
    humanMessageIds: [],
    lastHumanAt: null,
    lastCanceledAt: null,
    lastCancelReason: null,
    touchedAt: nowMs,
  };
}

function emptyData(nowMs: number): AwayReplyStateData {
  return { v: 1, day: localDay(nowMs), total: 0, perAgent: {}, agents: {}, followUps: [] };
}

function pushBounded(list: string[], value: string, max: number): string[] {
  return [...list.filter((entry) => entry !== value), value].slice(-max);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function readAgent(raw: unknown, nowMs: number): AwayReplyAgentState {
  const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    streak: Math.max(0, Math.floor(numberOrNull(entry["streak"]) ?? 0)),
    lastRepliedAt: numberOrNull(entry["lastRepliedAt"]),
    answered: strings(entry["answered"]).slice(-MAX_ANSWERED),
    sentHashes: strings(entry["sentHashes"]).slice(-MAX_SENT_HASHES),
    optedOutAt: numberOrNull(entry["optedOutAt"]),
    humanMessageIds: strings(entry["humanMessageIds"]).slice(-MAX_HUMAN_MESSAGE_IDS),
    lastHumanAt: numberOrNull(entry["lastHumanAt"]),
    lastCanceledAt: numberOrNull(entry["lastCanceledAt"]),
    lastCancelReason:
      typeof entry["lastCancelReason"] === "string" ? entry["lastCancelReason"] : null,
    touchedAt: numberOrNull(entry["touchedAt"]) ?? nowMs,
  };
}

export interface AwayReplyStateOptions {
  filePath: string;
  logger: Logger;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export class AwayReplyState {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private data: AwayReplyStateData;
  private writeChain: Promise<void> = Promise.resolve();
  /** False when the file existed but could not be read: never overwrite what we cannot read. */
  private writable = true;

  constructor(options: AwayReplyStateOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.data = this.load();
  }

  private load(): AwayReplyStateData {
    const nowMs = this.now();
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.writable = false;
        this.logger.warn({ err: error }, "away-reply: state unreadable; nothing will be sent");
      }
      return emptyData(nowMs);
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      const agents: Record<string, AwayReplyAgentState> = {};
      const rawAgents = (raw["agents"] ?? {}) as Record<string, unknown>;
      for (const [id, entry] of Object.entries(rawAgents)) agents[id] = readAgent(entry, nowMs);
      const perAgent: Record<string, number> = {};
      const rawPerAgent = (raw["perAgent"] ?? {}) as Record<string, unknown>;
      for (const [id, count] of Object.entries(rawPerAgent)) {
        const value = numberOrNull(count);
        if (value !== null) perAgent[id] = value;
      }
      return {
        v: 1,
        day: typeof raw["day"] === "string" ? raw["day"] : localDay(nowMs),
        total: numberOrNull(raw["total"]) ?? 0,
        perAgent,
        agents,
        followUps: Array.isArray(raw["followUps"])
          ? (raw["followUps"] as AwayReplyFollowUp[]).slice(-MAX_FOLLOW_UPS)
          : [],
      };
    } catch (error) {
      this.writable = false;
      this.logger.warn({ err: error }, "away-reply: state unparseable; nothing will be sent");
      return emptyData(nowMs);
    }
  }

  /** False when the file could not be read; the job then sends nothing. */
  isUsable(): boolean {
    return this.writable;
  }

  agent(agentId: string): Readonly<AwayReplyAgentState> {
    return this.data.agents[agentId] ?? emptyAgent(this.now());
  }

  private mutate(agentId: string, change: (entry: AwayReplyAgentState) => void): void {
    const nowMs = this.now();
    const entry = this.data.agents[agentId] ?? emptyAgent(nowMs);
    change(entry);
    entry.touchedAt = nowMs;
    this.data.agents[agentId] = entry;
    this.save();
  }

  /** Starts the day's counters over at local midnight. */
  rollDay(nowMs: number): void {
    const day = localDay(nowMs);
    if (this.data.day === day) return;
    this.data.day = day;
    this.data.total = 0;
    this.data.perAgent = {};
    this.save();
  }

  dailyTotal(): number {
    return this.data.total;
  }

  dailyCount(agentId: string): number {
    return this.data.perAgent[agentId] ?? 0;
  }

  recordReply(agentId: string, reply: { at: number; episodeKey: string; textHash: string | null }) {
    this.data.total += 1;
    this.data.perAgent[agentId] = (this.data.perAgent[agentId] ?? 0) + 1;
    this.mutate(agentId, (entry) => {
      entry.streak += 1;
      entry.lastRepliedAt = reply.at;
      entry.answered = pushBounded(entry.answered, reply.episodeKey, MAX_ANSWERED);
      if (reply.textHash) {
        entry.sentHashes = pushBounded(entry.sentHashes, reply.textHash, MAX_SENT_HASHES);
      }
    });
  }

  recordOptOut(agentId: string): void {
    if (this.agent(agentId).optedOutAt !== null) return;
    this.mutate(agentId, (entry) => {
      entry.optedOutAt = this.now();
    });
  }

  /** Applies one of the agent manager's operator signals. */
  recordSignal(signal: AgentOperatorSignal): void {
    const at = signal.at.getTime();
    this.mutate(signal.agentId, (entry) => {
      if (signal.kind === "turn-canceled") {
        entry.lastCanceledAt = at;
        entry.lastCancelReason = signal.reason;
        return;
      }
      entry.streak = 0;
      entry.lastHumanAt = Math.max(entry.lastHumanAt ?? 0, at);
      if (signal.kind === "human-prompt" && signal.clientMessageId) {
        entry.humanMessageIds = pushBounded(
          entry.humanMessageIds,
          signal.clientMessageId,
          MAX_HUMAN_MESSAGE_IDS,
        );
      }
    });
  }

  /**
   * A failover successor takes over its predecessor's record, so moving an agent to another
   * account neither resets its streak and caps nor forgets who Tyler is.
   */
  inherit(fromId: string, toId: string): void {
    const from = this.data.agents[fromId];
    if (!from || fromId === toId) return;
    const count = this.data.perAgent[fromId] ?? 0;
    this.data.perAgent[toId] = Math.max(this.data.perAgent[toId] ?? 0, count);
    this.mutate(toId, (entry) => {
      entry.streak = Math.max(entry.streak, from.streak);
      entry.lastRepliedAt = Math.max(entry.lastRepliedAt ?? 0, from.lastRepliedAt ?? 0) || null;
      entry.optedOutAt = entry.optedOutAt ?? from.optedOutAt;
      entry.lastHumanAt = Math.max(entry.lastHumanAt ?? 0, from.lastHumanAt ?? 0) || null;
      for (const id of from.humanMessageIds) {
        entry.humanMessageIds = pushBounded(entry.humanMessageIds, id, MAX_HUMAN_MESSAGE_IDS);
      }
      for (const hash of from.sentHashes) {
        entry.sentHashes = pushBounded(entry.sentHashes, hash, MAX_SENT_HASHES);
      }
    });
  }

  addFollowUp(followUp: AwayReplyFollowUp): void {
    this.data.followUps = [
      ...this.data.followUps.filter((entry) => entry.episodeKey !== followUp.episodeKey),
      followUp,
    ].slice(-MAX_FOLLOW_UPS);
    this.save();
  }

  followUps(): readonly AwayReplyFollowUp[] {
    return this.data.followUps;
  }

  removeFollowUp(episodeKey: string): void {
    this.data.followUps = this.data.followUps.filter((entry) => entry.episodeKey !== episodeKey);
    this.save();
  }

  /** Drops records of agents gone for a month. */
  prune(liveAgentIds: ReadonlySet<string>): void {
    const horizon = this.now() - IDLE_ENTRY_MS;
    let changed = false;
    for (const [id, entry] of Object.entries(this.data.agents)) {
      if (!liveAgentIds.has(id) && entry.touchedAt < horizon) {
        delete this.data.agents[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Resolves once every write queued so far has landed. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private save(): void {
    if (!this.writable) return;
    const text = `${JSON.stringify(this.data)}\n`;
    this.writeChain = this.writeChain.then(() =>
      writeFileAtomic(
        this.filePath,
        text,
        this.platform === "win32" ? undefined : { mode: 0o600 },
      ).catch((error: unknown) => {
        this.logger.warn({ err: error }, "away-reply: state write failed");
      }),
    );
  }
}
