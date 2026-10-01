import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { writeFileAtomic } from "../atomic-file.js";
import { createJsonlAppender, type JsonlAppender } from "../jsonl-appender.js";
import type {
  JevFeatureState,
  JevFileReadEvent,
  JevNotAskedReason,
  JevOtherBenefit,
  JevOutcome,
  JevSavingsDay,
  JevSavingsDecision,
  JevSavingsEvent,
  JevSavingsEventsPage,
  JevSavingsEventsQuery,
  JevSavingsFeature,
  JevSavingsFeatureSummary,
  JevSavingsInput,
  JevSavingsLine,
  JevSavingsMode,
  JevSavingsModeTotals,
  JevSavingsRange,
  JevSavingsReader,
  JevSavingsRecord,
  JevSavingsSink,
  JevSavingsSummary,
  JevSavingsTopEntry,
  JevSavingsValidation,
} from "./contract.js";
import { localDay, type JevLedgerEntry } from "./ledger.js";
import {
  evaluateEvidence,
  evidenceCounters,
  JEV_SAVINGS_BENEFIT,
  JEV_SAVINGS_UNIT,
  priceSavings,
  usdToOpusTokens,
  type JevSavingsFacts,
  type JevSavingsPrice,
} from "./savings-formulas.js";

/**
 * The savings ledger (docs/jev.md, "Savings"): one append-only record per JEV involvement, across
 * every feature, in `$PASEO_HOME/jev/savings.jsonl`, plus a per-day rollup in `savings-days.json`
 * that outlives the file. Every write is off the caller's path and never throws. The JEV dashboard
 * reads this module and nothing else.
 */

const FILE_NAME = "savings.jsonl";
/** `createJsonlAppender` rotates to `<file>.1`. */
const ROTATED_FILE_NAME = "savings.jsonl.1";
const ROLLUP_FILE_NAME = "savings-days.json";
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_BYTES = 16_000_000;
const DEFAULT_FILE_RETAIN_DAYS = 30;
const DEFAULT_ROLLUP_RETAIN_DAYS = 400;
const DEFAULT_MEMORY_RECORDS = 5_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_PENDING_MAX_MS = 7 * DAY_MS;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60_000;
const ROLLUP_TOP_ENTRIES = 50;
const SUMMARY_TOP_ENTRIES = 10;
const EVENTS_DEFAULT_LIMIT = 50;
const EVENTS_MAX_LIMIT = 200;
/** An agent-tool record's regret window, kept in its facts so a restart rebuilds it. */
const REGRET_PATHS_FACT = "regretPaths";
const REGRET_WINDOW_FACT = "regretWindowMs";

/** The dashboard's feature order: the budget strip's, with feature 16 added. */
export const JEV_SAVINGS_FEATURE_ORDER: readonly JevSavingsFeature[] = [
  "spawnHint",
  "remediationTriage",
  "notificationTriage",
  "agentTools",
  "compactionTiming",
  "stallJudgment",
  "awayReply",
  "askJev",
  "readCheck",
];

const KNOWN_FEATURES = new Set<string>(JEV_SAVINGS_FEATURE_ORDER);

interface ModeAgg {
  involvements: number;
  changed: number;
  tokens: number;
  other: JevOtherBenefit | null;
  pending: number;
}

interface FeatureAgg {
  asked: number;
  notAsked: Partial<Record<JevNotAskedReason, number>>;
  live: ModeAgg;
  shadow: ModeAgg;
  validation: { checked: number; held: number; wrong: number };
  jevUsd: number;
  counters: Record<string, number>;
}

interface Tally {
  involvements: number;
  liveTokens: number;
  shadowTokens: number;
}

interface DayAgg {
  features: Partial<Record<string, FeatureAgg>>;
  agents: Record<string, Tally>;
  workspaces: Record<string, Tally>;
  /** The JEV ledger's spend for the day, every lane; copied while the ledger still holds it. */
  spend: { calls: number; usd: number } | null;
}

interface Folded {
  id: string;
  at: string;
  atMs: number;
  day: string;
  feature: JevSavingsFeature;
  callSite: string;
  callId: string;
  agentId: string | null;
  workspaceId: string | null;
  mode: JevSavingsMode;
  outcome: JevOutcome["kind"];
  involvement: string;
  decision: JevSavingsDecision;
  facts: JevSavingsFacts;
  price: JevSavingsPrice;
  validation: JevSavingsValidation | null;
  jevCostUsd: number | null;
}

/** What `record` takes from the JEV ledger, or what an adapter supplies when it has no `callId`. */
export interface JevSavingsObserved {
  mode: JevSavingsMode;
  outcome: JevOutcome["kind"];
  /** ISO; defaults to now. */
  at?: string;
  jevCostUsd: number | null;
}

interface ReadWatch {
  savingsId: string;
  agentId: string;
  paths: Set<string>;
  startedMs: number;
  untilMs: number;
}

export interface JevSavingsLedgerOptions {
  /** `$PASEO_HOME/jev`. */
  dir: string;
  logger: Logger;
  /** The JEV ledger's entry for a call, while it still holds it. */
  findCall: (callId: string) => JevLedgerEntry | null;
  /** Every day the JEV ledger holds, with its spend. */
  daySpends?: () => Array<{ day: string; calls: number; usd: number }>;
  /** The state the dashboard shows for a feature. */
  featureState?: (feature: JevSavingsFeature) => JevFeatureState;
  /** Whether a feature runs in shadow now, for the mode of a call that failed after sending. */
  featureShadow?: (feature: JevSavingsFeature) => boolean;
  /** Read at request time; null for an agent the daemon no longer holds. */
  agentTitle?: (agentId: string) => string | null;
  workspaceLabel?: (workspaceId: string) => string | null;
  /** Fills `workspaceId` for a record that names only an agent. */
  workspaceOf?: (agentId: string) => string | null;
  now?: () => number;
  platform?: NodeJS.Platform;
  maxBytes?: number;
  fileRetainDays?: number;
  rollupRetainDays?: number;
  memoryRecords?: number;
  flushIntervalMs?: number;
  pendingMaxMs?: number;
  sweepIntervalMs?: number;
}

function emptyMode(): ModeAgg {
  return { involvements: 0, changed: 0, tokens: 0, other: null, pending: 0 };
}

function emptyFeature(): FeatureAgg {
  return {
    asked: 0,
    notAsked: {},
    live: emptyMode(),
    shadow: emptyMode(),
    validation: { checked: 0, held: 0, wrong: 0 },
    jevUsd: 0,
    counters: {},
  };
}

function emptyDay(): DayAgg {
  return { features: {}, agents: {}, workspaces: {}, spend: null };
}

function emptyTally(): Tally {
  return { involvements: 0, liveTokens: 0, shadowTokens: 0 };
}

function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 0, 0, 0, 0);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The savings ledger. Implements the sink every call site writes to and the reader the two RPCs
 * serve. `record` fills mode, outcome, time and cost from the JEV ledger's entry for the call.
 */
export class JevSavingsLedger implements JevSavingsSink, JevSavingsReader {
  private readonly options: JevSavingsLedgerOptions;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly filePath: string;
  private readonly rotatedPath: string;
  private readonly rollupPath: string;
  private readonly isWindows: boolean;
  private readonly memoryRecords: number;
  private readonly pendingMaxMs: number;
  private appender: JsonlAppender | null = null;

  /** Newest last. The newest `memoryRecords` records plus every pending one. */
  private records: Folded[] = [];
  private readonly byId = new Map<string, Folded>();
  /** Every record the file holds, for `idForCall` and the one-record-per-call rule. */
  private readonly byCall = new Map<string, string>();
  private readonly days = new Map<string, DayAgg>();
  private readonly watches = new Map<string, ReadWatch[]>();
  private readonly missingLogged = new Set<string>();
  private lastNoteReadMs = 0;
  private loaded = false;
  private readonly beforeLoad: Array<() => void> = [];
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private lastIdMs = 0;
  private idSeq = 0;

  constructor(options: JevSavingsLedgerOptions) {
    this.options = options;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.filePath = path.join(options.dir, FILE_NAME);
    this.rotatedPath = path.join(options.dir, ROTATED_FILE_NAME);
    this.rollupPath = path.join(options.dir, ROLLUP_FILE_NAME);
    this.isWindows = (options.platform ?? process.platform) === "win32";
    this.memoryRecords = options.memoryRecords ?? DEFAULT_MEMORY_RECORDS;
    this.pendingMaxMs = options.pendingMaxMs ?? DEFAULT_PENDING_MAX_MS;
  }

  /** Reads the rollup and the file, prunes old lines, rebuilds the recent days. Never throws. */
  async load(): Promise<void> {
    try {
      await this.loadUnguarded();
    } catch (error) {
      this.logger.warn({ err: error }, "jev savings: load failed; starting empty");
    }
    this.appender = createJsonlAppender({
      filePath: this.filePath,
      maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES,
      logger: this.logger,
      platform: this.options.platform,
    });
    this.loaded = true;
    this.rebuildWatches();
    for (const run of this.beforeLoad.splice(0)) run();
    this.sweep();
    const flushEvery = this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushTimer = setInterval(() => void this.flush(), flushEvery);
    this.flushTimer.unref?.();
    this.sweepTimer = setInterval(
      () => this.sweep(),
      this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.flushTimer = null;
    this.sweepTimer = null;
    this.dirty = true;
    await this.flush();
    await this.appender?.flush();
  }

  // ---- the sink ----

  record(input: JevSavingsInput): string {
    try {
      const entry = this.options.findCall(input.callId);
      if (!entry) {
        this.logMissing(
          input.callId,
          input.feature,
          "jev savings: the ledger holds no entry for this call; record dropped",
        );
        return "";
      }
      if (entry.outcome === "unavailable") {
        this.countNotAsked(input.feature, entry.reason === "excluded" ? "excluded" : "inactive");
        return "";
      }
      // Stopped before sending (redaction, a size check): nothing reached JEV.
      if (entry.outcome === "failed" && entry.attempts === 0) return "";
      const mode = this.modeOf(entry, input.feature);
      return this.recordObserved(input, {
        mode,
        outcome: entry.outcome,
        at: entry.at,
        jevCostUsd: entry.cost.usd,
      });
    } catch (error) {
      this.logger.warn({ err: error, feature: input.feature }, "jev savings: record failed");
      return "";
    }
  }

  /**
   * `record` with mode, outcome and cost supplied rather than read off the JEV ledger: for an
   * adapter whose source names no single `callId` (the agent tools' `tool-use.jsonl`). Idempotent
   * per `callId`.
   */
  recordObserved(input: JevSavingsInput, observed: JevSavingsObserved): string {
    try {
      const existing = this.byCall.get(input.callId);
      if (existing) return existing;
      const nowMs = this.now();
      const atMs = observed.at ? Date.parse(observed.at) : nowMs;
      const at = new Date(Number.isFinite(atMs) ? atMs : nowMs);
      const id = this.newId(nowMs);
      const facts: JevSavingsFacts = { ...input.decision.detail, ...input.facts };
      const agentId = input.agentId ?? null;
      const workspaceId =
        input.workspaceId ??
        (agentId ? this.safe(() => this.options.workspaceOf?.(agentId) ?? null, null) : null);
      const folded: Folded = {
        id,
        at: at.toISOString(),
        atMs: at.getTime(),
        day: localDay(at),
        feature: input.feature,
        callSite: input.callSite,
        callId: input.callId,
        agentId,
        workspaceId,
        mode: observed.mode,
        outcome: observed.outcome,
        involvement: input.involvement,
        decision: { ...input.decision, detail: facts },
        facts,
        price: {
          benefit: JEV_SAVINGS_BENEFIT[input.feature] ?? "none",
          tokens: null,
          otherBenefit: null,
          basis: null,
          pending: false,
        },
        validation: null,
        jevCostUsd: observed.jevCostUsd,
      };
      folded.price = this.priceOf(folded);
      this.byCall.set(input.callId, id);
      this.whenLoaded(() => {
        this.insert(folded);
        this.append(this.involvementLine(folded));
      });
      return id;
    } catch (error) {
      this.logger.warn({ err: error, feature: input.feature }, "jev savings: record failed");
      return "";
    }
  }

  settle(id: string, facts: JevSavingsFacts): void {
    this.whenLoaded(() => {
      try {
        const folded = this.byId.get(id);
        if (!folded) {
          this.logMissing(id, null, "jev savings: settle for a record not in memory; dropped");
          return;
        }
        this.mutate(folded, () => {
          folded.facts = { ...folded.facts, ...facts };
        });
        this.append({
          v: 1,
          type: "settled",
          id,
          at: new Date(this.now()).toISOString(),
          tokensSavedEstimate: folded.price.tokens,
          otherBenefit: folded.price.otherBenefit,
          basis: folded.price.basis,
          facts,
          ...(folded.price.pending ? { pending: true } : {}),
        });
      } catch (error) {
        this.logger.warn({ err: error }, "jev savings: settle failed");
      }
    });
  }

  validate(id: string, validation: JevSavingsValidation): void {
    this.whenLoaded(() => {
      try {
        const folded = this.byId.get(id);
        if (!folded) {
          this.logMissing(id, null, "jev savings: validation for a record not in memory; dropped");
          return;
        }
        if (folded.validation) return;
        this.mutate(folded, () => {
          folded.validation = validation;
        });
        this.dropWatches(id);
        this.append({
          v: 1,
          type: "validated",
          id,
          at: new Date(this.now()).toISOString(),
          validation,
        });
      } catch (error) {
        this.logger.warn({ err: error }, "jev savings: validate failed");
      }
    });
  }

  countNotAsked(feature: JevSavingsFeature, reason: JevNotAskedReason): void {
    this.whenLoaded(() => {
      try {
        const f = this.featureAgg(this.dayAgg(localDay(new Date(this.now()))), feature);
        f.notAsked[reason] = (f.notAsked[reason] ?? 0) + 1;
        this.dirty = true;
      } catch {
        // Counting never breaks a caller.
      }
    });
  }

  noteRead(event: JevFileReadEvent): void {
    this.whenLoaded(() => {
      try {
        const atMs = Date.parse(event.at);
        this.lastNoteReadMs = Math.max(
          this.lastNoteReadMs,
          Number.isFinite(atMs) ? atMs : this.now(),
        );
        const watches = this.watches.get(event.agentId);
        if (!watches) return;
        for (const watch of watches) {
          if (!watch.paths.has(event.path)) continue;
          if (Number.isFinite(atMs) && (atMs < watch.startedMs || atMs > watch.untilMs)) continue;
          this.validate(watch.savingsId, {
            outcome: "regret",
            signal: "reread",
            afterMinutes:
              Math.round(((Number.isFinite(atMs) ? atMs : this.now()) - watch.startedMs) / 6_000) /
              10,
          });
        }
      } catch {
        // Never breaks the observer.
      }
    });
  }

  // ---- joins for hooks and adapters ----

  /** The savings id recorded for a JEV call, or null. Survives a restart: the file is the index. */
  idForCall(callId: string): string | null {
    return this.byCall.get(callId) ?? null;
  }

  /** The facts a record holds now, or null when it is not in memory. */
  factsOf(id: string): Readonly<JevSavingsFacts> | null {
    return this.byId.get(id)?.facts ?? null;
  }

  /** In-memory records still pending, for a hook rebuilding its joins after a restart. */
  pendingRecords(feature: JevSavingsFeature): Array<{
    id: string;
    callId: string;
    agentId: string | null;
    atMs: number;
    facts: Readonly<JevSavingsFacts>;
  }> {
    return this.records
      .filter((record) => record.feature === feature && record.price.pending)
      .map((record) => ({
        id: record.id,
        callId: record.callId,
        agentId: record.agentId,
        atMs: record.atMs,
        facts: record.facts,
      }));
  }

  /**
   * Watches an agent's reads of `paths` for `windowMs` (features 4-6): a `noteRead` of one is a
   * `regret`. A window that closes while feature 16's observer is reporting reads is `held`; with
   * no observer reporting, it closes with no validation, because nothing could have seen a regret.
   */
  watchReads(savingsId: string, agentId: string, paths: readonly string[], windowMs: number): void {
    if (!savingsId || paths.length === 0) return;
    this.whenLoaded(() => {
      const folded = this.byId.get(savingsId);
      // The watch lives on the record, so a restart rebuilds it (`rebuildWatches`).
      if (folded && typeof folded.facts[REGRET_PATHS_FACT] !== "string") {
        this.settle(savingsId, {
          [REGRET_PATHS_FACT]: JSON.stringify(paths),
          [REGRET_WINDOW_FACT]: windowMs,
        });
      }
      this.addWatch(savingsId, agentId, paths, folded?.atMs ?? this.now(), windowMs);
    });
  }

  /**
   * One regret window from the tool call's time. The paths are matched as given and as their real
   * paths: feature 16 reports a read by its real path, and `/var`, `/tmp` and a symlinked worktree
   * name the same file two ways.
   */
  private addWatch(
    savingsId: string,
    agentId: string,
    paths: readonly string[],
    startedMs: number,
    windowMs: number,
  ): void {
    const watch: ReadWatch = {
      savingsId,
      agentId,
      paths: new Set(paths),
      startedMs,
      untilMs: startedMs + windowMs,
    };
    const list = this.watches.get(agentId) ?? [];
    list.push(watch);
    this.watches.set(agentId, list);
    void this.addRealPaths(watch, paths);
  }

  private async addRealPaths(watch: ReadWatch, paths: readonly string[]): Promise<void> {
    const real = await Promise.all(
      paths.map((filePath) => fs.realpath(filePath).catch(() => null)),
    );
    for (const filePath of real) if (filePath) watch.paths.add(filePath);
  }

  /** The regret windows of the agent-tool records still pending, after a restart. */
  private rebuildWatches(): void {
    for (const record of this.records) {
      if (record.feature !== "agentTools" || !record.price.pending || !record.agentId) continue;
      const paths = parsePaths(record.facts[REGRET_PATHS_FACT]);
      const windowMs = record.facts[REGRET_WINDOW_FACT];
      if (paths.length === 0 || typeof windowMs !== "number") continue;
      this.addWatch(record.id, record.agentId, paths, record.atMs, windowMs);
    }
  }

  // ---- the reader ----

  summary(range: JevSavingsRange): JevSavingsSummary {
    const { from, to, days } = this.rangeDays(range);
    const collected = this.collect(days, range === "all");
    const { features, live, shadow } = this.featureSummaries(collected.features);
    const tokensEquivalent = Math.round(usdToOpusTokens(collected.usd));
    return {
      range,
      from: from.toISOString(),
      to: to.toISOString(),
      unit: JEV_SAVINGS_UNIT,
      live: { involvements: live.involvements, tokensSaved: live.tokens },
      shadow: { involvements: shadow.involvements, tokensWouldSave: shadow.tokens },
      jevSpend: { calls: collected.calls, usd: collected.usd, tokensEquivalent },
      net: {
        live: live.tokens - tokensEquivalent,
        ifLive: live.tokens + shadow.tokens - tokensEquivalent,
      },
      features,
      topAgents: this.topEntries(collected.agents, (id) => this.options.agentTitle?.(id) ?? null),
      topWorkspaces: this.topEntries(
        collected.workspaces,
        (id) => this.options.workspaceLabel?.(id) ?? null,
      ),
      days: collected.dayRows,
    };
  }

  /** The range's days summed: per feature, per agent and workspace, per day, and JEV's spend. */
  private collect(days: string[], onlyDaysWithData: boolean) {
    const features = new Map<string, FeatureAgg>();
    const agents = new Map<string, Tally>();
    const workspaces = new Map<string, Tally>();
    const spendByDay = this.spendByDay();
    const dayRows: JevSavingsDay[] = [];
    let calls = 0;
    let usd = 0;
    for (const day of days) {
      const agg = this.days.get(day);
      const spend = spendByDay.get(day) ?? agg?.spend ?? null;
      calls += spend?.calls ?? 0;
      usd += spend?.usd ?? 0;
      const row = { day, involvements: 0, liveTokens: 0, shadowTokens: 0, jevUsd: spend?.usd ?? 0 };
      if (agg) addDay({ features, agents, workspaces }, agg, row);
      if (onlyDaysWithData && !agg && !spend) continue;
      row.liveTokens = Math.round(row.liveTokens);
      row.shadowTokens = Math.round(row.shadowTokens);
      dayRows.push(row);
    }
    return { features, agents, workspaces, dayRows, calls, usd };
  }

  /** One row per feature, and the live and shadow totals. Shadow is never added to live. */
  private featureSummaries(aggs: Map<string, FeatureAgg>) {
    const features: JevSavingsFeatureSummary[] = [];
    const live = { involvements: 0, tokens: 0 };
    const shadow = { involvements: 0, tokens: 0 };
    for (const feature of this.featureList(aggs)) {
      const f = aggs.get(feature) ?? emptyFeature();
      const benefit = JEV_SAVINGS_BENEFIT[feature] ?? "none";
      const tokenFeature = benefit === "tokens";
      live.involvements += f.live.involvements;
      shadow.involvements += f.shadow.involvements;
      if (tokenFeature) {
        live.tokens += f.live.tokens;
        shadow.tokens += f.shadow.tokens;
      }
      features.push({
        feature,
        state: this.safe(() => this.options.featureState?.(feature) ?? "off", "off"),
        benefit,
        asked: f.asked,
        notAsked: { ...f.notAsked },
        live: modeTotals(f.live, tokenFeature),
        shadow: modeTotals(f.shadow, tokenFeature),
        validation: { ...f.validation },
        jevUsd: f.jevUsd,
        evidence: evaluateEvidence(feature, f.counters, f.jevUsd),
      });
    }
    live.tokens = Math.round(live.tokens);
    shadow.tokens = Math.round(shadow.tokens);
    return { features, live, shadow };
  }

  events(query: JevSavingsEventsQuery): JevSavingsEventsPage {
    const { from } = this.rangeDays(query.range);
    const fromMs = from.getTime();
    const limit = Math.max(
      1,
      Math.min(EVENTS_MAX_LIMIT, Math.floor(query.limit ?? EVENTS_DEFAULT_LIMIT)),
    );
    const workspaces = query.workspaceIds ? new Set(query.workspaceIds) : null;
    const matches: Folded[] = [];
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (record.atMs < fromMs) continue;
      if (query.cursor && record.id >= query.cursor) continue;
      if (query.feature && record.feature !== query.feature) continue;
      if (query.agentId && record.agentId !== query.agentId) continue;
      if (workspaces && (!record.workspaceId || !workspaces.has(record.workspaceId))) continue;
      matches.push(record);
    }
    matches.sort((a, b) => compareIds(b.id, a.id));
    const page = matches.slice(0, limit);
    return {
      events: page.map((record) => this.toEvent(record)),
      nextCursor: matches.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  /** Persists the rollup. Safe to call at any time; never throws. */
  async flush(): Promise<void> {
    if (!this.loaded || !this.dirty) return;
    this.dirty = false;
    try {
      this.refreshSpend();
      this.pruneRollup();
      await writeFileAtomic(
        this.rollupPath,
        JSON.stringify(this.toPersistedRollup()),
        this.isWindows ? {} : { mode: 0o600 },
      );
    } catch (error) {
      this.dirty = true;
      this.logger.warn({ err: error }, "jev savings: rollup flush failed");
    }
  }

  /** Settles records pending past the limit with what they have, and closes read watches. */
  sweep(): void {
    try {
      const nowMs = this.now();
      for (const record of this.records) {
        if (record.price.pending && nowMs - record.atMs >= this.pendingMaxMs) {
          this.settle(record.id, { partial: true });
        }
      }
      for (const [agentId, list] of this.watches) {
        const open = list.filter((watch) => {
          if (watch.untilMs > nowMs) return true;
          // Held only if feature 16's observer reported reads during the window. Otherwise
          // nothing could have seen a regret, and the record gets no figure.
          if (this.lastNoteReadMs >= watch.startedMs) {
            this.validate(watch.savingsId, {
              outcome: "held",
              signal: null,
              afterMinutes: Math.round((watch.untilMs - watch.startedMs) / 60_000),
            });
          } else {
            this.settle(watch.savingsId, { regretWatch: "unobserved" });
          }
          return false;
        });
        if (open.length === 0) this.watches.delete(agentId);
        else this.watches.set(agentId, open);
      }
      this.trimMemory();
      // Copies the JEV ledger's spend into the rollup at least hourly, before it ages out of
      // `ledger.json`, even on a day with no involvement.
      this.dirty = true;
    } catch (error) {
      this.logger.warn({ err: error }, "jev savings: sweep failed");
    }
  }

  // ---- internals ----

  private whenLoaded(run: () => void): void {
    if (this.loaded) run();
    else this.beforeLoad.push(run);
  }

  private safe<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch {
      return fallback;
    }
  }

  /** Shadow is shadow and answered is live; a failure after sending takes the feature's mode. */
  private modeOf(entry: JevLedgerEntry, feature: JevSavingsFeature): JevSavingsMode {
    if (entry.outcome === "shadow") return "shadow";
    if (entry.outcome === "answered") return "live";
    return this.featureShadow(feature) ? "shadow" : "live";
  }

  private featureShadow(feature: JevSavingsFeature): boolean {
    return this.safe(() => this.options.featureShadow?.(feature) ?? true, true);
  }

  private logMissing(key: string, feature: JevSavingsFeature | null, message: string): void {
    if (this.missingLogged.has(key)) return;
    this.missingLogged.add(key);
    if (this.missingLogged.size > 1_000) this.missingLogged.clear();
    this.logger.info({ key, feature }, message);
  }

  /** `sv_` + time, base 36, then a sequence and a random tail: sorts by creation time. */
  private newId(nowMs: number): string {
    if (nowMs === this.lastIdMs) this.idSeq += 1;
    else {
      this.lastIdMs = nowMs;
      this.idSeq = 0;
    }
    const time = nowMs.toString(36).padStart(9, "0");
    const seq = this.idSeq.toString(36).padStart(3, "0");
    const tail = Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .padStart(4, "0");
    return `sv_${time}${seq}${tail}`;
  }

  private priceOf(folded: Folded): JevSavingsPrice {
    return priceSavings({
      feature: folded.feature,
      mode: folded.mode,
      decision: folded.decision,
      facts: folded.facts,
      validation: folded.validation,
    });
  }

  private append(line: JevSavingsLine): void {
    this.appender?.append(line);
  }

  private involvementLine(folded: Folded): JevSavingsRecord {
    return {
      v: 1,
      type: "involvement",
      id: folded.id,
      at: folded.at,
      feature: folded.feature,
      callSite: folded.callSite,
      callId: folded.callId,
      agentId: folded.agentId,
      workspaceId: folded.workspaceId,
      mode: folded.mode,
      outcome: folded.outcome,
      involvement: folded.involvement,
      decision: folded.decision,
      benefit: folded.price.benefit,
      tokensSavedEstimate: folded.price.tokens,
      otherBenefit: folded.price.otherBenefit,
      basis: folded.price.basis,
      pending: folded.price.pending,
      jevCostUsd: folded.jevCostUsd,
    };
  }

  private insert(folded: Folded): void {
    this.records.push(folded);
    this.byId.set(folded.id, folded);
    this.applyContribution(folded, 1);
    this.trimMemory();
  }

  private mutate(folded: Folded, change: () => void): void {
    this.applyContribution(folded, -1);
    change();
    folded.price = this.priceOf(folded);
    this.applyContribution(folded, 1);
  }

  private trimMemory(): void {
    const excess = this.records.length - this.memoryRecords;
    if (excess <= 0) return;
    let toDrop = excess;
    const kept: Folded[] = [];
    for (const record of this.records) {
      if (toDrop > 0 && !record.price.pending) {
        this.byId.delete(record.id);
        toDrop -= 1;
        continue;
      }
      kept.push(record);
    }
    this.records = kept;
  }

  private dropWatches(savingsId: string): void {
    for (const [agentId, list] of this.watches) {
      const open = list.filter((watch) => watch.savingsId !== savingsId);
      if (open.length === 0) this.watches.delete(agentId);
      else if (open.length !== list.length) this.watches.set(agentId, open);
    }
  }

  private dayAgg(day: string): DayAgg {
    let agg = this.days.get(day);
    if (!agg) {
      agg = emptyDay();
      this.days.set(day, agg);
    }
    return agg;
  }

  private featureAgg(day: DayAgg, feature: string): FeatureAgg {
    let agg = day.features[feature];
    if (!agg) {
      agg = emptyFeature();
      day.features[feature] = agg;
    }
    return agg;
  }

  /** Adds (`sign` 1) or removes (-1) what one record contributes to its day. */
  private applyContribution(record: Folded, sign: 1 | -1): void {
    const day = this.dayAgg(record.day);
    contribute(day, record, sign);
    this.dirty = true;
  }

  private rangeDays(range: JevSavingsRange): { from: Date; to: Date; days: string[] } {
    const to = new Date(this.now());
    const today = startOfLocalDay(to);
    let from: Date;
    if (range === "today") from = today;
    else if (range === "7d") from = addLocalDays(today, -6);
    else {
      const retain = this.options.rollupRetainDays ?? DEFAULT_ROLLUP_RETAIN_DAYS;
      const horizon = addLocalDays(today, -(retain - 1));
      const known = [...this.days.keys(), ...this.spendByDay().keys()].sort();
      const oldest = known[0] ? new Date(`${known[0]}T00:00:00`) : today;
      from = oldest > horizon ? oldest : horizon;
    }
    const days: string[] = [];
    for (let cursor = from; cursor <= to; cursor = addLocalDays(cursor, 1))
      days.push(localDay(cursor));
    return { from, to, days };
  }

  private spendByDay(): Map<string, { calls: number; usd: number }> {
    const spends = this.safe(() => this.options.daySpends?.() ?? [], []);
    return new Map(spends.map((spend) => [spend.day, { calls: spend.calls, usd: spend.usd }]));
  }

  private refreshSpend(): void {
    for (const [day, spend] of this.spendByDay()) {
      if (spend.calls === 0 && !this.days.has(day)) continue;
      this.dayAgg(day).spend = spend;
    }
  }

  private featureList(aggs: Map<string, FeatureAgg>): JevSavingsFeature[] {
    const extra = [...aggs.keys()].filter(
      (feature) => !KNOWN_FEATURES.has(feature),
    ) as JevSavingsFeature[];
    return [...JEV_SAVINGS_FEATURE_ORDER, ...extra];
  }

  private topEntries(
    tallies: Map<string, Tally>,
    label: (id: string) => string | null,
  ): JevSavingsTopEntry[] {
    return [...tallies.entries()]
      .filter(([, tally]) => tally.involvements > 0)
      .sort((a, b) => b[1].involvements - a[1].involvements || (a[0] < b[0] ? -1 : 1))
      .slice(0, SUMMARY_TOP_ENTRIES)
      .map(([id, tally]) => ({
        id,
        label: this.safe(() => label(id), null),
        involvements: tally.involvements,
        liveTokens: Math.round(tally.liveTokens),
        shadowTokens: Math.round(tally.shadowTokens),
      }));
  }

  private toEvent(record: Folded): JevSavingsEvent {
    const agentId = record.agentId;
    return {
      id: record.id,
      at: record.at,
      feature: record.feature,
      agentId,
      agentTitle: agentId
        ? this.safe(() => this.options.agentTitle?.(agentId) ?? null, null)
        : null,
      workspaceId: record.workspaceId,
      mode: record.mode,
      outcome: record.outcome,
      involvement: record.involvement,
      decision: { ...record.decision, detail: withoutRegretPaths(record.facts) },
      benefit: record.price.benefit,
      tokensSavedEstimate: record.price.tokens,
      otherBenefit: record.price.otherBenefit,
      basis: record.price.basis,
      pending: record.price.pending,
      validation: record.validation,
      jevCostUsd: record.jevCostUsd,
    };
  }

  private pruneRollup(): void {
    const retain = this.options.rollupRetainDays ?? DEFAULT_ROLLUP_RETAIN_DAYS;
    const horizon = localDay(addLocalDays(new Date(this.now()), -(retain - 1)));
    for (const day of this.days.keys()) if (day < horizon) this.days.delete(day);
  }

  private toPersistedRollup(): { version: 1; days: Record<string, DayAgg> } {
    const days: Record<string, DayAgg> = {};
    for (const [day, agg] of [...this.days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      days[day] = {
        features: agg.features,
        agents: topTallies(agg.agents),
        workspaces: topTallies(agg.workspaces),
        spend: agg.spend,
      };
    }
    return { version: 1, days };
  }

  private async loadUnguarded(): Promise<void> {
    const persisted = await this.readRollup();
    const all = await this.readFile();
    for (const record of all) {
      record.price = this.priceOf(record);
      this.byCall.set(record.callId, record.id);
      const idMs = Number.parseInt(record.id.slice(3, 12), 36);
      if (Number.isFinite(idMs) && idMs > this.lastIdMs) this.lastIdMs = idMs;
    }
    for (const [day, agg] of persisted) this.days.set(day, agg);
    for (const [day, agg] of rebuildDays(persisted, all)) this.days.set(day, agg);
    for (const record of all) {
      this.records.push(record);
      this.byId.set(record.id, record);
    }
    this.trimMemory();
  }

  /** Every record the two files hold, folded, oldest first. Prunes lines past the retention. */
  private async readFile(): Promise<Folded[]> {
    const retainMs = (this.options.fileRetainDays ?? DEFAULT_FILE_RETAIN_DAYS) * DAY_MS;
    const horizonMs = this.now() - retainMs;
    const rotated = await this.readLines(this.rotatedPath);
    const current = await this.readLines(this.filePath);
    const folded = new Map<string, Folded>();
    const keep = (line: unknown): boolean => {
      if (!isRecord(line) || line["v"] !== 1 || typeof line["id"] !== "string") return false;
      if (line["type"] !== "involvement") return folded.has(line["id"]);
      const atMs = Date.parse(String(line["at"]));
      if (!Number.isFinite(atMs) || atMs < horizonMs) return false;
      const record = this.foldInvolvement(line);
      if (record) folded.set(record.id, record);
      return record !== null;
    };
    const keptRotated = rotated.lines.filter(keep);
    const keptCurrent = current.lines.filter(keep);
    for (const line of [...keptRotated, ...keptCurrent]) this.foldLater(folded, line);
    // Prune at boot: rewrite a file that lost lines (older than the retention, or malformed).
    if (keptRotated.length !== rotated.lines.length || rotated.malformed > 0) {
      await this.rewrite(this.rotatedPath, keptRotated);
    }
    if (keptCurrent.length !== current.lines.length || current.malformed > 0) {
      await this.rewrite(this.filePath, keptCurrent);
    }
    return [...folded.values()].sort((a, b) => compareIds(a.id, b.id));
  }

  private foldInvolvement(line: Record<string, unknown>): Folded | null {
    const feature = line["feature"];
    const decision = line["decision"];
    const callId = line["callId"];
    if (typeof feature !== "string" || !isRecord(decision) || typeof callId !== "string")
      return null;
    const at = new Date(String(line["at"]));
    const detail = isRecord(decision["detail"]) ? (decision["detail"] as JevSavingsFacts) : {};
    const mode = line["mode"] === "live" ? "live" : "shadow";
    return {
      id: String(line["id"]),
      at: at.toISOString(),
      atMs: at.getTime(),
      day: localDay(at),
      feature: feature as JevSavingsFeature,
      callSite: typeof line["callSite"] === "string" ? line["callSite"] : "",
      callId,
      agentId: typeof line["agentId"] === "string" ? line["agentId"] : null,
      workspaceId: typeof line["workspaceId"] === "string" ? line["workspaceId"] : null,
      mode,
      outcome: (typeof line["outcome"] === "string"
        ? line["outcome"]
        : "answered") as JevOutcome["kind"],
      involvement: typeof line["involvement"] === "string" ? line["involvement"] : "",
      decision: {
        did: typeof decision["did"] === "string" ? decision["did"] : "",
        wouldBe: typeof decision["wouldBe"] === "string" ? decision["wouldBe"] : null,
        changed: decision["changed"] === true,
        detail,
      },
      facts: { ...detail },
      price: { benefit: "none", tokens: null, otherBenefit: null, basis: null, pending: false },
      validation: null,
      jevCostUsd: typeof line["jevCostUsd"] === "number" ? line["jevCostUsd"] : null,
    };
  }

  private foldLater(folded: Map<string, Folded>, line: unknown): void {
    if (!isRecord(line)) return;
    const record = folded.get(String(line["id"]));
    if (!record) return;
    if (line["type"] === "settled" && isRecord(line["facts"])) {
      record.facts = { ...record.facts, ...(line["facts"] as JevSavingsFacts) };
    } else if (line["type"] === "validated" && !record.validation && isRecord(line["validation"])) {
      const validation = line["validation"];
      record.validation = {
        outcome: String(validation["outcome"]) as JevSavingsValidation["outcome"],
        signal: typeof validation["signal"] === "string" ? validation["signal"] : null,
        afterMinutes:
          typeof validation["afterMinutes"] === "number" ? validation["afterMinutes"] : null,
      };
    }
  }

  private async readLines(filePath: string): Promise<{ lines: unknown[]; malformed: number }> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      return { lines: [], malformed: 0 };
    }
    const lines: unknown[] = [];
    let malformed = 0;
    for (const raw of text.split("\n")) {
      if (raw.trim().length === 0) continue;
      try {
        lines.push(JSON.parse(raw));
      } catch {
        malformed += 1;
      }
    }
    return { lines, malformed };
  }

  private async rewrite(filePath: string, lines: unknown[]): Promise<void> {
    if (lines.length === 0) {
      await fs.rm(filePath, { force: true });
      return;
    }
    const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    await writeFileAtomic(filePath, text, this.isWindows ? {} : { mode: 0o600 });
  }

  private async readRollup(): Promise<Map<string, DayAgg>> {
    const days = new Map<string, DayAgg>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.rollupPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          { err: error },
          "jev savings: rollup unreadable; rebuilding from the file",
        );
      }
      return days;
    }
    if (!isRecord(parsed) || parsed["version"] !== 1 || !isRecord(parsed["days"])) return days;
    for (const [day, value] of Object.entries(parsed["days"])) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRecord(value)) continue;
      days.set(day, reviveDay(value));
    }
    return days;
  }
}

/**
 * Days the file holds completely, rebuilt from its records. The oldest day it holds may be partial
 * (a rotation or the prune cut it): there the persisted rollup wins, unless the file holds at least
 * as many of that day's involvements, as after a crash between two rollup flushes. Not-asked counts
 * and spend are never in the file; they carry over from the persisted rollup.
 */
function rebuildDays(persisted: Map<string, DayAgg>, records: Folded[]): Map<string, DayAgg> {
  const oldestDay = records[0]?.day ?? null;
  const rebuilt = new Map<string, DayAgg>();
  for (const record of records) {
    let agg = rebuilt.get(record.day);
    if (!agg) {
      agg = carriedOver(persisted.get(record.day));
      rebuilt.set(record.day, agg);
    }
    contribute(agg, record, 1);
  }
  const oldestPersisted = oldestDay ? persisted.get(oldestDay) : undefined;
  const oldestRebuilt = oldestDay ? rebuilt.get(oldestDay) : undefined;
  if (oldestDay && oldestPersisted && oldestRebuilt) {
    if (involvementsOf(oldestRebuilt) < involvementsOf(oldestPersisted)) rebuilt.delete(oldestDay);
  }
  return rebuilt;
}

function involvementsOf(day: DayAgg): number {
  let total = 0;
  for (const f of Object.values(day.features)) total += f?.asked ?? 0;
  return total;
}

function carriedOver(previous: DayAgg | undefined): DayAgg {
  const agg = emptyDay();
  agg.spend = previous?.spend ?? null;
  for (const [feature, f] of Object.entries(previous?.features ?? {})) {
    if (f && Object.keys(f.notAsked).length > 0) {
      agg.features[feature] = { ...emptyFeature(), notAsked: { ...f.notAsked } };
    }
  }
  return agg;
}

/** Merges one day into the range's sums and fills its row of the days chart. */
function addDay(
  into: {
    features: Map<string, FeatureAgg>;
    agents: Map<string, Tally>;
    workspaces: Map<string, Tally>;
  },
  agg: DayAgg,
  row: JevSavingsDay,
): void {
  for (const [feature, f] of Object.entries(agg.features)) {
    if (!f) continue;
    mergeFeature(into.features, feature, f);
    row.involvements += f.asked;
    if (JEV_SAVINGS_BENEFIT[feature as JevSavingsFeature] !== "tokens") continue;
    row.liveTokens += f.live.tokens;
    row.shadowTokens += f.shadow.tokens;
  }
  for (const [id, tally] of Object.entries(agg.agents)) mergeTally(into.agents, id, tally);
  for (const [id, tally] of Object.entries(agg.workspaces)) mergeTally(into.workspaces, id, tally);
}

/** Ordinal order of two savings ids, which is creation order. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** What a record adds to a day; `sign` -1 removes it. Pure over the record's current state. */
function contribute(day: DayAgg, record: Folded, sign: 1 | -1): void {
  let f = day.features[record.feature];
  if (!f) {
    f = emptyFeature();
    day.features[record.feature] = f;
  }
  const tokenFeature = record.price.benefit === "tokens";
  const tokens = tokenFeature ? (record.price.tokens ?? 0) : 0;
  f.asked += sign;
  const mode = f[record.mode];
  mode.involvements += sign;
  if (changedOf(record)) mode.changed += sign;
  mode.tokens += sign * tokens;
  if (record.price.pending) mode.pending += sign;
  const other = record.price.otherBenefit;
  if (other) {
    const value =
      (mode.other && mode.other.unit === other.unit ? mode.other.value : 0) + sign * other.value;
    mode.other = { unit: other.unit, value };
  }
  if (record.validation) {
    f.validation.checked += sign;
    if (record.validation.outcome === "held") f.validation.held += sign;
    else f.validation.wrong += sign;
  }
  f.jevUsd += sign * (record.jevCostUsd ?? 0);
  const counters = evidenceCounters({
    feature: record.feature,
    mode: record.mode,
    decision: record.decision,
    facts: record.facts,
    validation: record.validation,
    price: record.price,
  });
  for (const [key, value] of Object.entries(counters)) {
    f.counters[key] = (f.counters[key] ?? 0) + sign * value;
  }
  const tallyTokens = (tally: Tally) => {
    tally.involvements += sign;
    if (record.mode === "live") tally.liveTokens += sign * tokens;
    else tally.shadowTokens += sign * tokens;
  };
  if (record.agentId) tallyTokens((day.agents[record.agentId] ??= emptyTally()));
  if (record.workspaceId) tallyTokens((day.workspaces[record.workspaceId] ??= emptyTally()));
}

/** Live: the answer changed what code did. Shadow: it would have. */
function changedOf(record: Folded): boolean {
  if (record.mode === "live") return record.decision.changed;
  return record.decision.wouldBe !== null && record.decision.wouldBe !== record.decision.did;
}

function modeTotals(mode: ModeAgg, tokenFeature: boolean): JevSavingsModeTotals {
  return {
    involvements: mode.involvements,
    changed: mode.changed,
    tokens: tokenFeature ? Math.round(mode.tokens) : 0,
    otherBenefit: mode.other
      ? { unit: mode.other.unit, value: Math.round(mode.other.value * 10) / 10 }
      : null,
    pending: mode.pending,
  };
}

function mergeFeature(into: Map<string, FeatureAgg>, feature: string, f: FeatureAgg): void {
  const target = into.get(feature) ?? emptyFeature();
  target.asked += f.asked;
  for (const [reason, count] of Object.entries(f.notAsked)) {
    const key = reason as JevNotAskedReason;
    target.notAsked[key] = (target.notAsked[key] ?? 0) + (count ?? 0);
  }
  for (const key of ["live", "shadow"] as const) {
    const from = f[key];
    const to = target[key];
    to.involvements += from.involvements;
    to.changed += from.changed;
    to.tokens += from.tokens;
    to.pending += from.pending;
    if (from.other) {
      const value =
        (to.other && to.other.unit === from.other.unit ? to.other.value : 0) + from.other.value;
      to.other = { unit: from.other.unit, value };
    }
  }
  target.validation.checked += f.validation.checked;
  target.validation.held += f.validation.held;
  target.validation.wrong += f.validation.wrong;
  target.jevUsd += f.jevUsd;
  for (const [key, value] of Object.entries(f.counters))
    target.counters[key] = (target.counters[key] ?? 0) + value;
  into.set(feature, target);
}

function mergeTally(into: Map<string, Tally>, id: string, tally: Tally): void {
  const target = into.get(id) ?? emptyTally();
  target.involvements += tally.involvements;
  target.liveTokens += tally.liveTokens;
  target.shadowTokens += tally.shadowTokens;
  into.set(id, target);
}

function topTallies(tallies: Record<string, Tally>): Record<string, Tally> {
  return Object.fromEntries(
    Object.entries(tallies)
      .filter(([, tally]) => tally.involvements > 0)
      .sort((a, b) => b[1].involvements - a[1].involvements)
      .slice(0, ROLLUP_TOP_ENTRIES),
  );
}

function reviveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function reviveMode(value: unknown): ModeAgg {
  const v = isRecord(value) ? value : {};
  const other = isRecord(v["other"]) && typeof v["other"]["unit"] === "string" ? v["other"] : null;
  return {
    involvements: reviveNumber(v["involvements"]),
    changed: reviveNumber(v["changed"]),
    tokens: reviveNumber(v["tokens"]),
    other: other
      ? { unit: other["unit"] as JevOtherBenefit["unit"], value: reviveNumber(other["value"]) }
      : null,
    pending: reviveNumber(v["pending"]),
  };
}

function reviveCounts<K extends string>(value: unknown): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  if (!isRecord(value)) return out;
  for (const [key, count] of Object.entries(value)) out[key as K] = reviveNumber(count);
  return out;
}

function reviveTallies(value: unknown): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  if (!isRecord(value)) return out;
  for (const [id, tally] of Object.entries(value)) {
    if (!isRecord(tally)) continue;
    out[id] = {
      involvements: reviveNumber(tally["involvements"]),
      liveTokens: reviveNumber(tally["liveTokens"]),
      shadowTokens: reviveNumber(tally["shadowTokens"]),
    };
  }
  return out;
}

function reviveDay(value: Record<string, unknown>): DayAgg {
  const features: Partial<Record<string, FeatureAgg>> = {};
  if (isRecord(value["features"])) {
    for (const [feature, raw] of Object.entries(value["features"])) {
      if (!isRecord(raw)) continue;
      const validation = isRecord(raw["validation"]) ? raw["validation"] : {};
      features[feature] = {
        asked: reviveNumber(raw["asked"]),
        notAsked: reviveCounts<JevNotAskedReason>(raw["notAsked"]),
        live: reviveMode(raw["live"]),
        shadow: reviveMode(raw["shadow"]),
        validation: {
          checked: reviveNumber(validation["checked"]),
          held: reviveNumber(validation["held"]),
          wrong: reviveNumber(validation["wrong"]),
        },
        jevUsd: reviveNumber(raw["jevUsd"]),
        counters: reviveCounts<string>(raw["counters"]) as Record<string, number>,
      };
    }
  }
  const spend = isRecord(value["spend"])
    ? { calls: reviveNumber(value["spend"]["calls"]), usd: reviveNumber(value["spend"]["usd"]) }
    : null;
  return {
    features,
    agents: reviveTallies(value["agents"]),
    workspaces: reviveTallies(value["workspaces"]),
    spend,
  };
}

function parsePaths(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** An event's detail without the watched paths, which can be 120 long. */
function withoutRegretPaths(facts: JevSavingsFacts): JevSavingsFacts {
  if (!(REGRET_PATHS_FACT in facts)) return { ...facts };
  const { [REGRET_PATHS_FACT]: _paths, ...rest } = facts;
  return rest;
}

/** The savings id recorded for a JEV call, through any sink; null when the sink keeps no index. */
export function savingsIdForCall(
  sink: JevSavingsSink | null | undefined,
  callId: string | null,
): string | null {
  if (!sink || !callId) return null;
  return sink instanceof JevSavingsLedger ? sink.idForCall(callId) : null;
}
