import type { HealthTracker } from "./health";
import { createIntervalPoller } from "./interval-poller";
import { detectModelFamily, weeklyModelWindow } from "./windows";

/**
 * Minimal shape this module needs from `paseo.providers.listUsage()`'s
 * result (see `ProviderUsageListResponseMessage` payload / `ProviderUsage` /
 * `ProviderUsageWindow` in the Paseo protocol package): a list of provider
 * rows, each carrying a list of usage windows keyed by window id.
 */
export interface UsagePollWindowRow {
  id: string;
  usedPct?: number | null;
  resetsAt?: string | null;
}

export interface UsagePollProviderRow {
  providerId: string;
  windows: UsagePollWindowRow[];
}

export interface UsagePollResult {
  providers: UsagePollProviderRow[];
}

export type FetchUsageFn = () => Promise<UsagePollResult>;

export interface UsagePollerOptions {
  /** Injected usage fetcher; production wires this to `paseo.providers.listUsage()`. */
  fetchUsage: FetchUsageFn;
  /** Refresh interval in milliseconds. Defaults to 5 minutes. */
  intervalMs?: number;
  /** Injectable for tests; defaults to the global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Injectable for tests; defaults to the global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
}

export interface UsagePoller {
  /** Fetches immediately and feeds the tracker, without waiting for the interval. */
  pollOnce(): Promise<void>;
  /** Stops the refresh interval. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

const WEEKLY_MODEL_WIRE_ID_PATTERN = /^weekly_model_(.+)$/;

/**
 * Normalizes a wire window id to the tracker's canonical window key. The
 * daemon's `weekly_model_<name>` suffix isn't guaranteed to already be a
 * canonical family label (it can be `limit.id` or an arbitrary normalized
 * name) — route it through `detectModelFamily` so it lands on the same
 * window key `health.ts` looks up via `weeklyModelWindow(family)`.
 */
function normalizeWindowId(id: string): string {
  const match = id.match(WEEKLY_MODEL_WIRE_ID_PATTERN);
  if (!match) {
    return id;
  }
  const suffix = match[1];
  const family = detectModelFamily(suffix);
  return family ? weeklyModelWindow(family) : id;
}

/**
 * Polls `fetchUsage()` on an interval and feeds readings into a
 * HealthTracker. A fetch failure leaves tracker state untouched — it is
 * never treated as a cap signal. A provider absent from the payload (e.g.
 * before the daemon reports per-account usage) is likewise left alone: no
 * reading means no change.
 */
export function createUsagePoller(tracker: HealthTracker, options: UsagePollerOptions): UsagePoller {
  const { fetchUsage } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  const poller = createIntervalPoller({
    intervalMs,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      let result: UsagePollResult;
      try {
        result = await fetchUsage();
      } catch {
        return;
      }

      for (const provider of result.providers ?? []) {
        const readings = provider.windows.map((window) => ({
          window: normalizeWindowId(window.id),
          usedPct: window.usedPct ?? null,
          resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
        }));
        tracker.reportUsage(provider.providerId, readings);
      }
    },
  });

  return {
    pollOnce: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
