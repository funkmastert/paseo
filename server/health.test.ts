import { describe, expect, it } from "vitest";
import { createHealthTracker } from "./health";
import { WINDOW_FIVE_HOUR, WINDOW_SEVEN_DAY, weeklyModelWindow } from "./windows";

const PROVIDER = "claude-worker-a";
const OPUS_MODEL = "claude-opus-4-5";
const SONNET_MODEL = "claude-sonnet-5";

function trackerAt(initialNow: string, overrides: Parameters<typeof createHealthTracker>[0] = {}) {
  let now = new Date(initialNow);
  const tracker = createHealthTracker({ now: () => now, ...overrides });
  return {
    tracker,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    set(iso: string) {
      now = new Date(iso);
    },
  };
}

describe("createHealthTracker", () => {
  it("caps the account on limit-shaped failure text; non-limit text is a no-op", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");

    tracker.reportTurnFailure(PROVIDER, "Network timeout, please retry");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);
    expect(tracker.isHealthyFor(PROVIDER, OPUS_MODEL)).toBe(false);
  });

  it("parses reset time from failure text and from a usage reading's resetsAt", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit, resets at 2026-09-10T15:00:00Z");
    const fromFailure = tracker.snapshot()[PROVIDER]?.["account"];
    expect(fromFailure?.resetsAt?.toISOString()).toBe("2026-09-10T15:00:00.000Z");

    const other = "claude-worker-b";
    tracker.reportUsage(other, [
      { window: WINDOW_FIVE_HOUR, usedPct: 95, resetsAt: new Date("2026-09-10T12:00:00Z") },
    ]);
    const fromUsage = tracker.snapshot()[other]?.[WINDOW_FIVE_HOUR];
    expect(fromUsage?.resetsAt?.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("applies a default 5h TTL when no reset time is knowable, and expiry moves capped to probation", () => {
    const { tracker, advance } = trackerAt("2026-09-10T10:00:00Z");

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);

    advance(5 * 60 * 60 * 1000 - 1);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);

    advance(2);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
  });

  it("moves probation to healthy on a completed turn, back to capped on repeat failure, and to healthy on probation TTL expiry", () => {
    const { tracker, advance } = trackerAt("2026-09-10T10:00:00Z", { probationTtlMs: 30 * 60 * 1000 });

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    advance(5 * 60 * 60 * 1000);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);

    tracker.noteTurnCompleted(PROVIDER);
    expect(tracker.snapshot()[PROVIDER]?.["account"]?.status).toBe("healthy");

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);

    advance(5 * 60 * 60 * 1000);
    expect(tracker.snapshot()[PROVIDER]?.["account"]?.status).toBe("probation");
    advance(30 * 60 * 1000);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
    expect(tracker.snapshot()[PROVIDER]?.["account"]?.status).toBe("healthy");
  });

  it("drained skips new spawns but stays last-resort eligible and emits no cap event; recovers when utilization drops", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");
    const events: unknown[] = [];
    tracker.onChange((event) => events.push(event));

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 95, resetsAt: null }]);

    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);
    expect(tracker.isLastResortEligible(PROVIDER)).toBe(true);
    expect(events).toEqual([]);

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 10, resetsAt: null }]);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
    expect(events).toEqual([]);
  });

  it("tracks model-scoped windows independently: a weekly-Opus cap does not evacuate Sonnet work", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit — weekly Opus cap reached");

    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
    expect(tracker.isHealthyFor(PROVIDER, OPUS_MODEL)).toBe(false);
    expect(tracker.snapshot()[PROVIDER]?.[weeklyModelWindow("opus")]?.status).toBe("capped");
  });

  it("leaves state untouched on usage fetch failure (no reading = no change)", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);

    // No matching row for this provider in a usage payload: nothing changes.
    tracker.reportUsage(PROVIDER, []);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);
  });

  it("caps the whole account conservatively when a reactive failure has no window attribution", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");

    expect(tracker.isHealthyFor(PROVIDER, OPUS_MODEL)).toBe(false);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);
    expect(tracker.snapshot()[PROVIDER]?.["account"]?.status).toBe("capped");
  });

  it("emits capped and recovered events exactly once per transition", () => {
    const { tracker, advance } = trackerAt("2026-09-10T10:00:00Z");
    const events: Array<{ providerId: string; window: string; kind: string }> = [];
    tracker.onChange((event) => events.push(event));

    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    tracker.reportTurnFailure(PROVIDER, "You've hit your limit");
    expect(events.filter((e) => e.kind === "capped")).toHaveLength(1);

    advance(5 * 60 * 60 * 1000);
    tracker.noteTurnCompleted(PROVIDER);
    tracker.noteTurnCompleted(PROVIDER);
    expect(events.filter((e) => e.kind === "recovered")).toHaveLength(1);

    expect(events).toEqual([
      expect.objectContaining({ providerId: PROVIDER, window: "account", kind: "capped" }),
      expect.objectContaining({ providerId: PROVIDER, window: "account", kind: "recovered" }),
    ]);
  });

  it("caps a window on a usage reading at the cap threshold, emitting exactly one capped event with the reading's resetsAt", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");
    const events: Array<{ providerId: string; window: string; kind: string; resetsAt?: Date }> = [];
    tracker.onChange((event) => events.push(event));

    tracker.reportUsage(PROVIDER, [
      { window: WINDOW_FIVE_HOUR, usedPct: 100, resetsAt: new Date("2026-09-10T12:00:00Z") },
    ]);

    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("capped");
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.resetsAt?.toISOString()).toBe("2026-09-10T12:00:00.000Z");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);
    expect(tracker.isLastResortEligible(PROVIDER)).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        providerId: PROVIDER,
        window: WINDOW_FIVE_HOUR,
        kind: "capped",
        resetsAt: new Date("2026-09-10T12:00:00Z"),
      }),
    ]);

    // A repeat reading at the cap threshold is idempotent: no second event.
    tracker.reportUsage(PROVIDER, [
      { window: WINDOW_FIVE_HOUR, usedPct: 100, resetsAt: new Date("2026-09-10T12:00:00Z") },
    ]);
    expect(events).toHaveLength(1);
  });

  it("applies the default cap TTL when a capping usage reading carries no resetsAt", () => {
    const { tracker, advance } = trackerAt("2026-09-10T10:00:00Z");
    const events: Array<{ kind: string; resetsAt?: Date }> = [];
    tracker.onChange((event) => events.push(event));

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 100, resetsAt: null }]);

    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("capped");
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.resetsAt).toBeUndefined();
    expect(events[0]?.resetsAt?.toISOString()).toBe("2026-09-10T15:00:00.000Z");

    advance(5 * 60 * 60 * 1000 - 1);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);
    advance(2);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("probation");
  });

  it("recovers a usage-capped window to healthy on a later low reading, emitting one recovered event", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z");
    const events: Array<{ kind: string }> = [];
    tracker.onChange((event) => events.push(event));

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 100, resetsAt: null }]);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(false);

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 10, resetsAt: null }]);

    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
    expect(tracker.isLastResortEligible(PROVIDER)).toBe(true);
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("healthy");
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.resetsAt).toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(["capped", "recovered"]);
  });

  it("honors a custom capThresholdPct: at/above caps, between drain and cap only drains", () => {
    const { tracker } = trackerAt("2026-09-10T10:00:00Z", { capThresholdPct: 98 });

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 95, resetsAt: null }]);
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("drained");

    tracker.reportUsage(PROVIDER, [{ window: WINDOW_FIVE_HOUR, usedPct: 98, resetsAt: null }]);
    expect(tracker.snapshot()[PROVIDER]?.[WINDOW_FIVE_HOUR]?.status).toBe("capped");
  });

  it("isHealthyForAllWindows disqualifies on any observed non-usable window, including model-scoped caps", () => {
    const { tracker, advance } = trackerAt("2026-09-10T10:00:00Z");

    // Never-seen provider: vacuously healthy.
    expect(tracker.isHealthyForAllWindows(PROVIDER)).toBe(true);

    // A weekly-Opus cap leaves Sonnet usable, but a model-less spawn must not use this account.
    tracker.reportTurnFailure(PROVIDER, "You've hit your limit — weekly Opus cap reached");
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
    expect(tracker.isHealthyForAllWindows(PROVIDER)).toBe(false);

    // Probation counts as usable, matching isHealthyFor.
    advance(5 * 60 * 60 * 1000);
    expect(tracker.snapshot()[PROVIDER]?.[weeklyModelWindow("opus")]?.status).toBe("probation");
    expect(tracker.isHealthyForAllWindows(PROVIDER)).toBe(true);

    // Drained (not capped) also disqualifies, even though it stays last-resort eligible.
    const other = "claude-worker-b";
    tracker.reportUsage(other, [{ window: WINDOW_SEVEN_DAY, usedPct: 95, resetsAt: null }]);
    expect(tracker.isLastResortEligible(other)).toBe(true);
    expect(tracker.isHealthyForAllWindows(other)).toBe(false);
  });
});

describe("windowUtilization (drives the per-model budget gate)", () => {
  it("returns undefined until a usage reading covers the window", () => {
    const tracker = createHealthTracker();
    expect(tracker.windowUtilization(PROVIDER, weeklyModelWindow("fable"))).toBeUndefined();
  });

  it("reports the last observed percent for a weekly per-model window", () => {
    const tracker = createHealthTracker();
    tracker.reportUsage(PROVIDER, [{ window: weeklyModelWindow("fable"), usedPct: 94, resetsAt: null }]);
    expect(tracker.windowUtilization(PROVIDER, weeklyModelWindow("fable"))).toBe(94);
  });

  it("tracks fable as a real model family, so a Fable cap disqualifies a Fable spawn", () => {
    const tracker = createHealthTracker();
    tracker.reportUsage(PROVIDER, [{ window: weeklyModelWindow("fable"), usedPct: 100, resetsAt: null }]);
    expect(tracker.isHealthyFor(PROVIDER, "claude-fable-5-1")).toBe(false);
    expect(tracker.isHealthyFor(PROVIDER, SONNET_MODEL)).toBe(true);
  });
});
