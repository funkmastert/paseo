export interface IntervalPollerOptions<T> {
  /** Performs one poll cycle. Errors should be handled internally by the caller. */
  run: () => Promise<T>;
  /** Interval between automatic runs, in milliseconds. */
  intervalMs: number;
  /** Injectable for tests; defaults to the global setInterval. */
  setIntervalFn?: typeof setInterval;
  /** Injectable for tests; defaults to the global clearInterval. */
  clearIntervalFn?: typeof clearInterval;
}

export interface IntervalPoller<T> {
  /** Runs immediately, deduping against any run already in flight. */
  runOnce(): Promise<T>;
  /** Stops the interval. Safe to call more than once. */
  stop(): void;
}

/**
 * Runs `run()` on a fixed interval, deduping concurrent calls to runOnce()
 * (and interval ticks) against any run already in flight so overlapping
 * triggers share a single underlying call.
 */
export function createIntervalPoller<T>(options: IntervalPollerOptions<T>): IntervalPoller<T> {
  const { run, intervalMs } = options;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let pending: Promise<T> | null = null;

  function runOnce(): Promise<T> {
    if (!pending) {
      pending = run().finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  const timer = setIntervalFn(() => {
    void runOnce();
  }, intervalMs);

  return {
    runOnce,
    stop: () => clearIntervalFn(timer),
  };
}
