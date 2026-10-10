import { describe, expect, test } from "vitest";
import {
  classifyGap,
  DEFAULT_STALL_THRESHOLDS,
  StallTracker,
  type StallThresholds,
  type TickSample,
} from "./stall-tracker.js";

const T: StallThresholds = DEFAULT_STALL_THRESHOLDS; // tick 250, slow 500, wedge 5000, suspend 2000

// The monotonic gap follows the wall gap unless a test says the machine slept.
function classify(overrides: Partial<Parameters<typeof classifyGap>[0]>) {
  const wallGapMs = overrides.wallGapMs ?? T.tickMs;
  return classifyGap({
    thresholds: T,
    wallGapMs,
    monoGapMs: wallGapMs,
    cpuDeltaMs: 0,
    watchdogPausedMs: 0,
    watchdogSilentMs: 0,
    ...overrides,
  });
}

describe("classifyGap: a suspended process is not a wedge", () => {
  test("a 60 s gap where the watchdog thread also stopped is a suspension with no blocked time", () => {
    const episode = classify({
      wallGapMs: 60_250,
      monoGapMs: 60_250,
      cpuDeltaMs: 1,
      watchdogPausedMs: 60_000,
    });
    expect(episode).toMatchObject({ kind: "suspension", blockedMs: 0, suspendedMs: 60_000 });
    expect(episode?.cpuRatio).toBeLessThan(0.01);
  });

  test("the watchdog losing the race to publish still reads as suspension from its silence", () => {
    // The main thread ticks first after resume; the watchdog has not run yet, so nothing is
    // published. Its last tick is as old as the gap.
    const episode = classify({ wallGapMs: 30_250, monoGapMs: 30_250, watchdogSilentMs: 30_240 });
    expect(episode).toMatchObject({ kind: "suspension", blockedMs: 0, suspendedMs: 30_000 });
  });

  test("system sleep is caught by the monotonic clock even with no watchdog signal", () => {
    // The lid was closed for 8 h: the wall clock advanced, the monotonic clock did not.
    const episode = classify({ wallGapMs: 28_800_250, monoGapMs: 250 });
    expect(episode).toMatchObject({ kind: "suspension", blockedMs: 0, sleptMs: 28_800_000 });
  });

  test("a gap that was mostly suspension does not report the suspended part as blocked", () => {
    const episode = classify({ wallGapMs: 10_250, watchdogPausedMs: 9_900, cpuDeltaMs: 300 });
    // The 100 ms left over is under the slow threshold; the gap is a suspension, never a stall.
    expect(episode).toMatchObject({ kind: "suspension", blockedMs: 100, suspendedMs: 9_900 });
  });
});

describe("classifyGap: a blocked event loop is a wedge", () => {
  test("a 30 s block in JS is a busy wedge", () => {
    const episode = classify({ wallGapMs: 30_250, monoGapMs: 30_250, cpuDeltaMs: 29_500 });
    expect(episode).toMatchObject({ kind: "wedge", blockedMs: 30_000, suspendedMs: 0 });
    expect(episode?.cause).toBe("busy");
    expect(episode?.cpuRatio).toBeGreaterThan(0.9);
  });

  test("a 30 s block in a synchronous wait burns no CPU but is still a wedge", () => {
    // The case a CPU-time check alone gets wrong: it looks exactly like a suspension. The
    // watchdog thread kept ticking, which is what separates them.
    const episode = classify({
      wallGapMs: 30_250,
      monoGapMs: 30_250,
      cpuDeltaMs: 40,
      watchdogSilentMs: 200,
    });
    expect(episode).toMatchObject({ kind: "wedge", blockedMs: 30_000 });
    expect(episode?.cause).toBe("blocked");
  });

  test("a wedge that straddled a suspension reports only the blocked time", () => {
    // 8 s blocked, then 60 s asleep, all before the next tick.
    const episode = classify({
      wallGapMs: 68_250,
      monoGapMs: 68_250,
      watchdogPausedMs: 60_000,
      cpuDeltaMs: 7_800,
    });
    expect(episode).toMatchObject({ kind: "wedge", blockedMs: 8_000, suspendedMs: 60_000 });
    expect(episode?.cause).toBe("busy");
  });
});

describe("classifyGap: thresholds", () => {
  test("normal timer jitter is nothing", () => {
    expect(classify({ wallGapMs: 262, monoGapMs: 262 })).toBeNull();
  });

  test("a stall just under the slow threshold is nothing, just over is a stall", () => {
    expect(classify({ wallGapMs: T.tickMs + T.slowStallMs - 1 })).toBeNull();
    expect(classify({ wallGapMs: T.tickMs + T.slowStallMs })?.kind).toBe("stall");
  });

  test("a stall just under the wedge threshold is a stall, at it is a wedge", () => {
    expect(classify({ wallGapMs: T.tickMs + T.wedgeMs - 1 })?.kind).toBe("stall");
    expect(classify({ wallGapMs: T.tickMs + T.wedgeMs })?.kind).toBe("wedge");
  });

  test("a pause shorter than the suspend threshold and the slow threshold is ignored", () => {
    expect(classify({ wallGapMs: 400, watchdogPausedMs: 150 })).toBeNull();
  });

  test("silence shorter than the suspend threshold is a busy machine, not a suspension", () => {
    // 3 s late, watchdog quiet for 1.5 s: real, blocked time, not a paused process.
    const episode = classify({ wallGapMs: 3_250, watchdogSilentMs: 1_500 });
    expect(episode).toMatchObject({ kind: "stall", blockedMs: 3_000, suspendedMs: 0 });
  });
});

describe("StallTracker", () => {
  function sample(overrides: Partial<TickSample> & { wallMs: number }): TickSample {
    return {
      monoMs: overrides.wallMs,
      cpuMs: 0,
      watchdogTickWallMs: overrides.wallMs,
      watchdogPausedTotalMs: 0,
      ...overrides,
    };
  }

  test("reports nothing on the first tick and on healthy ticks", () => {
    const tracker = new StallTracker(T);
    expect(tracker.onTick(sample({ wallMs: 1_000 }))).toBeNull();
    expect(tracker.onTick(sample({ wallMs: 1_250 }))).toBeNull();
    expect(tracker.onTick(sample({ wallMs: 1_502 }))).toBeNull();
  });

  test("a resume from suspension is one suspension episode, not a wedge", () => {
    const tracker = new StallTracker(T);
    tracker.onTick(sample({ wallMs: 1_000, cpuMs: 100 }));
    const episode = tracker.onTick(
      sample({
        wallMs: 121_000,
        monoMs: 121_000,
        cpuMs: 101,
        watchdogTickWallMs: 120_990,
        watchdogPausedTotalMs: 119_750,
      }),
    );
    expect(episode).toMatchObject({
      kind: "suspension",
      startedAtMs: 1_000,
      endedAtMs: 121_000,
      blockedMs: 0,
    });
  });

  test("a wedge while the watchdog kept ticking is a wedge", () => {
    const tracker = new StallTracker(T);
    tracker.onTick(sample({ wallMs: 1_000, cpuMs: 0 }));
    const episode = tracker.onTick(
      sample({ wallMs: 41_000, monoMs: 41_000, cpuMs: 39_000, watchdogTickWallMs: 40_900 }),
    );
    expect(episode).toMatchObject({ kind: "wedge", blockedMs: 39_750, cause: "busy" });
  });

  test("a pause published after a tick is not charged to a later, on-time interval", () => {
    const tracker = new StallTracker(T);
    tracker.onTick(sample({ wallMs: 1_000 }));
    // Main thread ticks first after a 30 s resume: silence says suspension.
    const resume = tracker.onTick(
      sample({ wallMs: 31_000, watchdogTickWallMs: 1_000, watchdogPausedTotalMs: 0 }),
    );
    expect(resume?.kind).toBe("suspension");
    // The watchdog then publishes its 30 s pause. The next tick is on time and consumes it.
    expect(tracker.onTick(sample({ wallMs: 31_250, watchdogPausedTotalMs: 29_750 }))).toBeNull();
    // A later real stall is judged on its own, with nothing left over to hide it.
    const stall = tracker.onTick(
      sample({ wallMs: 34_250, watchdogTickWallMs: 34_240, watchdogPausedTotalMs: 29_750 }),
    );
    expect(stall).toMatchObject({ kind: "stall", blockedMs: 2_750, suspendedMs: 0 });
  });
});
