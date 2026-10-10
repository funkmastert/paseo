import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic-file.js";
import type { WindowSample } from "./usage-projection.js";

/**
 * File-backed history of what the daemon already sees: per-account usage windows, and per-agent
 * cost-weighted spend. Layout under `$PASEO_HOME/usage-history/`:
 *
 *   accounts.json          every account window's readings, one file
 *   agents/{agentId}.json  one file per agent
 *
 * It is a history, so it is bounded on every axis and prunes itself (docs/usage-history.md):
 * readings expire after `retentionDays`, older readings are thinned to `thinAfterMs` spacing, and
 * each series, the account file and the agent directory have a hard count cap. Whatever the
 * daemon's uptime or how many agents it has run, the disk cost has a ceiling.
 *
 * Writes go through one method per transaction (`record`): the change is applied in memory and
 * persisted by `flush`, which the store schedules itself at most once per `flushIntervalMs` and on
 * `close`. A crash loses at most that interval of history and never corrupts a file (atomic
 * writes), which is the right trade for a series no decision depends on to the minute.
 */

const ACCOUNT_SAMPLE_SCHEMA = z.tuple([z.number(), z.number(), z.number().nullable()]);
const ACCOUNTS_FILE_SCHEMA = z.object({
  v: z.literal(1),
  series: z.array(
    z.object({
      providerId: z.string(),
      windowId: z.string(),
      label: z.string(),
      samples: z.array(ACCOUNT_SAMPLE_SCHEMA),
    }),
  ),
});
const AGENT_FILE_SCHEMA = z.object({
  v: z.literal(1),
  agentId: z.string(),
  // Spend before the current daemon/counter epoch, so the series stays monotonic across a daemon
  // restart or an agent closed and loaded again (both zero the live counter, docs/token-burn.md).
  offset: z.number(),
  // The live counter's last reading in that epoch.
  lastRaw: z.number(),
  samples: z.array(z.tuple([z.number(), z.number()])),
});

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface UsageHistoryLimits {
  retentionDays: number;
  /** Readings older than this are kept no closer together than `thinSpacingMs`. */
  thinAfterMs: number;
  thinSpacingMs: number;
  maxAccountSeries: number;
  maxSamplesPerAccountSeries: number;
  maxAgentSeries: number;
  maxSamplesPerAgentSeries: number;
}

export const DEFAULT_USAGE_HISTORY_LIMITS: UsageHistoryLimits = {
  // A weekly window is seven days long; the eighth day keeps the reset's neighbourhood readable.
  retentionDays: 8,
  thinAfterMs: DAY_MS,
  thinSpacingMs: 15 * MINUTE_MS,
  maxAccountSeries: 64,
  maxSamplesPerAccountSeries: 1_500,
  maxAgentSeries: 400,
  maxSamplesPerAgentSeries: 720,
};

export interface AccountWindowSampleInput {
  providerId: string;
  windowId: string;
  label: string;
  atMs: number;
  usedPct: number;
  resetsAtMs: number | null;
}

export interface AgentSpendInput {
  agentId: string;
  /** The live counter's lifetime weighted-token total. */
  totalTokens: number;
}

export interface UsageSweepRecord {
  nowMs: number;
  accounts: readonly AccountWindowSampleInput[];
  agents: readonly AgentSpendInput[];
}

export interface AccountWindowSeries {
  providerId: string;
  windowId: string;
  label: string;
  samples: WindowSample[];
}

export interface AgentSpendPoint {
  atMs: number;
  weightedTokens: number;
}

export interface AgentSpendSeries {
  agentId: string;
  totalWeightedTokens: number;
  points: AgentSpendPoint[];
}

interface StoreLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface UsageHistoryStoreOptions {
  rootDir: string;
  logger: StoreLogger;
  limits?: Partial<UsageHistoryLimits>;
  flushIntervalMs?: number;
}

interface AccountSeriesState {
  providerId: string;
  windowId: string;
  label: string;
  samples: Array<[number, number, number | null]>;
}

interface AgentSeriesState {
  agentId: string;
  offset: number;
  lastRaw: number;
  samples: Array<[number, number]>;
}

/** An agent silent for this long is idle, not slow: the line should stay flat, then move. */
const PLATEAU_GAP_MS = 2 * MINUTE_MS;
const PLATEAU_LEAD_MS = MINUTE_MS;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_FLUSH_INTERVAL_MS = 5 * MINUTE_MS;
const PRUNE_INTERVAL_MS = HOUR_MS;

export class UsageHistoryStore {
  private readonly rootDir: string;
  private readonly logger: StoreLogger;
  private readonly limits: UsageHistoryLimits;
  private readonly flushIntervalMs: number;
  private accounts: Map<string, AccountSeriesState> | null = null;
  private readonly agents = new Map<string, AgentSeriesState>();
  private accountsDirty = false;
  private readonly dirtyAgents = new Set<string>();
  private lastFlushMs = 0;
  private lastPruneMs = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: UsageHistoryStoreOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.limits = { ...DEFAULT_USAGE_HISTORY_LIMITS, ...options.limits };
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /**
   * One transaction: append the sweep's account readings and agent spend, prune when due, and
   * persist when the flush interval has passed. Advance-only: a snapshot already recorded, or a
   * counter that has not moved, adds nothing, so an idle agent costs no rows and an account's
   * series grows once per distinct provider fetch.
   */
  async record(sweep: UsageSweepRecord): Promise<void> {
    const accounts = await this.loadAccounts();
    for (const input of sweep.accounts) {
      this.appendAccountSample(accounts, input);
    }
    for (const input of sweep.agents) {
      await this.appendAgentSpend(input, sweep.nowMs);
    }
    if (sweep.nowMs - this.lastPruneMs >= PRUNE_INTERVAL_MS) {
      this.lastPruneMs = sweep.nowMs;
      await this.prune(sweep.nowMs);
    }
    if (sweep.nowMs - this.lastFlushMs >= this.flushIntervalMs) {
      await this.flush(sweep.nowMs);
      this.evictAgentsNotLive(new Set(sweep.agents.map((agent) => agent.agentId)));
    }
  }

  async readAccountSeries(): Promise<AccountWindowSeries[]> {
    const accounts = await this.loadAccounts();
    return [...accounts.values()].map((series) => ({
      providerId: series.providerId,
      windowId: series.windowId,
      label: series.label,
      samples: series.samples.map(([atMs, usedPct, resetsAtMs]) => ({
        atMs,
        usedPct,
        resetsAtMs,
      })),
    }));
  }

  /** The agent's spend over its life, downsampled to at most `maxPoints`. Null when none recorded. */
  async readAgentSpend(agentId: string, maxPoints: number): Promise<AgentSpendSeries | null> {
    const series = await this.loadAgent(agentId);
    const last = series?.samples[series.samples.length - 1];
    if (!series || !last) return null;
    return {
      agentId,
      totalWeightedTokens: last[1],
      points: downsample(series.samples, maxPoints).map(([atMs, weightedTokens]) => ({
        atMs,
        weightedTokens,
      })),
    };
  }

  /** Persists everything dirty. Safe to call at any time; concurrent calls run in order. */
  flush(nowMs: number = Date.now()): Promise<void> {
    this.lastFlushMs = nowMs;
    const run = this.writeChain.then(() => this.writeDirty());
    // A failed write is logged in writeDirty and must not poison the chain for the next flush.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  /** Expires and thins by age, then enforces the count caps. Exposed for tests and `record`. */
  async prune(nowMs: number): Promise<void> {
    const accounts = await this.loadAccounts();
    const horizonMs = nowMs - this.limits.retentionDays * DAY_MS;
    for (const [key, series] of accounts) {
      const before = series.samples.length;
      series.samples = thinByAge(
        series.samples.filter((sample) => sample[0] >= horizonMs),
        nowMs,
        this.limits,
      ).slice(-this.limits.maxSamplesPerAccountSeries);
      if (series.samples.length === 0) accounts.delete(key);
      if (series.samples.length !== before) this.accountsDirty = true;
    }
    if (accounts.size > this.limits.maxAccountSeries) {
      const byNewest = [...accounts.entries()].sort((a, b) => newestAt(b[1]) - newestAt(a[1]));
      for (const [key] of byNewest.slice(this.limits.maxAccountSeries)) accounts.delete(key);
      this.accountsDirty = true;
    }
    await this.pruneAgentFiles(horizonMs);
  }

  private async loadAccounts(): Promise<Map<string, AccountSeriesState>> {
    if (this.accounts) return this.accounts;
    const loaded = new Map<string, AccountSeriesState>();
    const parsed = await this.readJson(this.accountsPath(), ACCOUNTS_FILE_SCHEMA);
    for (const series of parsed?.series ?? []) {
      loaded.set(accountKey(series.providerId, series.windowId), {
        providerId: series.providerId,
        windowId: series.windowId,
        label: series.label,
        samples: series.samples,
      });
    }
    this.accounts = loaded;
    return loaded;
  }

  private appendAccountSample(
    accounts: Map<string, AccountSeriesState>,
    input: AccountWindowSampleInput,
  ): void {
    const key = accountKey(input.providerId, input.windowId);
    let series = accounts.get(key);
    if (!series) {
      if (accounts.size >= this.limits.maxAccountSeries) return;
      series = {
        providerId: input.providerId,
        windowId: input.windowId,
        label: input.label,
        samples: [],
      };
      accounts.set(key, series);
    }
    const last = series.samples[series.samples.length - 1];
    // Same snapshot read twice: not a new reading. Every distinct fetch is kept even when the
    // number did not move, because a flat window is a finding ("not filling") and dropping its
    // rows would leave the projection with too few readings to say so.
    if (last && input.atMs <= last[0]) return;
    series.label = input.label;
    series.samples.push([input.atMs, input.usedPct, input.resetsAtMs]);
    if (series.samples.length > this.limits.maxSamplesPerAccountSeries) {
      series.samples = series.samples.slice(-this.limits.maxSamplesPerAccountSeries);
    }
    this.accountsDirty = true;
  }

  private async loadAgent(agentId: string): Promise<AgentSeriesState | null> {
    const cached = this.agents.get(agentId);
    if (cached) return cached;
    if (!AGENT_ID_PATTERN.test(agentId)) return null;
    const parsed = await this.readJson(this.agentPath(agentId), AGENT_FILE_SCHEMA);
    if (!parsed || parsed.agentId !== agentId) return null;
    // A new process starts a new counter epoch: the live totals are not persisted, so whatever
    // the last epoch reached is now the baseline this one adds to.
    const state: AgentSeriesState = {
      agentId,
      offset: parsed.offset + parsed.lastRaw,
      lastRaw: 0,
      samples: parsed.samples,
    };
    this.agents.set(agentId, state);
    return state;
  }

  private async appendAgentSpend(input: AgentSpendInput, nowMs: number): Promise<void> {
    const raw = input.totalTokens;
    if (!AGENT_ID_PATTERN.test(input.agentId) || !Number.isFinite(raw) || raw <= 0) return;
    let series = await this.loadAgent(input.agentId);
    if (!series) {
      series = { agentId: input.agentId, offset: 0, lastRaw: 0, samples: [] };
      this.agents.set(input.agentId, series);
    }
    // A drop is the live counter starting over (agent closed and loaded again, or a successor
    // reusing the id): what it had reached is spent and stays counted.
    if (raw < series.lastRaw) series.offset += series.lastRaw;
    series.lastRaw = raw;
    const cumulative = series.offset + raw;
    const last = series.samples[series.samples.length - 1];
    if (last && cumulative <= last[1]) return;
    if (last && nowMs - last[0] > PLATEAU_GAP_MS) {
      // Idle, then moving: hold the line flat until just before it moved, so a burst after a
      // quiet hour draws as a burst and not as a slow ramp across the hour.
      const plateauAt = nowMs - PLATEAU_LEAD_MS;
      if (plateauAt > last[0]) series.samples.push([plateauAt, last[1]]);
    }
    series.samples.push([nowMs, cumulative]);
    if (series.samples.length > this.limits.maxSamplesPerAgentSeries) {
      series.samples = halveOlderHalf(series.samples);
    }
    this.dirtyAgents.add(series.agentId);
  }

  private async writeDirty(): Promise<void> {
    try {
      if (this.accountsDirty && this.accounts) {
        this.accountsDirty = false;
        await writeFileAtomic(
          this.accountsPath(),
          JSON.stringify({ v: 1, series: [...this.accounts.values()] }),
        );
      }
      const dirty = [...this.dirtyAgents];
      this.dirtyAgents.clear();
      for (const agentId of dirty) {
        const series = this.agents.get(agentId);
        if (!series) continue;
        await writeFileAtomic(
          this.agentPath(agentId),
          JSON.stringify({
            v: 1,
            agentId,
            offset: series.offset,
            lastRaw: series.lastRaw,
            samples: series.samples,
          }),
        );
      }
    } catch (error) {
      // A history that cannot be written must not take the monitor's sweep down with it. The
      // dirty marks are gone, so this interval's readings are lost; the next sweep writes anew.
      this.logger.warn({ err: error, rootDir: this.rootDir }, "Failed to persist usage history");
    }
  }

  /**
   * Drops cached series for agents that are no longer live. A live agent must stay cached: its
   * counter epoch (`lastRaw`) lives here, and reloading it from disk would fold a counter that
   * has not restarted into the offset and count its spend twice.
   */
  private evictAgentsNotLive(live: ReadonlySet<string>): void {
    for (const agentId of this.agents.keys()) {
      if (!live.has(agentId) && !this.dirtyAgents.has(agentId)) this.agents.delete(agentId);
    }
  }

  /** Deletes agent files past retention, then the oldest beyond the count cap. */
  private async pruneAgentFiles(horizonMs: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.agentsDir());
    } catch {
      return;
    }
    const entries: Array<{ agentId: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const agentId = name.slice(0, -".json".length);
      try {
        const stat = await fs.stat(path.join(this.agentsDir(), name));
        entries.push({ agentId, mtimeMs: stat.mtimeMs });
      } catch {
        // Raced with a delete; nothing to prune.
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const doomed = entries.filter(
      (entry, index) => entry.mtimeMs < horizonMs || index >= this.limits.maxAgentSeries,
    );
    for (const entry of doomed) {
      this.agents.delete(entry.agentId);
      this.dirtyAgents.delete(entry.agentId);
      await fs.rm(this.agentPath(entry.agentId), { force: true });
    }
  }

  private async readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch (error) {
      // History is disposable: a file that will not parse starts over rather than blocking the
      // recorder, and the next flush replaces it.
      this.logger.warn({ err: error, filePath }, "Ignoring unreadable usage history file");
      return null;
    }
  }

  private accountsPath(): string {
    return path.join(this.rootDir, "accounts.json");
  }

  private agentsDir(): string {
    return path.join(this.rootDir, "agents");
  }

  private agentPath(agentId: string): string {
    return path.join(this.agentsDir(), `${agentId}.json`);
  }
}

function accountKey(providerId: string, windowId: string): string {
  return `${providerId}\u0000${windowId}`;
}

function newestAt(series: AccountSeriesState): number {
  return series.samples[series.samples.length - 1]?.[0] ?? 0;
}

/** Keeps every recent reading and spaces older ones, always keeping the newest of the lot. */
function thinByAge(
  samples: Array<[number, number, number | null]>,
  nowMs: number,
  limits: UsageHistoryLimits,
): Array<[number, number, number | null]> {
  const cutoff = nowMs - limits.thinAfterMs;
  const kept: Array<[number, number, number | null]> = [];
  for (const sample of samples) {
    const previous = kept[kept.length - 1];
    if (sample[0] >= cutoff || !previous || sample[0] - previous[0] >= limits.thinSpacingMs) {
      kept.push(sample);
    }
  }
  return kept;
}

/**
 * Drops every second point of the older half. Halving resolution where it matters least keeps a
 * long-lived agent's whole life on one file without a cliff where history just stops.
 */
function halveOlderHalf(samples: Array<[number, number]>): Array<[number, number]> {
  const middle = Math.floor(samples.length / 2);
  const older = samples.slice(0, middle).filter((_, index) => index % 2 === 0);
  return [...older, ...samples.slice(middle)];
}

function downsample<T>(samples: readonly T[], maxPoints: number): T[] {
  if (maxPoints <= 0) return [];
  if (samples.length <= maxPoints) return [...samples];
  const step = (samples.length - 1) / (maxPoints - 1);
  const picked: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    const sample = samples[Math.round(index * step)];
    if (sample !== undefined) picked.push(sample);
  }
  return picked;
}
