import { classify } from "./classify";
import {
  WINDOW_ACCOUNT,
  WINDOW_FIVE_HOUR,
  WINDOW_SEVEN_DAY,
  isOtherModelWindow,
  isWeeklyWindow,
  modelWindowFor,
} from "./windows";

export type WindowStatus = "healthy" | "drained" | "capped" | "probation";

export interface WindowSnapshot {
  status: WindowStatus;
  /** Known reset time for a cap/probation, when the source provided one. */
  resetsAt?: Date;
  /** Last observed utilization percent (0-100) from a usage reading, if any. */
  utilizationPct?: number;
}

/** One provider's windows, keyed by window id (e.g. "account", "five_hour", "weekly_model_opus"). */
export type ProviderSnapshot = Record<string, WindowSnapshot>;

export type HealthSnapshot = Record<string, ProviderSnapshot>;

export interface CapEvent {
  providerId: string;
  window: string;
  kind: "capped" | "recovered";
  /** The known reset time (cap) or TTL expiry that drove the transition, when applicable. */
  resetsAt?: Date;
}

export interface UsageWindowReading {
  window: string;
  /** 0-100. Null/undefined means "no reading for this window" — no change. */
  usedPct?: number | null;
  resetsAt?: Date | null;
}

export interface HealthTrackerOptions {
  /** Injectable clock so tests can use fake timers. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Utilization percent (0-100) at/above which a window is considered drained. Default 90. */
  drainThresholdPct?: number;
  /** Utilization percent (0-100) at/above which a window is considered capped. Default 100. */
  capThresholdPct?: number;
  /** Fallback cap duration when a reactive failure carries no parseable reset time. Default 5h. */
  defaultCapTtlMs?: number;
  /**
   * Fallback cap duration for a WEEKLY window with no knowable reset time. Default 7 days.
   *
   * Separate from defaultCapTtlMs because the two windows recover on completely different
   * clocks, and using the 5-hour figure for both is how a weekly-exhausted account came back
   * into rotation the same afternoon it died. The daemon's weekly rows carry `resets_at`
   * nullishly (quota-fetcher/providers/claude.ts), so "no reset time" is a real state, not a
   * defensive one — and every time it occurs the 5-hour default would promote a window that is
   * dead for days to `probation`, which is routable.
   */
  weeklyCapTtlMs?: number;
  /** How long a window stays in probation before auto-healing if no turn completes. Default 30min. */
  probationTtlMs?: number;
  /**
   * Cooldown before an auth-failure cap (see classify.ts's AUTH_FAILURE_PATTERN)
   * is retried. Unlike a usage cap, a logged-out account has no reset time and
   * no guarantee it will ever heal on its own, so this is deliberately much
   * shorter than defaultCapTtlMs — it only throttles retries, matching the
   * usage poller's own 5-minute cadence (usage-poll.ts's DEFAULT_INTERVAL_MS)
   * rather than assuming a fixed downtime. Default 5min.
   */
  authFailureCapTtlMs?: number;
}

export interface HealthTracker {
  /** Reactive signal: classifies a turn-failure message and caps the relevant window(s). */
  reportTurnFailure(providerId: string, message: string): void;
  /** Proactive signal: feeds per-window usage readings. Windows not present are left untouched. */
  reportUsage(providerId: string, windows: UsageWindowReading[]): void;
  /** A turn completed successfully: any window in probation for this provider heals to healthy. */
  noteTurnCompleted(providerId: string): void;
  /** True when the account is usable for a fresh spawn of the given model. */
  isHealthyFor(providerId: string, modelId: string): boolean;
  /**
   * True when the account may still be used as a last resort (e.g. only drained, not capped).
   * With a model named, only the windows a spawn of that model must get past count: a capped
   * Sonnet week does not stop an Opus spawn. With none, any capped window disqualifies.
   */
  isLastResortEligible(providerId: string, modelId?: string): boolean;
  /**
   * True when a window the spawn must get past (every window with no model named, as for
   * isLastResortEligible) is capped on evidence that may refuse a spawn: a usage reading at the
   * cap, or refusal-grade text (classify.ts's REFUSAL_LIMIT_PATTERN). A cap read only from the
   * CLI's per-window refusal text rules the account out of isLastResortEligible but not in here,
   * so it ranks the account last without making a pool count as exhausted.
   */
  isExhaustedFor(providerId: string, modelId?: string): boolean;
  /**
   * True when every window ever observed for this account is usable (healthy or
   * probation). Used for model-less spawns, where no model-scoped window can be
   * picked so any known cap — including a per-model weekly one — disqualifies.
   */
  isHealthyForAllWindows(providerId: string): boolean;
  /**
   * Last observed utilization percent (0-100) for one (provider, window), or
   * undefined when no usage reading has ever covered it. Drives the per-model
   * budget gate, which needs "how full is this window" rather than the
   * coarser healthy/drained/capped status.
   */
  windowUtilization(providerId: string, window: string): number | undefined;
  /**
   * Hours since the last usage reading covered this (provider, window), or undefined when none
   * ever has. Codex's budget reserve (KTD-9) treats a stale reading as no reading at all --
   * deliberately stricter than the per-model budget gate above, which treats "no reading" as
   * within budget.
   */
  windowReadingAgeHours(providerId: string, window: string): number | undefined;
  /**
   * The settled state of one (provider, window), or undefined when nothing has ever been
   * observed for it. Unlike `windowUtilization` it also answers "when does this come back",
   * which is what headroom scoring needs to tell a window resetting within the hour apart from
   * one resetting on Friday.
   */
  describeWindow(providerId: string, window: string): WindowSnapshot | undefined;
  /** Every window id ever observed for one provider, settled. */
  windowIds(providerId: string): string[];
  /** Debug/notification snapshot of every tracked (providerId, window) pair. */
  snapshot(): HealthSnapshot;
  /** Subscribes to cap/recovery transitions. Returns an unsubscribe function. */
  onChange(listener: (event: CapEvent) => void): () => void;
}

const DEFAULT_DRAIN_THRESHOLD_PCT = 90;
const DEFAULT_CAP_THRESHOLD_PCT = 100;
const DEFAULT_CAP_TTL_MS = 5 * 60 * 60 * 1000;
const DEFAULT_WEEKLY_CAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PROBATION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_AUTH_FAILURE_CAP_TTL_MS = 5 * 60 * 1000;

interface InternalWindowState {
  status: WindowStatus;
  resetsAt?: Date;
  /** capped -> probation deadline: resetsAt if known, else now()+defaultCapTtlMs at cap time. */
  capExpiry?: Date;
  /** probation -> healthy deadline, set when entering probation. */
  probationExpiry?: Date;
  utilizationPct?: number;
  /** When `utilizationPct` was last set by a usage reading. */
  lastReadingAt?: Date;
  /**
   * True when the current/last cap was an auth failure (see classify.ts).
   * Drives settle(): an auth-failure cap's probation stage has no
   * probationExpiry, so it never auto-heals on trust — only a completed
   * turn (noteTurnCompleted) proves the account is usable again.
   */
  authFailure?: boolean;
  /**
   * True while the current cap rests only on the CLI's per-window refusal text. Cleared by a usage
   * reading at the cap or by refusal-grade text for the same window.
   */
  placementOnly?: boolean;
}

/**
 * The windows a spawn of `modelId` actually has to get past. Exported so headroom scoring
 * ranks accounts on the same windows that decide whether they are usable at all — scoring a
 * window the health check ignores (or ignoring one it enforces) is how a "best" account turns
 * out to be the one that is capped.
 */
export function relevantWindows(modelId: string): string[] {
  const windows = [WINDOW_ACCOUNT, WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY];
  const modelWindow = modelWindowFor(modelId);
  if (modelWindow) {
    windows.push(modelWindow);
  }
  return windows;
}

/**
 * Every window that gates a spawn of `modelId` on one account: `relevantWindows`'s static list,
 * plus any window already observed for the account that `isOtherModelWindow` doesn't rule out.
 *
 * `relevantWindows` alone misses three live cases, because it can only name the one model-scoped
 * window it recognizes for `modelId`'s own family: a `weekly_surface_*` window (stops every
 * model, never in the static list at all), a `weekly_model_*` window whose family isn't in
 * `MODEL_FAMILIES` (e.g. a new model family), and any model-scoped window at all when `modelId`
 * itself doesn't resolve to a known family (an unset or unmapped model, held to every window —
 * the same convention the daemon's `windowLimitsModel` uses, see account-pool-headroom.ts). In
 * all three the daemon counts the account dead for the spawn; missing the window here let the
 * pool place the spawn there anyway.
 */
export function gatingWindowIds(modelId: string, observedWindowIds: readonly string[]): string[] {
  return [...new Set([...relevantWindows(modelId), ...observedWindowIds])].filter(
    (window) => !isOtherModelWindow(window, modelId),
  );
}

export function createHealthTracker(options: HealthTrackerOptions = {}): HealthTracker {
  const now = options.now ?? (() => new Date());
  const drainThresholdPct = options.drainThresholdPct ?? DEFAULT_DRAIN_THRESHOLD_PCT;
  const capThresholdPct = options.capThresholdPct ?? DEFAULT_CAP_THRESHOLD_PCT;
  const defaultCapTtlMs = options.defaultCapTtlMs ?? DEFAULT_CAP_TTL_MS;
  const weeklyCapTtlMs = options.weeklyCapTtlMs ?? DEFAULT_WEEKLY_CAP_TTL_MS;
  const probationTtlMs = options.probationTtlMs ?? DEFAULT_PROBATION_TTL_MS;
  const authFailureCapTtlMs = options.authFailureCapTtlMs ?? DEFAULT_AUTH_FAILURE_CAP_TTL_MS;

  const windowsByProvider = new Map<string, Map<string, InternalWindowState>>();
  const listeners = new Set<(event: CapEvent) => void>();

  function emit(event: CapEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function windowsFor(providerId: string): Map<string, InternalWindowState> {
    let providerWindows = windowsByProvider.get(providerId);
    if (!providerWindows) {
      providerWindows = new Map();
      windowsByProvider.set(providerId, providerWindows);
    }
    return providerWindows;
  }

  /** Lazily resolves TTL/reset expiries for one window. May emit a "recovered" event. */
  function settle(providerId: string, window: string, state: InternalWindowState): void {
    const currentTime = now().getTime();

    if (state.status === "capped") {
      const expiry = state.capExpiry?.getTime();
      if (expiry !== undefined && currentTime >= expiry) {
        state.status = "probation";
        // An auth failure has no reset time to trust — it stays in
        // probation (routable, so the next turn can prove it either way)
        // with no probationExpiry, so the block below never auto-heals it.
        state.probationExpiry = state.authFailure ? undefined : new Date(currentTime + probationTtlMs);
      }
    }

    if (state.status === "probation") {
      const expiry = state.probationExpiry?.getTime();
      if (expiry !== undefined && currentTime >= expiry) {
        toHealthy(providerId, window, state);
      }
    }
  }

  function toHealthy(providerId: string, window: string, state: InternalWindowState): void {
    const wasCappedLineage = state.status === "capped" || state.status === "probation";
    state.status = "healthy";
    state.resetsAt = undefined;
    state.capExpiry = undefined;
    state.probationExpiry = undefined;
    state.authFailure = false;
    state.placementOnly = false;
    if (wasCappedLineage) {
      emit({ providerId, window, kind: "recovered" });
    }
  }

  function toCapped(
    providerId: string,
    window: string,
    state: InternalWindowState,
    resetsAt?: Date,
    authFailure = false,
    placementOnly = false,
  ): void {
    const currentTime = now().getTime();
    state.status = "capped";
    state.resetsAt = resetsAt;
    state.authFailure = authFailure;
    state.placementOnly = placementOnly;
    // An auth failure is account-wide and retried quickly; otherwise the fallback tracks the
    // window's own clock, so a weekly cap with no reset time doesn't expire on a session-window
    // timer and hand the account back out days early.
    const fallbackTtlMs = authFailure
      ? authFailureCapTtlMs
      : isWeeklyWindow(window)
        ? weeklyCapTtlMs
        : defaultCapTtlMs;
    state.capExpiry = resetsAt ?? new Date(currentTime + fallbackTtlMs);
    state.probationExpiry = undefined;
    emit({ providerId, window, kind: "capped", resetsAt: state.resetsAt ?? state.capExpiry });
  }

  function getSettled(providerId: string, window: string): InternalWindowState {
    const providerWindows = windowsFor(providerId);
    let state = providerWindows.get(window);
    if (!state) {
      state = { status: "healthy" };
      providerWindows.set(window, state);
    }
    settle(providerId, window, state);
    return state;
  }

  function reportTurnFailure(providerId: string, message: string): void {
    const classification = classify(message, now());
    if (!classification.isLimit) {
      return;
    }
    const window = classification.window ?? WINDOW_ACCOUNT;
    const placementOnly = classification.placementOnly === true;
    const state = getSettled(providerId, window);
    if (state.status === "capped") {
      state.placementOnly = state.placementOnly === true && placementOnly;
      return;
    }
    toCapped(providerId, window, state, classification.resetsAt, classification.isAuthFailure, placementOnly);
  }

  function reportUsage(providerId: string, readings: UsageWindowReading[]): void {
    for (const reading of readings) {
      if (reading.usedPct === undefined || reading.usedPct === null) {
        continue;
      }
      const state = getSettled(providerId, reading.window);
      state.utilizationPct = reading.usedPct;
      state.lastReadingAt = now();
      if (reading.resetsAt) {
        state.resetsAt = reading.resetsAt;
      }

      if (reading.usedPct >= capThresholdPct) {
        if (state.status !== "capped") {
          toCapped(providerId, reading.window, state, reading.resetsAt ?? undefined);
        }
        state.placementOnly = false;
        continue;
      }

      if (reading.usedPct >= drainThresholdPct) {
        if (state.status !== "capped") {
          state.status = "drained";
        }
        continue;
      }

      // Below the drain threshold: a healthy usage reading clears any cap/drain for this window.
      if (state.status === "capped" || state.status === "probation") {
        toHealthy(providerId, reading.window, state);
      } else {
        state.status = "healthy";
      }
    }
  }

  function noteTurnCompleted(providerId: string): void {
    const providerWindows = windowsFor(providerId);
    for (const [window, state] of providerWindows) {
      settle(providerId, window, state);
      if (state.status === "probation") {
        toHealthy(providerId, window, state);
      }
    }
  }

  function isHealthyFor(providerId: string, modelId: string): boolean {
    return gatingWindowIds(modelId, windowIds(providerId)).every((window) => {
      const state = getSettled(providerId, window);
      return state.status === "healthy" || state.status === "probation";
    });
  }

  /** The settled windows a spawn of `modelId` must get past; every observed window with none named. */
  function gatingWindows(providerId: string, modelId?: string): InternalWindowState[] {
    if (modelId) {
      return gatingWindowIds(modelId, windowIds(providerId)).map((window) => getSettled(providerId, window));
    }
    const providerWindows = windowsFor(providerId);
    for (const [window, state] of providerWindows) {
      settle(providerId, window, state);
    }
    return [...providerWindows.values()];
  }

  function isLastResortEligible(providerId: string, modelId?: string): boolean {
    return gatingWindows(providerId, modelId).every((state) => state.status !== "capped");
  }

  function isExhaustedFor(providerId: string, modelId?: string): boolean {
    return gatingWindows(providerId, modelId).some((state) => state.status === "capped" && !state.placementOnly);
  }

  function isHealthyForAllWindows(providerId: string): boolean {
    const providerWindows = windowsFor(providerId);
    for (const [window, state] of providerWindows) {
      settle(providerId, window, state);
      if (state.status !== "healthy" && state.status !== "probation") {
        return false;
      }
    }
    return true;
  }

  function windowUtilization(providerId: string, window: string): number | undefined {
    return windowsByProvider.get(providerId)?.get(window)?.utilizationPct;
  }

  function windowReadingAgeHours(providerId: string, window: string): number | undefined {
    const lastReadingAt = windowsByProvider.get(providerId)?.get(window)?.lastReadingAt;
    if (!lastReadingAt) {
      return undefined;
    }
    return (now().getTime() - lastReadingAt.getTime()) / (60 * 60 * 1000);
  }

  function describeWindow(providerId: string, window: string): WindowSnapshot | undefined {
    const state = windowsByProvider.get(providerId)?.get(window);
    if (!state) {
      return undefined;
    }
    settle(providerId, window, state);
    return { status: state.status, resetsAt: state.resetsAt, utilizationPct: state.utilizationPct };
  }

  function windowIds(providerId: string): string[] {
    const providerWindows = windowsByProvider.get(providerId);
    if (!providerWindows) {
      return [];
    }
    for (const [window, state] of providerWindows) {
      settle(providerId, window, state);
    }
    return [...providerWindows.keys()];
  }

  function snapshot(): HealthSnapshot {
    const result: HealthSnapshot = {};
    for (const [providerId, providerWindows] of windowsByProvider) {
      const providerSnapshot: ProviderSnapshot = {};
      for (const [window, state] of providerWindows) {
        settle(providerId, window, state);
        providerSnapshot[window] = {
          status: state.status,
          resetsAt: state.resetsAt,
          utilizationPct: state.utilizationPct,
        };
      }
      result[providerId] = providerSnapshot;
    }
    return result;
  }

  function onChange(listener: (event: CapEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    reportTurnFailure,
    reportUsage,
    noteTurnCompleted,
    isHealthyFor,
    isLastResortEligible,
    isExhaustedFor,
    isHealthyForAllWindows,
    windowUtilization,
    windowReadingAgeHours,
    describeWindow,
    windowIds,
    snapshot,
    onChange,
  };
}
