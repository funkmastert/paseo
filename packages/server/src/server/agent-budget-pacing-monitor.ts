import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import type { AgentManager } from "./agent/agent-manager.js";
import { resolveAccountPoolEntries } from "./agent/account-pool-providers.js";
import {
  planBudgetPacingAdvice,
  recordBudgetPacingDelivery,
  resolveBudgetPacingConfig,
  type BudgetPacingAdvisory,
  type BudgetPacingConfig,
  type BudgetPacingMemory,
  type BudgetPacingSettings,
} from "./agent/budget-pacing-advisor.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

interface BudgetPacingMonitorLogger {
  debug: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentBudgetPacingMonitorOptions {
  /**
   * Reuses the token-burn projection rather than adding a fifth near-identical one: it already
   * carries provider, delegation, run state and the weighted rate, which is the whole of what
   * pacing needs from an agent.
   */
  agentManager: Pick<AgentManager, "listAgentsForTokenBurnMonitor">;
  /**
   * The same cached rows the Host Usage screen and the failover monitor read. Never
   * force-refreshed: the five-minute cache is what keeps three accounts off the usage API once a
   * minute, and the pace maths is built to tolerate the staleness instead.
   */
  providerUsage: Pick<ProviderUsageService, "listUsage">;
  /**
   * Delivers ONE system-authored message into a running agent's conversation — the same narrow
   * steer AgentTokenBurnMonitor and AgentResourceMonitor take, for the same reason. Only ever
   * called for an agent that was mid-turn this sweep: steering an idle agent starts a fresh turn
   * nobody asked for, which would spend an account's budget to talk about that budget.
   */
  sendSystemMessageToAgent: (agentId: string, body: string) => Promise<void>;
  /** `providers` is the daemon's resolved `agents.providers`; the account pool lives in its params. */
  readDaemonConfig: () => {
    budgetPacing?: BudgetPacingSettings;
    providers?: Record<string, unknown>;
  };
  logger: BudgetPacingMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface ResolvedBudgetPacingConfig extends BudgetPacingConfig {
  dryRun: boolean;
}

/** Thresholds come from the advisor, which owns and justifies them; dry run is the monitor's. */
function resolveConfig(settings: BudgetPacingSettings): ResolvedBudgetPacingConfig {
  return { ...resolveBudgetPacingConfig(settings), dryRun: settings.dryRun ?? false };
}

function formatDuration(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

function formatPct(value: number): string {
  return `${Math.round(value)}%`;
}

/** A weekly window's pace runs to thousandths of a point a minute; a session window's does not. */
function formatPace(pctPerMin: number): string {
  if (pctPerMin >= 1) return `${pctPerMin.toFixed(1)}%/min`;
  if (pctPerMin >= 0.1) return `${pctPerMin.toFixed(2)}%/min`;
  return `${pctPerMin.toFixed(3)}%/min`;
}

function formatWeightedTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${Math.round(tokens)}`;
}

function formatFleetClause(advisory: BudgetPacingAdvisory): string {
  if (advisory.runningAgentsOnAccount === 0) {
    return " Nothing is running on that account right now.";
  }
  const rate = formatWeightedTokens(advisory.accountTokenRatePerMinute);
  if (advisory.runningAgentsOnAccount === 1) {
    return ` 1 agent is running on it, burning about ${rate} weighted tokens/min.`;
  }
  return (
    ` ${advisory.runningAgentsOnAccount} agents are running on it, burning about ${rate} ` +
    "weighted tokens/min between them."
  );
}

function formatAlternatives(advisory: BudgetPacingAdvisory): string {
  return advisory.alternatives
    .map((entry) => `${entry.providerId} (${formatPct(entry.remainingPct)} left)`)
    .join(", ");
}

function formatSlowDownSituation(advisory: BudgetPacingAdvisory): string {
  const exhaust = advisory.minutesToExhaust ?? 0;
  const early = advisory.earlyByMinutes ?? 0;
  return (
    `Worker account ${advisory.providerId} has ${formatPct(advisory.remainingPct)} of its ` +
    `${advisory.windowLabel} window left, and that window does not reset for ` +
    `${formatDuration(advisory.minutesToReset)} (${advisory.resetsAt}). Over the last ` +
    `${formatDuration(advisory.observationMinutes)} it has been consumed at about ` +
    `${formatPace(advisory.observedPctPerMin)}, against the ` +
    `${formatPace(advisory.requiredPctPerMin)} that would make what is left last to the reset. ` +
    `At that pace it runs out in about ${formatDuration(exhaust)} — roughly ` +
    `${formatDuration(early)} before the reset — and reaching the reset would take about ` +
    `${Math.round(advisory.gapPct)} points more of the window than it has.` +
    formatFleetClause(advisory)
  );
}

function formatSlowDownRecommendation(advisory: BudgetPacingAdvisory): string {
  const head =
    "Ease off on that account: stop adding parallel subagents there, and prefer a cheaper " +
    "model for anything that does not need a big one. Work already in flight there is the " +
    "thing at risk — it is the turn that gets cut off when the window caps.";
  const best = advisory.alternatives[0];
  if (!best) {
    return `${head} There is no other worker account to move new work to, so pacing is the only lever.`;
  }
  return (
    `${head} Put new work on another account instead: ${best.providerId} has ` +
    `${formatPct(best.remainingPct)} of its ${advisory.windowLabel} window left, so create ` +
    `subagents there with provider "${best.providerId}/<model>" rather than letting the ` +
    "default placement choose."
  );
}

function formatSpeedUpSituation(advisory: BudgetPacingAdvisory): string {
  return (
    `Worker account ${advisory.providerId} has ${formatPct(advisory.remainingPct)} of its ` +
    `${advisory.windowLabel} window left and it resets in ` +
    `${formatDuration(advisory.minutesToReset)} (${advisory.resetsAt}). Over the last ` +
    `${formatDuration(advisory.observationMinutes)} it has been consumed at about ` +
    `${formatPace(advisory.observedPctPerMin)}; spending the rest of it before the reset would ` +
    `take about ${formatPace(advisory.requiredPctPerMin)}. At the current pace roughly ` +
    `${Math.round(advisory.gapPct)} points of the window expire unused, and a window that ` +
    "expires does not roll over — that capacity is gone rather than carried forward." +
    formatFleetClause(advisory)
  );
}

function formatSpeedUpRecommendation(advisory: BudgetPacingAdvisory): string {
  const head =
    "Be more aggressive with subagents while it lasts: run in parallel what you were going to " +
    "run in sequence, give the work that deserves a bigger model one now, and start anything " +
    "you were holding in a queue. Pass the account explicitly — provider " +
    `"${advisory.providerId}/<model>" — so the spend lands on this window rather than wherever ` +
    "the default placement sends it.";
  const alternatives = formatAlternatives(advisory);
  if (!alternatives) return head;
  return `${head} The other worker accounts' ${advisory.windowLabel} windows: ${alternatives}.`;
}

/**
 * What the leader reads. Numbers and a recommendation, not a status dump: how much is left, how
 * long until it resets, the pace that implies, what to do, and what the numbers cannot promise.
 * The uncertainty paragraph is not decoration — the usage figure is a cached snapshot and the
 * pace is a two-point estimate, and a leader that treats either as a fact will over-correct.
 */
export function formatBudgetPacingAdvisory(advisory: BudgetPacingAdvisory): string {
  const isSlowDown = advisory.direction === "slowDown";
  const situation = isSlowDown
    ? formatSlowDownSituation(advisory)
    : formatSpeedUpSituation(advisory);
  const recommendation = isSlowDown
    ? formatSlowDownRecommendation(advisory)
    : formatSpeedUpRecommendation(advisory);
  const caveat =
    `Both figures are estimates. The usage reading is a cached snapshot taken ` +
    `${formatDuration(advisory.usageAgeMinutes)} ago — the daemon refreshes it every five ` +
    `minutes — and the pace is the difference between ${advisory.observationSamples} readings ` +
    `over ${formatDuration(advisory.observationMinutes)}. Treat the projection as a direction, ` +
    "not a measurement.";
  return [
    "Bozeo budget pacing — advice only. Nothing has been throttled, cancelled, downgraded or " +
      "refused, and nothing will be on account of this message.",
    situation,
    recommendation,
    caveat,
  ].join("\n\n");
}

/**
 * Watches how fast each worker account's usage window is being consumed against how much time
 * that window has left, and tells running leaders to widen or narrow their fan-out. Same shape
 * as its siblings — an unref'd 60s timer, config re-read every sweep, no persisted state — and
 * deliberately the least powerful of them: it only ever produces a sentence.
 *
 * Off by default. It also needs about twenty minutes of observation after being turned on before
 * it can say anything, because a pace is a difference between two usage readings and those are
 * five minutes apart at best.
 *
 * See docs/budget-pacing.md.
 */
export class AgentBudgetPacingMonitor {
  private readonly options: AgentBudgetPacingMonitorOptions;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight = false;
  private memory: BudgetPacingMemory = new Map();

  constructor(options: AgentBudgetPacingMonitorOptions) {
    this.options = options;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.logger.error({ err: error }, "Budget pacing sweep failed");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs one sweep; a call while another sweep is in flight returns without sweeping. */
  async tick(): Promise<void> {
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async sweep(): Promise<void> {
    const daemonConfig = this.options.readDaemonConfig();
    if (daemonConfig.budgetPacing?.enabled !== true) {
      // Samples are evidence about a window that is still moving while the leg is off, so they
      // are dropped rather than carried: turning it back on re-observes instead of differencing
      // across a gap nobody was watching.
      this.memory.clear();
      return;
    }
    const config = resolveConfig(daemonConfig.budgetPacing);
    const workerProviderIds = new Set(
      resolveAccountPoolEntries(daemonConfig.providers)
        .filter((entry) => entry.role === "worker" && entry.enabled)
        .map((entry) => entry.providerId),
    );
    const usage = await this.readUsage();
    if (!usage) {
      return;
    }

    const nowMs = this.now();
    const plan = planBudgetPacingAdvice({
      usage: usage.providers,
      usageFetchedAtMs: usage.fetchedAtMs,
      workerProviderIds,
      agents: this.options.agentManager.listAgentsForTokenBurnMonitor(nowMs),
      previous: this.memory,
      config,
      nowMs,
    });
    this.memory = plan.memory;

    const advisory = plan.advisories[0];
    if (!advisory) {
      this.options.logger.debug({ reason: plan.skipped }, "Budget pacing found nothing to advise");
      return;
    }
    // An advisory nobody is there to hear is not delivered and not recorded. A fleet that is
    // idle because Tyler is asleep is not underusing anything worth a nudge, and when a leader
    // does start working the same advisory is still waiting for it.
    if (plan.leaderIds.length === 0) {
      this.options.logger.debug(
        { direction: advisory.direction, providerId: advisory.providerId },
        "Budget pacing had advice but no leader was running",
      );
      return;
    }

    const body = formatBudgetPacingAdvisory(advisory);
    if (config.dryRun) {
      this.options.logger.info(
        { dryRun: true, ...this.describe(advisory), leaderIds: plan.leaderIds, advice: body },
        "Budget pacing would advise running leaders",
      );
      recordBudgetPacingDelivery(this.memory, advisory, nowMs);
      return;
    }

    const told = await this.tellLeaders(plan.leaderIds, body);
    if (told.length === 0) {
      return;
    }
    recordBudgetPacingDelivery(this.memory, advisory, nowMs);
    this.options.logger.info(
      { ...this.describe(advisory), leaderIds: told },
      "Budget pacing advised running leaders",
    );
  }

  /** The numbers behind one advisory, for the log line that has to explain it afterwards. */
  private describe(advisory: BudgetPacingAdvisory): Record<string, unknown> {
    return {
      direction: advisory.direction,
      providerId: advisory.providerId,
      windowLabel: advisory.windowLabel,
      remainingPct: Math.round(advisory.remainingPct),
      minutesToReset: Math.round(advisory.minutesToReset),
      observedPctPerMin: Number(advisory.observedPctPerMin.toFixed(3)),
      requiredPctPerMin: Number(advisory.requiredPctPerMin.toFixed(3)),
      gapPct: Math.round(advisory.gapPct),
      observationMinutes: Math.round(advisory.observationMinutes),
    };
  }

  /** Leaders that actually received it. One failed steer must not silence the rest. */
  private async tellLeaders(leaderIds: readonly string[], body: string): Promise<string[]> {
    const told: string[] = [];
    for (const leaderId of leaderIds) {
      try {
        await this.options.sendSystemMessageToAgent(leaderId, body);
        told.push(leaderId);
      } catch (error) {
        this.options.logger.warn(
          { err: error, agentId: leaderId },
          "Failed to steer budget pacing advice into leader",
        );
      }
    }
    return told;
  }

  private async readUsage(): Promise<BudgetPacingUsageSnapshot | null> {
    try {
      const result = await this.options.providerUsage.listUsage();
      const fetchedAtMs = Date.parse(result.fetchedAt);
      if (!Number.isFinite(fetchedAtMs)) {
        return null;
      }
      return { providers: result.providers, fetchedAtMs };
    } catch (error) {
      this.options.logger.warn({ err: error }, "Failed to read provider usage for budget pacing");
      return null;
    }
  }
}

interface BudgetPacingUsageSnapshot {
  providers: Awaited<ReturnType<ProviderUsageService["listUsage"]>>["providers"];
  fetchedAtMs: number;
}
