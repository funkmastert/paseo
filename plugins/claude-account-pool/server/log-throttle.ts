/**
 * Per-key log throttle: a given key logs at most once per window, with every
 * other call for that key in between silently dropped. Fail-open and
 * classification paths must never block agent creation, so a burst of
 * requests hitting the same failure (a stuck provider snapshot, a role that
 * keeps failing to resolve) would otherwise log identically once per
 * request. Throttling keeps the daemon log readable without hiding that the
 * condition is ongoing — the first occurrence in each window still logs.
 */
export interface LogThrottleOptions {
  /** Minimum ms between two logs sharing the same key. Default 60_000. */
  windowMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export type LogThrottle = (key: string, log: () => void) => void;

export function createLogThrottle(options: LogThrottleOptions = {}): LogThrottle {
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const lastLoggedAt = new Map<string, number>();

  return function throttledLog(key, log) {
    const nowMs = now();
    const last = lastLoggedAt.get(key);
    if (last !== undefined && nowMs - last < windowMs) {
      return;
    }
    lastLoggedAt.set(key, nowMs);
    log();
  };
}
