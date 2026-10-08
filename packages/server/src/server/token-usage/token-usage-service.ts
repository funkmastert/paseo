import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type {
  TokenUsageCoverage,
  TokenUsageRange,
  TokenUsageRow,
} from "@getpaseo/protocol/token-usage/rpc-schemas";
import {
  buildSessionRoles,
  sessionIdsOf,
  type AgentSessionSource,
} from "./token-usage-attribution.js";
import {
  TokenUsageScanner,
  type TokenUsageScannerOptions,
  type TokenUsageSweepResult,
  type TranscriptRoot,
} from "./token-usage-scanner.js";
import { TokenUsageStore, type SessionIndexEntry } from "./token-usage-store.js";

/**
 * Token usage by model and role (docs/token-usage.md). Owns the store and the scanner, runs the
 * scan on its own timer, and answers range queries. Config is read on every tick, so turning
 * `agents.tokenUsage.enabled` off stops all transcript reads at the next tick without a restart.
 */

export interface TokenUsageBreakdown {
  generatedAt: string;
  range: TokenUsageRange;
  rangeStartMs: number;
  rows: TokenUsageRow[];
  coverage: TokenUsageCoverage;
}

interface ServiceLogger {
  warn: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
}

export interface TokenUsageServiceOptions {
  /** `$PASEO_HOME/token-usage`. */
  rootDir: string;
  roots: readonly TranscriptRoot[];
  /** Every agent record, archived included: history attributes to them too. */
  listAgentRecords: () => Promise<readonly AgentSessionSource[]>;
  isEnabled: () => boolean;
  logger: ServiceLogger;
  now?: () => number;
  sweepIntervalMs?: number;
  /** Between sweeps while the backfill still has files to read. */
  backfillIntervalMs?: number;
  firstSweepDelayMs?: number;
  scanner?: Pick<
    TokenUsageScannerOptions,
    "budgetMs" | "yieldEveryLines" | "graceMs" | "windowDays"
  >;
  store?: TokenUsageStore;
}

const HOUR_MS = 3_600_000;
const RANGE_MS: Record<TokenUsageRange, number> = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_BACKFILL_INTERVAL_MS = 15_000;
const DEFAULT_FIRST_SWEEP_DELAY_MS = 10_000;

export class TokenUsageService {
  private readonly store: TokenUsageStore;
  private readonly scanner: TokenUsageScanner;
  private readonly listAgentRecords: TokenUsageServiceOptions["listAgentRecords"];
  private readonly isEnabled: () => boolean;
  private readonly logger: ServiceLogger;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private readonly backfillIntervalMs: number;
  private readonly firstSweepDelayMs: number;
  private enabled: boolean;
  private lastSweep: TokenUsageSweepResult | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;

  constructor(options: TokenUsageServiceOptions) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.store =
      options.store ?? new TokenUsageStore({ rootDir: options.rootDir, logger: options.logger });
    this.scanner = new TokenUsageScanner({
      ...options.scanner,
      store: this.store,
      roots: options.roots,
      logger: options.logger,
      now: this.now,
    });
    this.listAgentRecords = options.listAgentRecords;
    this.isEnabled = options.isEnabled;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.backfillIntervalMs = options.backfillIntervalMs ?? DEFAULT_BACKFILL_INTERVAL_MS;
    this.firstSweepDelayMs = options.firstSweepDelayMs ?? DEFAULT_FIRST_SWEEP_DELAY_MS;
    this.enabled = this.isEnabled();
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.schedule(this.firstSweepDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
    await this.store.close();
  }

  /**
   * Records which agent a provider session belongs to, as the daemon learns it. Agent records
   * keep only an agent's latest session, so this index is what attributes an earlier one.
   */
  observeAgent(agent: AgentSessionSource): void {
    if (!this.enabled) return;
    const sessionIds = sessionIdsOf(agent);
    if (sessionIds.length === 0) return;
    const entry = {
      agentId: agent.id,
      parentAgentId: getParentAgentIdFromLabels(agent.labels),
      lastSeenMs: this.now(),
    };
    void this.recordSessions(sessionIds, entry).catch((error: unknown) => {
      this.logger.warn({ err: error }, "Failed to record token usage session");
    });
  }

  private async recordSessions(
    sessionIds: readonly string[],
    entry: Omit<SessionIndexEntry, "sessionId">,
  ): Promise<void> {
    await this.store.load();
    for (const sessionId of sessionIds) this.store.recordSession({ sessionId, ...entry });
  }

  /** One sweep now. Null when the feature is off. Exposed for tests and the dry run. */
  async runSweep(): Promise<TokenUsageSweepResult | null> {
    this.enabled = this.isEnabled();
    if (!this.enabled) return null;
    await this.store.load();
    this.store.markRecordingSince(this.now());
    const roles = buildSessionRoles({
      records: await this.listAgentRecords(),
      sessions: this.store.listSessions(),
    });
    const result = await this.scanner.sweep({ roles });
    this.lastSweep = result;
    if (result.complete) this.store.markBackfillDone(this.now());
    await this.store.maybeFlush(this.now());
    return result;
  }

  async getBreakdown(range: TokenUsageRange): Promise<TokenUsageBreakdown> {
    const nowMs = this.now();
    const rangeStartMs = Math.floor((nowMs - RANGE_MS[range]) / HOUR_MS) * HOUR_MS;
    const base = { generatedAt: new Date(nowMs).toISOString(), range, rangeStartMs };
    this.enabled = this.isEnabled();
    if (!this.enabled) {
      return {
        ...base,
        rows: [],
        coverage: {
          enabled: false,
          recordingSinceMs: null,
          backfill: { state: "off", filesDone: 0, filesTotal: 0 },
        },
      };
    }
    await this.store.load();
    return { ...base, rows: this.store.query(rangeStartMs), coverage: this.coverage() };
  }

  private coverage(): TokenUsageCoverage {
    const last = this.lastSweep;
    const progress = { filesDone: last?.filesDone ?? 0, filesTotal: last?.filesTotal ?? 0 };
    let state: TokenUsageCoverage["backfill"]["state"] = "running";
    if (this.store.getBackfillDoneAtMs() !== null) state = "done";
    else if (!last) state = "pending";
    return {
      enabled: true,
      recordingSinceMs: this.store.getRecordingSinceMs(),
      backfill: { state, ...progress },
    };
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let backfilling = false;
    const run = this.runSweep();
    this.running = run;
    try {
      const result = await run;
      backfilling = result !== null && !result.complete;
      if (result && result.responses > 0) {
        this.logger.info(
          {
            responses: result.responses,
            filesDone: result.filesDone,
            filesTotal: result.filesTotal,
            walkMs: Math.round(result.walkMs),
            scanMs: Math.round(result.scanMs),
            longestBlockMs: Math.round(result.longestBlockMs),
          },
          "Token usage sweep",
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Token usage sweep failed");
    } finally {
      this.running = null;
    }
    this.schedule(backfilling ? this.backfillIntervalMs : this.sweepIntervalMs);
  }
}

/** `agents.tokenUsage.enabled` out of a parsed `config.json`. On unless explicitly false. */
export function isTokenUsageEnabled(rawConfig: Record<string, unknown> | null): boolean {
  const agents = rawConfig?.["agents"];
  if (typeof agents !== "object" || agents === null) return true;
  const section = (agents as Record<string, unknown>)["tokenUsage"];
  if (typeof section !== "object" || section === null) return true;
  return (section as Record<string, unknown>)["enabled"] !== false;
}
