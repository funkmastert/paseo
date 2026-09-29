import { promises as fs } from "node:fs";
import type { Logger } from "pino";
import { z } from "zod";

import { writeFileAtomic } from "../atomic-file.js";
import type { JevCost, JevDaySpend, JevFeatureId, JevLane, JevSpendTotals } from "./contract.js";

/**
 * Per-call entries and daily spend totals (docs/jev.md, "Ledger"). Only totals are persisted —
 * `record()` keeps a ring of the newest entries in memory for `find`/`entries`, but the file on
 * disk never carries an entry, a verdict, an agent id or a call site.
 */

const HOUR_MS = 60 * 60_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_RING_SIZE = 2000;
const DEFAULT_RETAIN_DAYS = 30;

const KNOWN_FEATURES = new Set<JevFeatureId>([
  "spawnHint",
  "remediationTriage",
  "notificationTriage",
  "agentTools",
  "compactionTiming",
  "stallJudgment",
  "awayReply",
]);
const KNOWN_LANES = new Set<JevLane>(["control", "agentTools"]);

function isJevFeatureId(value: string): value is JevFeatureId {
  return KNOWN_FEATURES.has(value as JevFeatureId);
}

function isJevLane(value: string): value is JevLane {
  return KNOWN_LANES.has(value as JevLane);
}

export interface JevLedgerEntry {
  callId: string;
  /** ISO. */
  at: string;
  feature: JevFeatureId;
  lane: JevLane;
  callSite: string;
  subjectAgentIds: string[];
  outcome: "answered" | "shadow" | "unavailable" | "failed";
  reason: string | null;
  exclusionSignal: string | null;
  model: string | null;
  attempts: number;
  elapsedMs: number;
  stateBytes: number;
  bodyBytes: number;
  redactions: number;
  questionCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: JevCost;
  /** "task_class: mechanical 0.91" */
  verdicts: string[];
  /** Counts toward `agentTools.maxUsdPerAgentPerHour`. */
  chargedAgentId: string | null;
}

export interface JevBudgetExhaustedEvent {
  lane: JevLane;
  topFeature: JevFeatureId | null;
  resetsAt: Date;
}

export interface JevLedgerOptions {
  /** `$PASEO_HOME/jev/ledger.json`. */
  filePath: string;
  logger: Logger;
  now?: () => number;
  writeFile?: (filePath: string, data: string) => Promise<void>;
  flushIntervalMs?: number;
  ringSize?: number;
  retainDays?: number;
  onBudgetExhausted?: (event: JevBudgetExhaustedEvent) => void;
}

interface InternalTotals {
  calls: number;
  answered: number;
  failed: number;
  unavailable: number;
  inputTokens: number;
  usd: number;
  hasReported: boolean;
  hasEstimated: boolean;
}

interface DayRecord {
  byFeature: Partial<Record<JevFeatureId, InternalTotals>>;
  byLane: Partial<Record<JevLane, InternalTotals>>;
  exhausted: Set<JevLane>;
}

const TOTALS_SCHEMA = z.object({
  calls: z.number(),
  answered: z.number(),
  failed: z.number(),
  unavailable: z.number(),
  inputTokens: z.number(),
  usd: z.number(),
  hasReported: z.boolean(),
  hasEstimated: z.boolean(),
});
const DAY_SCHEMA = z.object({
  byFeature: z.record(z.string(), TOTALS_SCHEMA),
  byLane: z.record(z.string(), TOTALS_SCHEMA),
  exhausted: z.array(z.string()),
});
const LEDGER_FILE_SCHEMA = z.object({
  version: z.literal(1),
  days: z.record(z.string(), DAY_SCHEMA),
});

function emptyTotals(): InternalTotals {
  return {
    calls: 0,
    answered: 0,
    failed: 0,
    unavailable: 0,
    inputTokens: 0,
    usd: 0,
    hasReported: false,
    hasEstimated: false,
  };
}

function applyEntry(totals: InternalTotals, entry: JevLedgerEntry): void {
  totals.calls += 1;
  if (entry.outcome === "answered" || entry.outcome === "shadow") totals.answered += 1;
  else if (entry.outcome === "failed") totals.failed += 1;
  else if (entry.outcome === "unavailable") totals.unavailable += 1;
  totals.inputTokens += entry.inputTokens;
  if (entry.cost.usd !== null) {
    totals.usd += entry.cost.usd;
    // "fake" counts as reported (docs/jev.md, "Ledger").
    if (entry.cost.source === "estimated") totals.hasEstimated = true;
    else totals.hasReported = true;
  }
}

function usdSourceOf(totals: InternalTotals): JevSpendTotals["usdSource"] {
  if (totals.hasReported && totals.hasEstimated) return "mixed";
  if (totals.hasReported) return "reported";
  if (totals.hasEstimated) return "estimated";
  return "none";
}

function toPublicTotals(totals: InternalTotals | undefined): JevSpendTotals {
  const source = totals ?? emptyTotals();
  return {
    calls: source.calls,
    answered: source.answered,
    failed: source.failed,
    unavailable: source.unavailable,
    inputTokens: source.inputTokens,
    usd: source.usd,
    usdSource: usdSourceOf(source),
  };
}

/** The daemon's local calendar day, `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The local midnight strictly after `date`. */
export function nextLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0);
}

export class JevLedger {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly writeFile: (filePath: string, data: string) => Promise<void>;
  private readonly flushIntervalMs: number;
  private readonly ringSize: number;
  private readonly retainDays: number;
  private readonly onBudgetExhausted?: (event: JevBudgetExhaustedEvent) => void;

  private readonly days = new Map<string, DayRecord>();
  private readonly ring: JevLedgerEntry[] = [];
  private readonly byId = new Map<string, JevLedgerEntry>();
  private readonly agentCharges = new Map<string, Array<{ at: number; usd: number }>>();
  private readonly featureLaneOf = new Map<JevFeatureId, JevLane>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(options: JevLedgerOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger.child({ module: "jev-ledger" });
    this.now = options.now ?? Date.now;
    this.writeFile =
      options.writeFile ?? ((filePath, data) => writeFileAtomic(filePath, data, { mode: 0o600 }));
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
    this.retainDays = options.retainDays ?? DEFAULT_RETAIN_DAYS;
    this.onBudgetExhausted = options.onBudgetExhausted;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    let parsed: z.infer<typeof LEDGER_FILE_SCHEMA>;
    try {
      parsed = LEDGER_FILE_SCHEMA.parse(JSON.parse(text));
    } catch (error) {
      this.logger.warn(
        { err: error, filePath: this.filePath },
        "jev: ledger file unreadable, starting empty",
      );
      return;
    }
    for (const [day, record] of Object.entries(parsed.days)) {
      const byFeature: Partial<Record<JevFeatureId, InternalTotals>> = {};
      for (const [feature, totals] of Object.entries(record.byFeature)) {
        if (isJevFeatureId(feature)) byFeature[feature] = totals;
      }
      const byLane: Partial<Record<JevLane, InternalTotals>> = {};
      for (const [lane, totals] of Object.entries(record.byLane)) {
        if (isJevLane(lane)) byLane[lane] = totals;
      }
      this.days.set(day, {
        byFeature,
        byLane,
        exhausted: new Set(record.exhausted.filter(isJevLane)),
      });
    }
  }

  record(entry: JevLedgerEntry): void {
    this.ring.push(entry);
    this.byId.set(entry.callId, entry);
    if (this.ring.length > this.ringSize) {
      const evicted = this.ring.shift();
      if (evicted) this.byId.delete(evicted.callId);
    }
    this.featureLaneOf.set(entry.feature, entry.lane);

    const today = this.today();
    const record = this.dayRecord(today);
    applyEntry(this.totalsFor(record.byFeature, entry.feature), entry);
    applyEntry(this.totalsFor(record.byLane, entry.lane), entry);
    if (entry.chargedAgentId && entry.cost.usd !== null) {
      this.chargeAgent(entry.chargedAgentId, entry.cost.usd);
    }
    this.pruneOldDays(today);

    this.dirty = true;
    this.scheduleFlush();
  }

  spentTodayUsd(lane: JevLane): number {
    return this.days.get(this.today())?.byLane[lane]?.usd ?? 0;
  }

  spentByAgentLastHourUsd(agentId: string): number {
    const charges = this.agentCharges.get(agentId);
    if (!charges) return 0;
    const horizon = this.now() - HOUR_MS;
    let total = 0;
    for (const charge of charges) {
      if (charge.at >= horizon) total += charge.usd;
    }
    return total;
  }

  laneTotalsToday(lane: JevLane): JevSpendTotals {
    return toPublicTotals(this.days.get(this.today())?.byLane[lane]);
  }

  featureTotalsToday(feature: JevFeatureId): JevSpendTotals {
    return toPublicTotals(this.days.get(this.today())?.byFeature[feature]);
  }

  last7Days(): JevDaySpend[] {
    const result: JevDaySpend[] = [];
    const today = new Date(this.now());
    for (let offset = 6; offset >= 0; offset -= 1) {
      const day = localDay(addLocalDays(today, -offset));
      const record = this.days.get(day);
      const control = record?.byLane.control;
      const agentTools = record?.byLane.agentTools;
      result.push({
        day,
        calls: (control?.calls ?? 0) + (agentTools?.calls ?? 0),
        usd: (control?.usd ?? 0) + (agentTools?.usd ?? 0),
      });
    }
    return result;
  }

  markExhausted(lane: JevLane): void {
    const record = this.dayRecord(this.today());
    if (record.exhausted.has(lane)) return;
    record.exhausted.add(lane);
    this.dirty = true;
    this.scheduleFlush();

    const topFeature = this.topFeatureFor(lane, record);
    const resetsAt = nextLocalMidnight(new Date(this.now()));
    try {
      this.onBudgetExhausted?.({ lane, topFeature, resetsAt });
    } catch (error) {
      this.logger.warn({ err: error, lane }, "jev: onBudgetExhausted threw");
    }
  }

  isExhausted(lane: JevLane): boolean {
    return this.days.get(this.today())?.exhausted.has(lane) ?? false;
  }

  find(callId: string): JevLedgerEntry | null {
    return this.byId.get(callId) ?? null;
  }

  entries(): readonly JevLedgerEntry[] {
    return [...this.ring];
  }

  /** Persists everything dirty. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.writeFile(this.filePath, JSON.stringify(this.toPersisted()));
    } catch (error) {
      this.logger.warn({ err: error, filePath: this.filePath }, "jev: ledger flush failed");
    }
  }

  async stop(): Promise<void> {
    await this.flush();
  }

  private today(): string {
    return localDay(new Date(this.now()));
  }

  private dayRecord(day: string): DayRecord {
    let record = this.days.get(day);
    if (!record) {
      record = { byFeature: {}, byLane: {}, exhausted: new Set() };
      this.days.set(day, record);
    }
    return record;
  }

  private totalsFor<K extends string>(
    map: Partial<Record<K, InternalTotals>>,
    key: K,
  ): InternalTotals {
    let totals = map[key];
    if (!totals) {
      totals = emptyTotals();
      map[key] = totals;
    }
    return totals;
  }

  private chargeAgent(agentId: string, usd: number): void {
    const at = this.now();
    const horizon = at - HOUR_MS;
    const charges = (this.agentCharges.get(agentId) ?? []).filter((charge) => charge.at >= horizon);
    charges.push({ at, usd });
    this.agentCharges.set(agentId, charges);
  }

  private topFeatureFor(lane: JevLane, record: DayRecord): JevFeatureId | null {
    let best: JevFeatureId | null = null;
    let bestUsd = -Infinity;
    for (const [feature, totals] of Object.entries(record.byFeature) as Array<
      [JevFeatureId, InternalTotals]
    >) {
      if (this.featureLaneOf.get(feature) !== lane) continue;
      if (totals.usd > bestUsd) {
        bestUsd = totals.usd;
        best = feature;
      }
    }
    return best;
  }

  private pruneOldDays(today: string): void {
    const horizon = localDay(addLocalDays(new Date(this.now()), -(this.retainDays - 1)));
    for (const day of this.days.keys()) {
      if (day < horizon && day !== today) this.days.delete(day);
    }
  }

  private toPersisted(): { version: 1; days: Record<string, z.infer<typeof DAY_SCHEMA>> } {
    const days: Record<string, z.infer<typeof DAY_SCHEMA>> = {};
    for (const [day, record] of this.days) {
      days[day] = {
        byFeature: record.byFeature as Record<string, InternalTotals>,
        byLane: record.byLane as Record<string, InternalTotals>,
        exhausted: [...record.exhausted],
      };
    }
    return { version: 1, days };
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const timer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    timer.unref?.();
    this.flushTimer = timer;
  }
}
