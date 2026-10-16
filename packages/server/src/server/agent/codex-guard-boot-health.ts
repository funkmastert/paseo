/**
 * Schedules the Codex guard self-test (bootstrap.ts) and records WHY a tick skipped running it:
 * the daemon's own hourly tick could otherwise silently return on a missing binary, an empty
 * catalog, or a self-test that resolves without proving anything, leaving health stuck at its
 * starting "No self-test has run yet." with nothing in `daemon.log` saying which happened, and
 * the next attempt up to an hour away. A skip never overwrites an already-proven green or red
 * verdict -- it only records a reason and reschedules when health is still unknown.
 */
import {
  getCodexGuardHealthState,
  setCodexGuardHealthState,
  shouldRunCodexGuardSelfTest,
  type CodexGuardHealthLogger,
} from "./codex-guard-health.js";

/** A skip (no binary, empty catalog, or an unexpected error) retries on this short bounded
 * backoff instead of waiting the full hourly cadence -- a host that briefly lacks a Codex binary
 * or catalog recovers within minutes, not up to an hour later. */
export const CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS = [
  60_000, // 1 min
  2 * 60_000, // 2 min
  5 * 60_000, // 5 min
  10 * 60_000, // 10 min
] as const;

export const CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS = 60 * 60 * 1000;

/** The delay before the next tick, given how many consecutive times in a row this scheduler had
 * to skip rather than actually run (or complete) the self-test. Climbs through the bounded
 * backoff, then settles into the normal hourly cadence once it runs out of steps. */
export function nextCodexGuardSelfTestCheckDelayMs(consecutiveSkips: number): number {
  if (consecutiveSkips <= 0 || consecutiveSkips > CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.length) {
    return CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS;
  }
  return CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[consecutiveSkips - 1];
}

export interface CodexGuardBootHealthDeps {
  findDefaultCodexBinary(): Promise<string | null>;
  resolveBinaryVersion(binaryPath: string): Promise<string | null>;
  /** The Codex catalog's models, already fetched -- bootstrap.ts owns the probe client and its
   * own refresh deadline; this only needs the result. */
  fetchCodexCatalogModels(): Promise<ReadonlyArray<{ id: string }>>;
  runSelfTest(input: { model: string; codexVersion: string | null }): Promise<void>;
  logger?: CodexGuardHealthLogger;
}

export interface CodexGuardBootHealthScheduler {
  /** Runs one tick immediately, outside the schedule -- used for the first check at boot. */
  checkNow(): Promise<void>;
  /** Cancels the pending timer, if any. A tick already running still finishes, but schedules no
   * further one. */
  stop(): void;
}

/**
 * Picks the catalog's `luna` model when present, else its first entry -- same preference
 * bootstrap.ts's self-test probe always used.
 */
function pickSelfTestModel(models: ReadonlyArray<{ id: string }>): { id: string } | undefined {
  return models.find((candidate) => candidate.id.includes("luna")) ?? models[0];
}

export function createCodexGuardBootHealthScheduler(
  deps: CodexGuardBootHealthDeps,
): CodexGuardBootHealthScheduler {
  let consecutiveSkips = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleNext(delayMs: number): void {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void check();
    }, delayMs);
    timer.unref?.();
  }

  function recordSkip(reason: string): void {
    consecutiveSkips += 1;
    // A proven green or red verdict stays: only an already-unknown health state (the common
    // case -- a tick skipping before the first self-test ever completes) gets this skip's reason
    // written onto it. Overwriting a proven verdict with "unknown" would un-prove it on nothing
    // more than a transient missing binary or empty catalog.
    if (getCodexGuardHealthState().status === "unknown") {
      setCodexGuardHealthState({ status: "unknown", reason, codexVersion: null }, deps.logger);
    }
    scheduleNext(nextCodexGuardSelfTestCheckDelayMs(consecutiveSkips));
  }

  function recordRanOrNotDue(): void {
    consecutiveSkips = 0;
    scheduleNext(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS);
  }

  async function check(): Promise<void> {
    try {
      const binaryPath = await deps.findDefaultCodexBinary();
      if (!binaryPath) {
        recordSkip("No Codex binary was found on this host.");
        return;
      }
      const codexVersion = await deps.resolveBinaryVersion(binaryPath);
      if (!shouldRunCodexGuardSelfTest(getCodexGuardHealthState(), Date.now(), codexVersion)) {
        recordRanOrNotDue();
        return;
      }
      const models = await deps.fetchCodexCatalogModels();
      const model = pickSelfTestModel(models);
      if (!model) {
        recordSkip("The Codex catalog returned no models.");
        return;
      }
      await deps.runSelfTest({ model: model.id, codexVersion });
      // A self-test that hit an infrastructure error (a timeout, a failed createSession) resolves
      // normally but leaves health exactly where it started: unknown. That is not proof of
      // anything -- treat it as a skip, on the short backoff, rather than recordRanOrNotDue's
      // hourly wait for a guard that was never actually exercised.
      const resultingHealth = getCodexGuardHealthState();
      if (resultingHealth.status === "unknown") {
        recordSkip(resultingHealth.reason);
        return;
      }
      recordRanOrNotDue();
    } catch (error) {
      // An unexpected error (a thrown probe, a network failure) is not proof of anything about
      // the guard itself -- unlike a skip, this does not touch health state -- but it still
      // retries on the short backoff rather than waiting a full hour to try again.
      deps.logger?.warn({ err: error }, "Codex guard self-test scheduling failed");
      consecutiveSkips += 1;
      scheduleNext(nextCodexGuardSelfTestCheckDelayMs(consecutiveSkips));
    }
  }

  return {
    checkNow: check,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
