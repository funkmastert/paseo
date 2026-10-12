import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexGuardBootHealthScheduler,
  nextCodexGuardSelfTestCheckDelayMs,
  CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS,
  CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS,
  type CodexGuardBootHealthDeps,
} from "./codex-guard-boot-health.js";
import {
  getCodexGuardHealthState,
  resetCodexGuardHealthStateForTests,
} from "./codex-guard-health.js";

function fakeDeps(overrides: Partial<CodexGuardBootHealthDeps> = {}): CodexGuardBootHealthDeps {
  return {
    findDefaultCodexBinary: async () => "/usr/local/bin/codex",
    resolveBinaryVersion: async () => "0.160.0",
    fetchCodexCatalogModels: async () => [{ id: "gpt-6-luna" }],
    runSelfTest: async () => {},
    ...overrides,
  };
}

describe("nextCodexGuardSelfTestCheckDelayMs", () => {
  it("returns the normal hourly cadence with no skips", () => {
    expect(nextCodexGuardSelfTestCheckDelayMs(0)).toBe(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS);
  });

  it("climbs through the bounded backoff for consecutive skips", () => {
    expect(nextCodexGuardSelfTestCheckDelayMs(1)).toBe(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]);
    expect(nextCodexGuardSelfTestCheckDelayMs(2)).toBe(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[1]);
    expect(nextCodexGuardSelfTestCheckDelayMs(3)).toBe(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[2]);
    expect(nextCodexGuardSelfTestCheckDelayMs(4)).toBe(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[3]);
  });

  it("settles into the hourly cadence once the backoff runs out of steps", () => {
    expect(
      nextCodexGuardSelfTestCheckDelayMs(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.length + 1),
    ).toBe(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS);
    expect(nextCodexGuardSelfTestCheckDelayMs(100)).toBe(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS);
  });
});

describe("createCodexGuardBootHealthScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodexGuardHealthStateForTests();
  });

  it("records why it skipped when no Codex binary is found, and retries on the short backoff", async () => {
    const findDefaultCodexBinary = vi.fn(async () => null);
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ findDefaultCodexBinary }));

    await scheduler.checkNow();

    expect(getCodexGuardHealthState()).toMatchObject({
      status: "unknown",
      reason: "No Codex binary was found on this host.",
    });
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(2); // retried within a minute, not an hour

    scheduler.stop();
  });

  it("records why it skipped when the Codex catalog returns no models", async () => {
    const scheduler = createCodexGuardBootHealthScheduler(
      fakeDeps({ fetchCodexCatalogModels: async () => [] }),
    );

    await scheduler.checkNow();

    expect(getCodexGuardHealthState()).toMatchObject({
      status: "unknown",
      reason: "The Codex catalog returned no models.",
    });

    scheduler.stop();
  });

  it("climbs the full backoff sequence across consecutive skips, then settles into the hourly cadence", async () => {
    const findDefaultCodexBinary = vi.fn(async () => null);
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ findDefaultCodexBinary }));

    await scheduler.checkNow();
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(1);

    for (const [index, delayMs] of CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delayMs);
      expect(findDefaultCodexBinary).toHaveBeenCalledTimes(index + 2);
    }

    // The backoff is exhausted (the loop above already produced one call per backoff step, plus
    // the initial checkNow -- CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.length + 1 calls so far): the
    // still-skipping scheduler now waits the hourly cadence, not the backoff's last step again.
    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.at(-1)!);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(
      CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.length + 1,
    );
    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(
      CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS.length + 2,
    );

    scheduler.stop();
  });

  it("never overwrites an already-proven green verdict with a skip's unknown", async () => {
    const { setCodexGuardHealthState } = await import("./codex-guard-health.js");
    setCodexGuardHealthState({
      status: "green",
      reason: "self-test passed",
      codexVersion: "0.160.0",
    });
    const findDefaultCodexBinary = vi.fn(async () => null);
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ findDefaultCodexBinary }));

    await scheduler.checkNow();

    expect(getCodexGuardHealthState()).toMatchObject({ status: "green" });

    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(2); // still retries on the short backoff

    scheduler.stop();
  });

  it("never overwrites an already-proven red verdict with a skip's unknown", async () => {
    const { setCodexGuardHealthState } = await import("./codex-guard-health.js");
    setCodexGuardHealthState({
      status: "red",
      reason: "self-test failed",
      codexVersion: "0.160.0",
    });
    const scheduler = createCodexGuardBootHealthScheduler(
      fakeDeps({ fetchCodexCatalogModels: async () => [] }),
    );

    await scheduler.checkNow();

    expect(getCodexGuardHealthState()).toMatchObject({ status: "red" });

    scheduler.stop();
  });

  it("treats a self-test that resolves without proving anything as a skip, on the short backoff", async () => {
    // runSelfTest resolves normally (no infra throw) but never calls setCodexGuardHealthState --
    // the real shape of a self-test that hit a timeout or a failed createSession.
    const runSelfTest = vi.fn(async () => {});
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ runSelfTest }));

    await scheduler.checkNow();

    expect(runSelfTest).toHaveBeenCalledTimes(1);
    expect(getCodexGuardHealthState().status).toBe("unknown");

    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]);
    expect(runSelfTest).toHaveBeenCalledTimes(2); // retried within a minute, not an hour

    scheduler.stop();
  });

  it("resets the backoff and returns to the hourly cadence once a tick actually runs", async () => {
    let binaryFound = false;
    const findDefaultCodexBinary = vi.fn(async () => (binaryFound ? "/usr/local/bin/codex" : null));
    const runSelfTest = vi.fn(async () => {
      const { setCodexGuardHealthState } = await import("./codex-guard-health.js");
      setCodexGuardHealthState({
        status: "green",
        reason: "self-test passed",
        codexVersion: "0.160.0",
      });
    });
    const scheduler = createCodexGuardBootHealthScheduler(
      fakeDeps({ findDefaultCodexBinary, runSelfTest }),
    );

    await scheduler.checkNow(); // skip: no binary
    expect(getCodexGuardHealthState().status).toBe("unknown");

    binaryFound = true;
    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]); // retries, finds it, runs
    expect(runSelfTest).toHaveBeenCalledTimes(1);

    // Back to the hourly cadence: advancing by the first backoff step again must NOT trigger
    // another check yet.
    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("does not schedule another tick after stop()", async () => {
    const findDefaultCodexBinary = vi.fn(async () => null);
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ findDefaultCodexBinary }));

    await scheduler.checkNow();
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_NORMAL_INTERVAL_MS * 2);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(1); // no further ticks
  });

  it("does not run the self-test, or change health state, when it isn't due yet", async () => {
    const runSelfTest = vi.fn(async () => {});
    resetCodexGuardHealthStateForTests();
    // A prior green verdict for this exact Codex version, timestamped now: not due again for a day.
    const { setCodexGuardHealthState } = await import("./codex-guard-health.js");
    setCodexGuardHealthState({
      status: "green",
      reason: "self-test passed",
      codexVersion: "0.160.0",
    });
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ runSelfTest }));

    await scheduler.checkNow();

    expect(runSelfTest).not.toHaveBeenCalled();
    expect(getCodexGuardHealthState().status).toBe("green"); // untouched

    scheduler.stop();
  });

  it("retries an unexpected error on the short backoff without touching health state", async () => {
    resetCodexGuardHealthStateForTests();
    const findDefaultCodexBinary = vi.fn(async () => {
      throw new Error("probe crashed");
    });
    const scheduler = createCodexGuardBootHealthScheduler(fakeDeps({ findDefaultCodexBinary }));

    await scheduler.checkNow();
    expect(getCodexGuardHealthState().reason).toBe("No self-test has run yet."); // untouched

    await vi.advanceTimersByTimeAsync(CODEX_GUARD_SELF_TEST_RETRY_BACKOFF_MS[0]);
    expect(findDefaultCodexBinary).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});
