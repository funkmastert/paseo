import { classify } from "./classify";
import { WINDOW_ACCOUNT, WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, modelWindowFor } from "./windows";

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
  /** How long a window stays in probation before auto-healing if no turn completes. Default 30min. */
  probationTtlMs?: number;
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
  /** True when the account may still be used as a last resort (e.g. only drained, not capped). */
  isLastResortEligible(providerId: string): boolean;
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
  /** Debug/notification snapshot of every tracked (providerId, window) pair. */
  snapshot(): HealthSnapshot;
  /** Subscribes to cap/recovery transitions. Returns an unsubscribe function. */
  onChange(listener: (event: CapEvent) => void): () => void;
}

const DEFAULT_DRAIN_THRESHOLD_PCT = 90;
const DEFAULT_CAP_THRESHOLD_PCT = 100;
const DEFAULT_CAP_TTL_MS = 5 * 60 * 60 * 1000;
const DEFAULT_PROBATION_TTL_MS = 30 * 60 * 1000;

interface InternalWindowState {
  status: WindowStatus;
  resetsAt?: Date;
  /** capped -> probation deadline: resetsAt if known, else now()+defaultCapTtlMs at cap time. */
  capExpiry?: Date;
  /** probation -> healthy deadline, set when entering probation. */
  probationExpiry?: Date;
  utilizationPct?: number;
}

function relevantWindows(modelId: string): string[] {
  const windows = [WINDOW_ACCOUNT, WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY];
  const modelWindow = modelWindowFor(modelId);
  if (modelWindow) {
    windows.push(modelWindow);
  }
  return windows;
}

export function createHealthTracker(options: HealthTrackerOptions = {}): HealthTracker {
  const now = options.now ?? (() => new Date());
  const drainThresholdPct = options.drainThresholdPct ?? DEFAULT_DRAIN_THRESHOLD_PCT;
  const capThresholdPct = options.capThresholdPct ?? DEFAULT_CAP_THRESHOLD_PCT;
  const defaultCapTtlMs = options.defaultCapTtlMs ?? DEFAULT_CAP_TTL_MS;
  const probationTtlMs = options.probationTtlMs ?? DEFAULT_PROBATION_TTL_MS;

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
        state.probationExpiry = new Date(currentTime + probationTtlMs);
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
    if (wasCappedLineage) {
      emit({ providerId, window, kind: "recovered" });
    }
  }

  function toCapped(providerId: string, window: string, state: InternalWindowState, resetsAt?: Date): void {
    const currentTime = now().getTime();
    state.status = "capped";
    state.resetsAt = resetsAt;
    state.capExpiry = resetsAt ?? new Date(currentTime + defaultCapTtlMs);
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
    const state = getSettled(providerId, window);
    if (state.status === "capped") {
      return;
    }
    toCapped(providerId, window, state, classification.resetsAt);
  }

  function reportUsage(providerId: string, readings: UsageWindowReading[]): void {
    for (const reading of readings) {
      if (reading.usedPct === undefined || reading.usedPct === null) {
        continue;
      }
      const state = getSettled(providerId, reading.window);
      state.utilizationPct = reading.usedPct;
      if (reading.resetsAt) {
        state.resetsAt = reading.resetsAt;
      }

      if (reading.usedPct >= capThresholdPct) {
        if (state.status !== "capped") {
          toCapped(providerId, reading.window, state, reading.resetsAt ?? undefined);
        }
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
    return relevantWindows(modelId).every((window) => {
      const state = getSettled(providerId, window);
      return state.status === "healthy" || state.status === "probation";
    });
  }

  function isLastResortEligible(providerId: string): boolean {
    const providerWindows = windowsFor(providerId);
    for (const [window, state] of providerWindows) {
      settle(providerId, window, state);
      if (state.status === "capped") {
        return false;
      }
    }
    return true;
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
    isHealthyForAllWindows,
    windowUtilization,
    snapshot,
    onChange,
  };
}
