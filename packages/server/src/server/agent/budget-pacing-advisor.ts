/**
 * Pure pacing arithmetic for AgentBudgetPacingMonitor: whether a worker account's usage window
 * is being consumed faster or slower than the pace that would land it exactly at its reset, and
 * whether that gap is worth saying out loud. No I/O and no clock reads — the monitor calls
 * `planBudgetPacingAdvice` once per sweep and carries the returned memory to the next one, the
 * same contract spend-governor.ts and build-daemon-reaper.ts keep.
 *
 * Usage windows reset and do not roll over, so a window that expires with half of it unused has
 * wasted that half permanently. That gives every window a pace — remaining ÷ time to reset — and
 * a gap against the pace that is actionable in both directions: under it, capacity is about to be
 * lost and the fan-out should be wider; over it, the account caps before the reset and strands
 * whatever was in flight. This module only ever produces words. Enforcement belongs to the spend
 * governor (docs/token-burn.md) and the failover monitor (docs/account-failover.md), and the two
 * must not race, so nothing here cancels, downgrades, refuses or throttles anything.
 *
 * See docs/budget-pacing.md.
 */
import type { ProviderUsage, ProviderUsageWindow } from "@getpaseo/protocol/messages";

/**
 * How far back a pace is measured, and the shortest span that counts as a measurement.
 *
 * The daemon's usage cache serves one snapshot for five minutes, so a 15-minute span holds two
 * distinct readings at worst and four at best. That granularity is also where the thresholds
 * below come from: with endpoints up to five minutes stale, a 15-minute span carries up to ±33%
 * error on the rate, and a 45-minute one about ±11%. A verdict must not be flippable by that
 * error, which is why the pace ratios sit a factor of 1.5 either side of parity rather than
 * hugging it.
 */
const DEFAULT_PACE_LOOKBACK_MINUTES = 45;
const DEFAULT_MIN_OBSERVATION_MINUTES = 15;
/** The cache TTL is five minutes; three times that means it has stopped refreshing. */
const DEFAULT_STALE_USAGE_MINUTES = 15;
/**
 * A measured implementation subagent runs on the order of twenty minutes (docs/token-burn.md
 * clocks healthy ones at 1.08M and 1.48M weighted tokens). Inside twenty minutes of a reset a
 * fresh spawn cannot finish, so the capacity is already unrecoverable and the nudge is noise.
 */
const DEFAULT_MIN_ACTIONABLE_MINUTES = 20;
const DEFAULT_REPEAT_AFTER_MINUTES = 20;
const DEFAULT_REPEAT_WORSENING_PCT = 10;
const DEFAULT_MAX_ADVISORIES_PER_CYCLE = 2;
/**
 * Ninety minutes is roughly three to four rounds of delegation at the measured rate, which is
 * enough that changing strategy still changes the outcome. Earlier than that, ordinary work
 * arriving in the next hour is likely to close the gap on its own, and a nudge would be
 * recommending spend for its own sake.
 */
const DEFAULT_SPEED_UP_HORIZON_MINUTES = 90;
const DEFAULT_SPEED_UP_PACE_RATIO = 0.5;
/** A quarter of a window is the smallest loss worth interrupting a leader's turn over. */
const DEFAULT_SPEED_UP_MIN_STRANDED_PCT = 25;
const DEFAULT_SPEED_UP_MIN_REMAINING_PCT = 15;
const DEFAULT_SLOW_DOWN_PACE_RATIO = 1.5;
/**
 * Nothing is said about pace until 40% of the window is gone. A burst in the first minutes of a
 * window projects to an absurd overrun and then corrects itself when the agents that caused it
 * finish; waiting until the burn is established is what keeps the leg off that false positive.
 */
const DEFAULT_SLOW_DOWN_MAX_REMAINING_PCT = 60;
const DEFAULT_SLOW_DOWN_MIN_OVERSHOOT_PCT = 20;
const DEFAULT_SLOW_DOWN_MIN_EARLY_MINUTES = 20;

/** Both directions carry their gap in points of the window, so one threshold covers both. */
export const BUDGET_PACING_DIRECTIONS = ["slowDown", "speedUp"] as const;
export type BudgetPacingDirection = (typeof BUDGET_PACING_DIRECTIONS)[number];

export interface BudgetPacingSpeedUpConfig {
  enabled: boolean;
  /**
   * How close to the reset a window has to be before an underused one is worth mentioning.
   * Earlier than this the work that arrives in the next hour is likely to close the gap on its
   * own, and advising a wider fan-out then risks recommending waste.
   */
  horizonMinutes: number;
  /** Observed ÷ required. At or below this the window is measurably behind its own pace. */
  paceRatio: number;
  /** Points of the window projected to expire unused before it is worth a message. */
  minStrandedPct: number;
  /**
   * A window with less than this left is not a fan-out opportunity, and neither is any other
   * window on the same account: the tightest window is what actually caps the account.
   */
  minRemainingPct: number;
}

export interface BudgetPacingSlowDownConfig {
  enabled: boolean;
  /** Observed ÷ required. At or above this the window caps before it resets. */
  paceRatio: number;
  /** Ignore the pace until this much of the window is gone — early bursts self-correct. */
  maxRemainingPct: number;
  /** Points of the window the account would want beyond what it has, before it is worth saying. */
  minOvershootPct: number;
  /** How much earlier than the reset the projection has to land for slowing down to matter. */
  minEarlyMinutes: number;
}

export interface BudgetPacingConfig {
  /** How far back a pace is measured. Older samples are dropped. */
  paceLookbackMinutes: number;
  /** Shortest span that counts as a measurement. Below it there is no pace, only two numbers. */
  minObservationMinutes: number;
  /** A usage snapshot older than this is not evidence of anything; the leg skips the sweep. */
  staleUsageMinutes: number;
  /** Below this much time to the reset, nothing a leader does now changes the outcome. */
  minActionableMinutes: number;
  /** How long before the same window may repeat the same direction. */
  repeatAfterMinutes: number;
  /** Points the gap must have grown by for a repeat to carry new information. */
  repeatWorseningPct: number;
  /** Hard ceiling per window per direction per reset cycle. */
  maxAdvisoriesPerCycle: number;
  speedUp: BudgetPacingSpeedUpConfig;
  slowDown: BudgetPacingSlowDownConfig;
}

export interface BudgetPacingSpeedUpSettings {
  enabled?: boolean;
  horizonMinutes?: number;
  paceRatio?: number;
  minStrandedPct?: number;
  minRemainingPct?: number;
}

export interface BudgetPacingSlowDownSettings {
  enabled?: boolean;
  paceRatio?: number;
  maxRemainingPct?: number;
  minOvershootPct?: number;
  minEarlyMinutes?: number;
}

export interface BudgetPacingSettings {
  enabled?: boolean;
  dryRun?: boolean;
  paceLookbackMinutes?: number;
  minObservationMinutes?: number;
  staleUsageMinutes?: number;
  minActionableMinutes?: number;
  repeatAfterMinutes?: number;
  repeatWorseningPct?: number;
  maxAdvisoriesPerCycle?: number;
  speedUp?: BudgetPacingSpeedUpSettings;
  slowDown?: BudgetPacingSlowDownSettings;
}

function resolveSpeedUp(
  settings: BudgetPacingSpeedUpSettings | undefined,
): BudgetPacingSpeedUpConfig {
  return {
    enabled: settings?.enabled ?? true,
    horizonMinutes: settings?.horizonMinutes ?? DEFAULT_SPEED_UP_HORIZON_MINUTES,
    paceRatio: settings?.paceRatio ?? DEFAULT_SPEED_UP_PACE_RATIO,
    minStrandedPct: settings?.minStrandedPct ?? DEFAULT_SPEED_UP_MIN_STRANDED_PCT,
    minRemainingPct: settings?.minRemainingPct ?? DEFAULT_SPEED_UP_MIN_REMAINING_PCT,
  };
}

function resolveSlowDown(
  settings: BudgetPacingSlowDownSettings | undefined,
): BudgetPacingSlowDownConfig {
  return {
    enabled: settings?.enabled ?? true,
    paceRatio: settings?.paceRatio ?? DEFAULT_SLOW_DOWN_PACE_RATIO,
    maxRemainingPct: settings?.maxRemainingPct ?? DEFAULT_SLOW_DOWN_MAX_REMAINING_PCT,
    minOvershootPct: settings?.minOvershootPct ?? DEFAULT_SLOW_DOWN_MIN_OVERSHOOT_PCT,
    minEarlyMinutes: settings?.minEarlyMinutes ?? DEFAULT_SLOW_DOWN_MIN_EARLY_MINUTES,
  };
}

export function resolveBudgetPacingConfig(settings: BudgetPacingSettings): BudgetPacingConfig {
  return {
    paceLookbackMinutes: settings.paceLookbackMinutes ?? DEFAULT_PACE_LOOKBACK_MINUTES,
    minObservationMinutes: settings.minObservationMinutes ?? DEFAULT_MIN_OBSERVATION_MINUTES,
    staleUsageMinutes: settings.staleUsageMinutes ?? DEFAULT_STALE_USAGE_MINUTES,
    minActionableMinutes: settings.minActionableMinutes ?? DEFAULT_MIN_ACTIONABLE_MINUTES,
    repeatAfterMinutes: settings.repeatAfterMinutes ?? DEFAULT_REPEAT_AFTER_MINUTES,
    repeatWorseningPct: settings.repeatWorseningPct ?? DEFAULT_REPEAT_WORSENING_PCT,
    maxAdvisoriesPerCycle: settings.maxAdvisoriesPerCycle ?? DEFAULT_MAX_ADVISORIES_PER_CYCLE,
    speedUp: resolveSpeedUp(settings.speedUp),
    slowDown: resolveSlowDown(settings.slowDown),
  };
}
/**
 * One usage reading, timestamped by when the provider snapshot was taken rather than by the
 * sweep that read it. The daemon's usage cache serves the same snapshot for five minutes, so
 * sweep time would invent movement between two reads of one number.
 */
export interface BudgetPacingSample {
  fetchedAtMs: number;
  usedPct: number;
}

export interface BudgetPacingDelivery {
  count: number;
  lastAtMs: number;
  /** The gap, in points of the window, at the moment it was last said. */
  lastGapPct: number;
}

export interface BudgetPacingWindowTrack {
  /**
   * The reset this window is counting down to. A new one means the window rolled over: the
   * samples describe a budget that no longer exists, and every direction re-arms.
   */
  cycleKey: string;
  samples: readonly BudgetPacingSample[];
  delivered: Partial<Record<BudgetPacingDirection, BudgetPacingDelivery>>;
}

export type BudgetPacingMemory = Map<string, BudgetPacingWindowTrack>;

/** Per-agent facts the pacing leg needs: which account it spends on, and whether it is a leader. */
export interface BudgetPacingAgentInput {
  id: string;
  provider: string;
  internal: boolean;
  /** A subagent. It does not choose the fan-out strategy, so it is never told. */
  isDelegated: boolean;
  isRunning: boolean;
  /** Weighted tokens/min, for naming who is spending the window. */
  tokenRate: number | undefined;
}

export interface BudgetPacingAlternative {
  providerId: string;
  displayName: string;
  remainingPct: number;
}

export interface BudgetPacingAdvisory {
  direction: BudgetPacingDirection;
  /** `providerId:windowId`, the key its delivery bookkeeping lives under. */
  trackKey: string;
  providerId: string;
  providerDisplayName: string;
  windowLabel: string;
  remainingPct: number;
  minutesToReset: number;
  resetsAt: string;
  observedPctPerMin: number;
  requiredPctPerMin: number;
  /**
   * The gap in points of the window: what will expire unused (`speedUp`), or what the account
   * would want beyond what it has (`slowDown`). One unit for both directions so one repeat
   * threshold governs both.
   */
  gapPct: number;
  /** `slowDown` only: where the current pace lands, and how early that is. */
  minutesToExhaust: number | null;
  earlyByMinutes: number | null;
  observationMinutes: number;
  observationSamples: number;
  usageAgeMinutes: number;
  runningAgentsOnAccount: number;
  accountTokenRatePerMinute: number;
  /** The other worker accounts' same window, so the advice can name where to send work. */
  alternatives: readonly BudgetPacingAlternative[];
}

export interface PlanBudgetPacingAdviceInput {
  usage: readonly ProviderUsage[];
  /** When the snapshot was taken, from the usage service's own `fetchedAt`. */
  usageFetchedAtMs: number;
  /** Accounts whose `params.accountPool.role` is `worker` — the ones subagents spend on. */
  workerProviderIds: ReadonlySet<string>;
  agents: readonly BudgetPacingAgentInput[];
  previous: BudgetPacingMemory | undefined;
  config: BudgetPacingConfig;
  nowMs: number;
}

export interface PlanBudgetPacingAdviceResult {
  /** Most urgent first. The monitor delivers at most the first one per sweep. */
  advisories: BudgetPacingAdvisory[];
  memory: BudgetPacingMemory;
  /** Running root agents. Empty means there is nobody the advice is for. */
  leaderIds: string[];
  /** Why a sweep produced nothing, for the log. Absent when it produced advisories. */
  skipped: BudgetPacingSkipReason | null;
}

export type BudgetPacingSkipReason =
  | "stale-usage"
  | "no-worker-accounts"
  | "no-measurable-window"
  | "no-window-past-threshold";

const MS_PER_MINUTE = 60_000;

/** A reading the account can be paced against: it has a number and a deadline. */
interface MeasuredWindow {
  trackKey: string;
  providerId: string;
  providerDisplayName: string;
  windowId: string;
  windowLabel: string;
  remainingPct: number;
  usedPct: number;
  resetsAt: string;
  minutesToReset: number;
  requiredPctPerMin: number;
  /** Null when the samples do not yet span `minObservationMinutes`. */
  observedPctPerMin: number | null;
  observationMinutes: number;
  observationSamples: number;
}

function minutesBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / MS_PER_MINUTE;
}

function parseResetsAt(resetsAt: string | null | undefined): number | null {
  if (typeof resetsAt !== "string") return null;
  const parsed = Date.parse(resetsAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRemainingPct(window: ProviderUsageWindow, usedPct: number): number {
  return typeof window.remainingPct === "number" ? window.remainingPct : 100 - usedPct;
}

function appendSample(
  track: BudgetPacingWindowTrack | undefined,
  cycleKey: string,
  sample: BudgetPacingSample,
  config: BudgetPacingConfig,
  nowMs: number,
): BudgetPacingWindowTrack {
  const carried = track?.cycleKey === cycleKey ? track : undefined;
  const cutoffMs = nowMs - config.paceLookbackMinutes * MS_PER_MINUTE;
  const kept = (carried?.samples ?? []).filter((entry) => entry.fetchedAtMs >= cutoffMs);
  const newest = kept[kept.length - 1];
  // The cache serves one snapshot for minutes at a time; re-recording it would shorten the
  // measured span without adding an observation.
  const samples = newest?.fetchedAtMs === sample.fetchedAtMs ? kept : [...kept, sample];
  return { cycleKey, samples, delivered: carried?.delivered ?? {} };
}

interface ObservedPace {
  pctPerMin: number | null;
  spanMinutes: number;
  samples: number;
}

/**
 * The pace the window has actually been consumed at. Differencing the endpoints of the sample
 * span rather than fitting anything: the samples are five minutes apart at best, so there is no
 * curve to fit, and the endpoints are what the reader can check against the Host Usage screen.
 *
 * A negative delta — a provider revising a figure down — reads as no burn rather than as a
 * refund; nothing here should ever advise on the strength of an account gaining capacity back.
 */
function measurePace(
  samples: readonly BudgetPacingSample[],
  config: BudgetPacingConfig,
): ObservedPace {
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  if (!oldest || !newest) {
    return { pctPerMin: null, spanMinutes: 0, samples: samples.length };
  }
  const spanMinutes = minutesBetween(oldest.fetchedAtMs, newest.fetchedAtMs);
  if (spanMinutes < config.minObservationMinutes) {
    return { pctPerMin: null, spanMinutes, samples: samples.length };
  }
  const pctPerMin = Math.max(0, (newest.usedPct - oldest.usedPct) / spanMinutes);
  return { pctPerMin, spanMinutes, samples: samples.length };
}

interface WindowReading {
  window: ProviderUsageWindow;
  usedPct: number;
  resetsAt: string;
  resetsAtMs: number;
}

/** A window with an unreadable percentage or no deadline cannot be paced against. */
function readWindow(window: ProviderUsageWindow): WindowReading | null {
  const usedPct = window.usedPct;
  const resetsAtMs = parseResetsAt(window.resetsAt);
  if (typeof usedPct !== "number" || resetsAtMs === null || !window.resetsAt) return null;
  return { window, usedPct, resetsAt: window.resetsAt, resetsAtMs };
}

function measureWindows(
  input: PlanBudgetPacingAdviceInput,
  memory: BudgetPacingMemory,
): MeasuredWindow[] {
  const { config, nowMs } = input;
  const measured: MeasuredWindow[] = [];
  for (const provider of input.usage) {
    if (!input.workerProviderIds.has(provider.providerId) || provider.status !== "available") {
      continue;
    }
    for (const window of provider.windows) {
      const reading = readWindow(window);
      if (!reading) continue;
      const trackKey = `${provider.providerId}:${window.id}`;
      const track = appendSample(
        memory.get(trackKey),
        reading.resetsAt,
        { fetchedAtMs: input.usageFetchedAtMs, usedPct: reading.usedPct },
        config,
        nowMs,
      );
      memory.set(trackKey, track);

      const minutesToReset = minutesBetween(nowMs, reading.resetsAtMs);
      if (minutesToReset <= 0) continue;
      const remainingPct = readRemainingPct(window, reading.usedPct);
      const pace = measurePace(track.samples, config);
      measured.push({
        trackKey,
        providerId: provider.providerId,
        providerDisplayName: provider.displayName,
        windowId: window.id,
        windowLabel: window.label,
        remainingPct,
        usedPct: reading.usedPct,
        resetsAt: reading.resetsAt,
        minutesToReset,
        requiredPctPerMin: remainingPct / minutesToReset,
        observedPctPerMin: pace.pctPerMin,
        observationMinutes: pace.spanMinutes,
        observationSamples: pace.samples,
      });
    }
  }
  return measured;
}

interface AccountBurn {
  runningAgents: number;
  tokenRatePerMinute: number;
}

/**
 * Running agents per account and what they are burning between them. Nothing else in the daemon
 * aggregates the per-agent weighted rate by provider; the pacing leg needs it only to name who
 * is spending a window, never to pace it — the pct-of-window delta already covers every charge
 * to the account, including work started outside Paseo.
 */
function summarizeAccountBurn(agents: readonly BudgetPacingAgentInput[]): Map<string, AccountBurn> {
  const byAccount = new Map<string, AccountBurn>();
  for (const agent of agents) {
    if (agent.internal || !agent.isRunning) continue;
    const carried = byAccount.get(agent.provider) ?? { runningAgents: 0, tokenRatePerMinute: 0 };
    byAccount.set(agent.provider, {
      runningAgents: carried.runningAgents + 1,
      tokenRatePerMinute: carried.tokenRatePerMinute + (agent.tokenRate ?? 0),
    });
  }
  return byAccount;
}

/**
 * Whether this account may be told to spend harder. The pace of one window says nothing about
 * the one that will actually cap first, so a nearly-spent or measurably over-pace window
 * anywhere on the account vetoes the whole account.
 */
function accountAcceptsSpeedUp(
  windows: readonly MeasuredWindow[],
  config: BudgetPacingConfig,
): boolean {
  return windows.every((window) => {
    if (window.remainingPct < config.speedUp.minRemainingPct) return false;
    if (window.observedPctPerMin === null || window.requiredPctPerMin <= 0) return true;
    return window.observedPctPerMin / window.requiredPctPerMin < config.slowDown.paceRatio;
  });
}

function alternativesFor(
  window: MeasuredWindow,
  measured: readonly MeasuredWindow[],
): BudgetPacingAlternative[] {
  return measured
    .filter(
      (candidate) =>
        candidate.windowId === window.windowId && candidate.providerId !== window.providerId,
    )
    .sort((a, b) => b.remainingPct - a.remainingPct)
    .map((candidate) => ({
      providerId: candidate.providerId,
      displayName: candidate.providerDisplayName,
      remainingPct: candidate.remainingPct,
    }));
}

interface CandidateInput {
  window: MeasuredWindow;
  observedPctPerMin: number;
  measured: readonly MeasuredWindow[];
  burn: AccountBurn | undefined;
  config: BudgetPacingConfig;
  usageAgeMinutes: number;
}

function buildAdvisory(
  input: CandidateInput,
  direction: BudgetPacingDirection,
  gapPct: number,
  projection: { minutesToExhaust: number | null; earlyByMinutes: number | null },
): BudgetPacingAdvisory {
  const { window, burn } = input;
  return {
    direction,
    trackKey: window.trackKey,
    providerId: window.providerId,
    providerDisplayName: window.providerDisplayName,
    windowLabel: window.windowLabel,
    remainingPct: window.remainingPct,
    minutesToReset: window.minutesToReset,
    resetsAt: window.resetsAt,
    observedPctPerMin: input.observedPctPerMin,
    requiredPctPerMin: window.requiredPctPerMin,
    gapPct,
    minutesToExhaust: projection.minutesToExhaust,
    earlyByMinutes: projection.earlyByMinutes,
    observationMinutes: window.observationMinutes,
    observationSamples: window.observationSamples,
    usageAgeMinutes: input.usageAgeMinutes,
    runningAgentsOnAccount: burn?.runningAgents ?? 0,
    accountTokenRatePerMinute: burn?.tokenRatePerMinute ?? 0,
    alternatives: alternativesFor(window, input.measured),
  };
}

function planSlowDown(input: CandidateInput): BudgetPacingAdvisory | null {
  const { window, config, observedPctPerMin } = input;
  const settings = config.slowDown;
  if (!settings.enabled || observedPctPerMin <= 0 || window.remainingPct <= 0) return null;
  if (window.remainingPct > settings.maxRemainingPct) return null;
  if (observedPctPerMin / window.requiredPctPerMin < settings.paceRatio) return null;

  const demandedPct = observedPctPerMin * window.minutesToReset;
  const overshootPct = demandedPct - window.remainingPct;
  if (overshootPct < settings.minOvershootPct) return null;

  const minutesToExhaust = window.remainingPct / observedPctPerMin;
  const earlyByMinutes = window.minutesToReset - minutesToExhaust;
  if (earlyByMinutes < settings.minEarlyMinutes) return null;

  return buildAdvisory(input, "slowDown", overshootPct, { minutesToExhaust, earlyByMinutes });
}

function planSpeedUp(input: CandidateInput): BudgetPacingAdvisory | null {
  const { window, config, observedPctPerMin, measured } = input;
  const settings = config.speedUp;
  if (!settings.enabled) return null;
  if (window.minutesToReset > settings.horizonMinutes) return null;
  if (window.minutesToReset < config.minActionableMinutes) return null;
  if (window.requiredPctPerMin <= 0) return null;
  if (observedPctPerMin / window.requiredPctPerMin > settings.paceRatio) return null;

  const accountWindows = measured.filter((candidate) => candidate.providerId === window.providerId);
  if (!accountAcceptsSpeedUp(accountWindows, config)) return null;

  const projectedUsePct = observedPctPerMin * window.minutesToReset;
  const strandedPct = window.remainingPct - projectedUsePct;
  if (strandedPct < settings.minStrandedPct) return null;

  return buildAdvisory(input, "speedUp", strandedPct, {
    minutesToExhaust: null,
    earlyByMinutes: null,
  });
}

/**
 * Whether this advisory has anything left to say. An unheeded nudge repeats exactly once, and
 * only on measured deterioration: a second identical message cannot add information, but a gap
 * that has grown by `repeatWorseningPct` while the deadline came closer is a different fact.
 */
function isWorthSaying(
  advisory: BudgetPacingAdvisory,
  track: BudgetPacingWindowTrack | undefined,
  config: BudgetPacingConfig,
  nowMs: number,
): boolean {
  const delivered = track?.delivered[advisory.direction];
  if (!delivered) return true;
  if (delivered.count >= config.maxAdvisoriesPerCycle) return false;
  if (minutesBetween(delivered.lastAtMs, nowMs) < config.repeatAfterMinutes) return false;
  return advisory.gapPct - delivered.lastGapPct >= config.repeatWorseningPct;
}

/** Slowing down outranks speeding up: capping early strands work, wasting capacity does not. */
function compareUrgency(a: BudgetPacingAdvisory, b: BudgetPacingAdvisory): number {
  if (a.direction !== b.direction) return a.direction === "slowDown" ? -1 : 1;
  if (a.direction === "slowDown") {
    return (a.minutesToExhaust ?? 0) - (b.minutesToExhaust ?? 0);
  }
  return a.minutesToReset - b.minutesToReset;
}

export function planBudgetPacingAdvice(
  input: PlanBudgetPacingAdviceInput,
): PlanBudgetPacingAdviceResult {
  const { config, nowMs } = input;
  const memory: BudgetPacingMemory = new Map(input.previous ?? []);
  const leaderIds = input.agents
    .filter((agent) => !agent.internal && !agent.isDelegated && agent.isRunning)
    .map((agent) => agent.id);
  const empty = { advisories: [], memory, leaderIds };

  const usageAgeMinutes = minutesBetween(input.usageFetchedAtMs, nowMs);
  if (usageAgeMinutes > config.staleUsageMinutes) {
    return { ...empty, skipped: "stale-usage" };
  }
  if (input.workerProviderIds.size === 0) {
    return { ...empty, skipped: "no-worker-accounts" };
  }

  const measured = measureWindows(input, memory);
  const burnByAccount = summarizeAccountBurn(input.agents);
  const advisories: BudgetPacingAdvisory[] = [];
  let measurable = 0;
  for (const window of measured) {
    if (window.observedPctPerMin === null) continue;
    measurable += 1;
    const candidateInput: CandidateInput = {
      window,
      observedPctPerMin: window.observedPctPerMin,
      measured,
      burn: burnByAccount.get(window.providerId),
      config,
      usageAgeMinutes,
    };
    const candidate = planSlowDown(candidateInput) ?? planSpeedUp(candidateInput);
    if (candidate && isWorthSaying(candidate, memory.get(window.trackKey), config, nowMs)) {
      advisories.push(candidate);
    }
  }

  advisories.sort(compareUrgency);
  if (advisories.length > 0) {
    return { advisories, memory, leaderIds, skipped: null };
  }
  return {
    ...empty,
    skipped: measurable === 0 ? "no-measurable-window" : "no-window-past-threshold",
  };
}

/**
 * Records that an advisory was said, so the next sweep does not say it again. Called only when
 * it reached somebody: an advisory nobody was there to hear stays available, which is what
 * makes a sleeping fleet's unused capacity get mentioned the moment a leader starts working.
 */
export function recordBudgetPacingDelivery(
  memory: BudgetPacingMemory,
  advisory: BudgetPacingAdvisory,
  nowMs: number,
): void {
  const track = memory.get(advisory.trackKey);
  if (!track) return;
  const previous = track.delivered[advisory.direction];
  memory.set(advisory.trackKey, {
    ...track,
    delivered: {
      ...track.delivered,
      [advisory.direction]: {
        count: (previous?.count ?? 0) + 1,
        lastAtMs: nowMs,
        lastGapPct: advisory.gapPct,
      },
    },
  });
}
