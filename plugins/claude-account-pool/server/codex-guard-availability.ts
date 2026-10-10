import type { PluginHookContext } from "@getpaseo/plugin/server";
import { createIntervalPoller } from "./interval-poller";

/**
 * What the role hook knows about the Codex guard on this host, from `codexGuard.status` polled
 * every 60 seconds (docs/codex-workers.md, "Guard health"). Undefined until a poll answers, and
 * again after one fails, so a stale "healthy" never outlives the daemon that said it. Undefined
 * means every `codex/` ref is unusable (guards-first, KTD-3) -- the same fail-closed default
 * `isCodexRefUsable` already applies to a missing `isGuardHealthy`.
 */
export interface CodexGuardAvailabilitySnapshot {
  /**
   * True only when the daemon's last self-test verdict was `green` AND recent (within
   * `MAX_HEALTH_AGE_HOURS`). `unknown`, `red`, and a green verdict gone stale all read false --
   * the daemon's own hourly check (`bootstrap.ts`) and daily self-test interval should always
   * keep a healthy guard's `checkedAt` well inside that window.
   */
  healthy: boolean;
  /** Currently-running Codex child agents, for `agentModelPolicy.codex.maxChildren` (KTD-9). */
  runningChildren: number;
}

export interface CodexGuardCache {
  /**
   * The last poll's snapshot, with every unexpired `reserve()` call added onto
   * `runningChildren` (code-review finding, round 1). `reserve()`/`get()` close a check-then-act
   * gap: a 60 s poll is stale the instant a create lands, so three back-to-back creates against a
   * two-under-cap polled count would otherwise all read "usable" before any of them shows up in a
   * poll.
   */
  get(): CodexGuardAvailabilitySnapshot | undefined;
  /**
   * Records an in-flight Codex create: call this the moment the classifier selects a `codex/`
   * ref, before the create has had any chance to show up in a poll. Expires when a poll whose
   * request went out after this call resolves (the daemon's own count by then already reflects
   * whichever of these turned into real agents), or after `RESERVATION_TTL_MS` as a safety net
   * for a create that errored before ever reaching the daemon.
   */
  reserve(): void;
  refresh(): Promise<CodexGuardAvailabilitySnapshot | undefined>;
}

export interface CodexGuardAvailability extends CodexGuardCache {
  stop(): void;
}

type CodexGuardActions = NonNullable<PluginHookContext["paseo"]["codexGuard"]>;
/** The slice of the plugin's Paseo handle this needs. `codexGuard` is absent on a daemon without the RPC. */
export type CodexGuardAvailabilityPaseo = {
  readonly codexGuard?: Partial<Pick<CodexGuardActions, "status">>;
};
type CodexGuardStatus = Awaited<ReturnType<CodexGuardActions["status"]>>;

const DEFAULT_INTERVAL_MS = 60_000;
/**
 * How long to stop asking a daemon that does not know `codexGuard.status`. A plugin child started
 * from a newer app than the running daemon has `paseo.codexGuard`, but the daemon rejects every
 * request, and logs a warning for each, until it is relaunched.
 */
export const UNKNOWN_RPC_BACKOFF_MS = 10 * 60_000;
/** `codexGuard.status` reads daemon memory; anything slower is a daemon in trouble. */
const STATUS_TIMEOUT_MS = 5_000;
/**
 * Guards-first (KTD-3): a `green` verdict older than this counts the same as none. The self-test
 * runs at daemon start and is re-checked hourly (`bootstrap.ts`'s `checkCodexGuardSelfTest`), so a
 * healthy guard's `checkedAt` is ordinarily well inside this window; this only catches a daemon
 * whose scheduling has stopped.
 */
const MAX_HEALTH_AGE_HOURS = 26;
/**
 * How long an unexpired reservation (`CodexGuardCache.reserve`) keeps counting against the cap
 * when no poll ever resolves after it -- mirrors `codex-guard-session.ts`'s
 * `RECENT_CREATE_WINDOW_MS` on the daemon side, which exists for the same reason: a burst of
 * creates must not sail past `maxChildren` just because the daemon hasn't reported them back yet.
 */
const RESERVATION_TTL_MS = 15 * 60 * 1000;

const TIMED_OUT = Symbol("timed-out");

async function withinBound<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** A daemon that does not know the request answers with this `rpc_error` code. */
function isUnknownRpc(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "unknown_schema";
}

/** Reads a status into the snapshot. Pure; exported for tests. */
export function snapshotOf(status: CodexGuardStatus, now: () => number = Date.now): CodexGuardAvailabilitySnapshot {
  const checkedAtMs = new Date(status.checkedAt).getTime();
  const ageHours = Number.isFinite(checkedAtMs) ? (now() - checkedAtMs) / (60 * 60 * 1000) : Infinity;
  return {
    healthy: status.status === "green" && ageHours <= MAX_HEALTH_AGE_HOURS,
    runningChildren: status.runningChildren,
  };
}

export function createCodexGuardAvailability(
  paseo: CodexGuardAvailabilityPaseo,
  options: {
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    /** Tests only. */
    now?: () => number;
  } = {},
): CodexGuardAvailability {
  const now = options.now ?? Date.now;
  let current: CodexGuardAvailabilitySnapshot | undefined;
  let quietUntil = 0;
  // Timestamps of in-flight `reserve()` calls not yet accounted for by a poll (code-review
  // finding, round 1). Pruned on every read/write by TTL, and on a successful poll by the poll's
  // own start time -- see the two prune calls below for which rule applies where.
  let reservations: number[] = [];

  function dropExpiredReservations(): void {
    const nowMs = now();
    reservations = reservations.filter((reservedAt) => nowMs - reservedAt < RESERVATION_TTL_MS);
  }

  const poller = createIntervalPoller({
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    run: async () => {
      const pollStartedAt = now();
      try {
        // COMPAT(codexGuardPaseoApi): added in v0.9.x. A daemon without the RPC has no
        // `paseo.codexGuard`, or has it from a newer plugin child and rejects the request; either
        // way the snapshot stays undefined and no `codex/` ref is usable (guards-first, KTD-3).
        const codexGuard = paseo.codexGuard;
        if (typeof codexGuard?.status !== "function" || now() < quietUntil) {
          current = undefined;
          return current;
        }
        const status = await withinBound(codexGuard.status({ timeout: STATUS_TIMEOUT_MS }), STATUS_TIMEOUT_MS);
        if (status === TIMED_OUT) {
          current = undefined;
        } else {
          current = snapshotOf(status, now);
          // This poll's request went out at pollStartedAt, after every reservation made before
          // that moment -- the daemon's own runningChildren by now already reflects whichever of
          // those turned into real agents, so keeping them would double count from here on.
          reservations = reservations.filter((reservedAt) => reservedAt >= pollStartedAt);
        }
      } catch (error) {
        current = undefined;
        if (isUnknownRpc(error)) {
          quietUntil = now() + UNKNOWN_RPC_BACKOFF_MS;
        }
      }
      return current;
    },
  });
  return {
    get: () => {
      dropExpiredReservations();
      if (!current) return undefined;
      return reservations.length === 0
        ? current
        : { ...current, runningChildren: current.runningChildren + reservations.length };
    },
    reserve: () => {
      dropExpiredReservations();
      reservations.push(now());
    },
    refresh: () => poller.runOnce(),
    stop: () => poller.stop(),
  };
}
