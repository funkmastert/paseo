import { describe, expect, it } from "vitest";
import { createHealthTracker } from "./health";
import { DEFAULT_HORIZON_MS, NEUTRAL_SCORE, rankByHeadroom, scoreAccount, windowScore } from "./headroom";
import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, weeklyModelWindow } from "./windows";

const NOW = new Date("2026-09-22T12:00:00Z");
const NOW_MS = NOW.getTime();
const SONNET = "claude-sonnet-5";

function trackerAtNow() {
  return createHealthTracker({ now: () => NOW });
}

const hours = (n: number) => new Date(NOW_MS + n * 60 * 60 * 1000);

describe("windowScore", () => {
  it("is the free percentage when the reset is beyond the horizon", () => {
    expect(windowScore(30, hours(72), NOW_MS, DEFAULT_HORIZON_MS)).toBe(30);
  });

  it("is the free percentage when no reset time is known", () => {
    expect(windowScore(30, undefined, NOW_MS, DEFAULT_HORIZON_MS)).toBe(30);
  });

  it("ranks 20% free resetting in an hour above 30% free resetting on Friday", () => {
    const soon = windowScore(20, hours(1), NOW_MS, DEFAULT_HORIZON_MS);
    const friday = windowScore(30, hours(72), NOW_MS, DEFAULT_HORIZON_MS);
    expect(soon).toBeGreaterThan(friday);
  });

  it("counts a reset already due in full", () => {
    expect(windowScore(5, hours(-1), NOW_MS, DEFAULT_HORIZON_MS)).toBe(100);
  });
});

describe("scoreAccount", () => {
  it("scores an account with no readings as empty, so a missing poll demotes nobody", () => {
    expect(scoreAccount(trackerAtNow(), "worker-a", SONNET, NOW_MS)).toBe(NEUTRAL_SCORE);
  });

  it("takes the tightest window, not the average", () => {
    const tracker = trackerAtNow();
    tracker.reportUsage("worker-a", [
      { window: WINDOW_FIVE_HOUR, usedPct: 5, resetsAt: null },
      { window: WINDOW_SEVEN_DAY, usedPct: 98, resetsAt: null },
    ]);
    // 98% used on the weekly window leaves 2 free, and no reset time to discount against.
    expect(scoreAccount(tracker, "worker-a", SONNET, NOW_MS)).toBe(2);
  });

  it("includes an observed window the model's own window list never names", () => {
    const tracker = trackerAtNow();
    // A weekly Opus cap bounds a Sonnet spawn's account even though relevantWindows(sonnet)
    // never lists it — the account is the thing being scored, not the model.
    tracker.reportUsage("worker-a", [{ window: weeklyModelWindow("opus"), usedPct: 99, resetsAt: null }]);
    expect(scoreAccount(tracker, "worker-a", SONNET, NOW_MS)).toBe(1);
  });
});

describe("rankByHeadroom", () => {
  const candidates = [
    { providerId: "worker-a", priority: 1 },
    { providerId: "worker-b", priority: 2 },
    { providerId: "backup", priority: 3 },
  ];

  it("keeps the operator's priority order when there are no usage readings at all", () => {
    const ranked = rankByHeadroom(candidates, trackerAtNow(), SONNET, NOW_MS);
    expect(ranked.map((c) => c.providerId)).toEqual(["worker-a", "worker-b", "backup"]);
  });

  it("puts the barely-used backup first even though it is last by priority", () => {
    const tracker = trackerAtNow();
    tracker.reportUsage("worker-a", [{ window: WINDOW_SEVEN_DAY, usedPct: 77, resetsAt: null }]);
    tracker.reportUsage("worker-b", [{ window: WINDOW_SEVEN_DAY, usedPct: 77, resetsAt: null }]);
    tracker.reportUsage("backup", [{ window: WINDOW_SEVEN_DAY, usedPct: 12, resetsAt: null }]);

    const ranked = rankByHeadroom(candidates, tracker, SONNET, NOW_MS);
    expect(ranked.map((c) => c.providerId)).toEqual(["backup", "worker-a", "worker-b"]);
  });

  it("breaks a scoring tie on priority, so ranking stays deterministic", () => {
    const tracker = trackerAtNow();
    for (const id of ["worker-a", "worker-b", "backup"]) {
      tracker.reportUsage(id, [{ window: WINDOW_SEVEN_DAY, usedPct: 40, resetsAt: null }]);
    }
    const ranked = rankByHeadroom(candidates, tracker, SONNET, NOW_MS);
    expect(ranked.map((c) => c.providerId)).toEqual(["worker-a", "worker-b", "backup"]);
  });

  it("prefers a nearly-empty window that resets within the hour over a fuller one that resets on Friday", () => {
    const tracker = trackerAtNow();
    tracker.reportUsage("worker-a", [{ window: WINDOW_FIVE_HOUR, usedPct: 80, resetsAt: hours(1) }]);
    tracker.reportUsage("worker-b", [{ window: WINDOW_SEVEN_DAY, usedPct: 70, resetsAt: hours(72) }]);

    const ranked = rankByHeadroom(
      [
        { providerId: "worker-a", priority: 1 },
        { providerId: "worker-b", priority: 2 },
      ],
      tracker,
      SONNET,
      NOW_MS,
    );
    expect(ranked[0]?.providerId).toBe("worker-a");
  });
});
