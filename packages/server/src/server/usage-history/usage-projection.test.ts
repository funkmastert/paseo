import { describe, expect, it } from "vitest";
import { projectWindow, type WindowSample } from "./usage-projection.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

/** `count` readings every `everyMin`, ending at `endMs`, rising `pctPerHour` from `endPct`. */
function readings(input: {
  count: number;
  everyMin: number;
  endMs?: number;
  endPct: number;
  pctPerHour: number;
  resetsAtMs: number | null;
}): WindowSample[] {
  const endMs = input.endMs ?? NOW;
  const out: WindowSample[] = [];
  for (let index = input.count - 1; index >= 0; index -= 1) {
    const atMs = endMs - index * input.everyMin * MINUTE;
    out.push({
      atMs,
      usedPct: input.endPct - (index * input.everyMin * input.pctPerHour) / 60,
      resetsAtMs: input.resetsAtMs,
    });
  }
  return out;
}

function project(samples: WindowSample[], windowId = "five_hour", nowMs = NOW) {
  return projectWindow({ windowId, samples, nowMs });
}

describe("projectWindow: says so when it does not know", () => {
  it("refuses to fit two points", () => {
    const samples = readings({
      count: 2,
      everyMin: 30,
      endPct: 40,
      pctPerHour: 10,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project(samples)).toMatchObject({ status: "unknown", reason: "insufficient_samples" });
  });

  it("refuses three readings that span under fifteen minutes", () => {
    const samples = readings({
      count: 3,
      everyMin: 5,
      endPct: 40,
      pctPerHour: 10,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project(samples)).toMatchObject({ status: "unknown", reason: "short_span" });
  });

  it("has nothing to say about a window with no readings", () => {
    expect(project([])).toMatchObject({ status: "unknown", reason: "insufficient_samples" });
  });

  it("does not project a window that reports no reset time", () => {
    const samples = readings({
      count: 6,
      everyMin: 5,
      endPct: 40,
      pctPerHour: 10,
      resetsAtMs: null,
    });
    expect(project(samples)).toMatchObject({ status: "unknown", reason: "no_reset_time" });
  });

  it("does not project past a reset that has already happened", () => {
    const samples = readings({
      count: 6,
      everyMin: 5,
      endPct: 40,
      pctPerHour: 10,
      resetsAtMs: NOW - MINUTE,
    });
    expect(project(samples)).toMatchObject({ status: "unknown", reason: "reset_passed" });
  });

  it("treats a newest reading older than the cache can explain as stale", () => {
    const samples = readings({
      count: 6,
      everyMin: 5,
      endMs: NOW - 40 * MINUTE,
      endPct: 40,
      pctPerHour: 10,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project(samples)).toMatchObject({ status: "unknown", reason: "stale" });
  });
});

describe("projectWindow: projects honestly", () => {
  it("projects the cap time when the window fills before its reset", () => {
    // 10 points/hour from 50%: 100% is 5 hours out, the reset is 8 hours out.
    const samples = readings({
      count: 13,
      everyMin: 5,
      endPct: 50,
      pctPerHour: 10,
      resetsAtMs: NOW + 8 * HOUR,
    });
    const projection = project(samples);
    expect(projection.status).toBe("projected");
    if (projection.status !== "projected") return;
    expect(projection.ratePctPerHour).toBeCloseTo(10, 5);
    expect(projection.capsAtMs).toBeCloseTo(NOW + 5 * HOUR, -2);
    expect(projection.minutesToCap).toBeCloseTo(300, 1);
    expect(projection.projectedPctAtReset).toBe(100);
    expect(projection.confidence).toBe("ok");
  });

  it("never extrapolates past the reset: a window that resets first never caps", () => {
    // Same 10 points/hour from 50%, but the window resets in 3 hours. It reaches 80%, not 100%.
    const samples = readings({
      count: 13,
      everyMin: 5,
      endPct: 50,
      pctPerHour: 10,
      resetsAtMs: NOW + 3 * HOUR,
    });
    const projection = project(samples);
    expect(projection.status).toBe("projected");
    if (projection.status !== "projected") return;
    expect(projection.capsAtMs).toBeNull();
    expect(projection.minutesToCap).toBeNull();
    expect(projection.projectedPctAtReset).toBeCloseTo(80, 5);
  });

  it("reports a flat window as not filling, without a cap time", () => {
    const samples = readings({
      count: 13,
      everyMin: 5,
      endPct: 42,
      pctPerHour: 0,
      resetsAtMs: NOW + 3 * HOUR,
    });
    const projection = project(samples);
    expect(projection).toMatchObject({
      status: "projected",
      ratePctPerHour: 0,
      capsAtMs: null,
      projectedPctAtReset: 42,
    });
  });

  it("reads a window at 100% as capped, whatever else it knows", () => {
    const samples = readings({
      count: 6,
      everyMin: 5,
      endPct: 100,
      pctPerHour: 0,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project(samples).status).toBe("capped");
  });

  it("flags a fit built on almost no movement as low confidence rather than refusing it", () => {
    const samples = readings({
      count: 13,
      everyMin: 5,
      endPct: 40,
      pctPerHour: 1,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project(samples)).toMatchObject({ status: "projected", confidence: "low" });
  });

  it("flags a short but sufficient span as low confidence", () => {
    const samples = readings({
      count: 4,
      everyMin: 6,
      endPct: 60,
      pctPerHour: 40,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project(samples)).toMatchObject({ status: "projected", confidence: "low" });
  });

  it("never reads a falling number as capacity coming back", () => {
    const samples = readings({
      count: 6,
      everyMin: 10,
      endPct: 40,
      pctPerHour: -6,
      resetsAtMs: NOW + 3 * HOUR,
    });
    // A drop inside one cycle ends the cycle; what remains is too little to fit.
    expect(project(samples).status).toBe("unknown");
  });
});

describe("projectWindow: only the current cycle is evidence", () => {
  it("ignores everything before the last reset", () => {
    const previous = readings({
      count: 12,
      everyMin: 5,
      endMs: NOW - 70 * MINUTE,
      endPct: 95,
      pctPerHour: 40,
      resetsAtMs: NOW - 60 * MINUTE,
    });
    const current = readings({
      count: 2,
      everyMin: 5,
      endPct: 3,
      pctPerHour: 10,
      resetsAtMs: NOW + 5 * HOUR - 60 * MINUTE,
    });
    // Two readings of the new cycle are not a rate, and the old cycle's 40 points/hour is not
    // borrowed to fill the gap.
    expect(project([...previous, ...current])).toMatchObject({
      status: "unknown",
      reason: "insufficient_samples",
      samples: 2,
    });
  });

  it("splits a cycle at a usedPct drop even when the reset time was not re-stamped", () => {
    const before = readings({
      count: 6,
      everyMin: 5,
      endMs: NOW - 30 * MINUTE,
      endPct: 90,
      pctPerHour: 20,
      resetsAtMs: NOW + 3 * HOUR,
    });
    const after = readings({
      count: 3,
      everyMin: 5,
      endPct: 4,
      pctPerHour: 0,
      resetsAtMs: NOW + 3 * HOUR,
    });
    expect(project([...before, ...after])).toMatchObject({ status: "unknown", samples: 3 });
  });

  it("treats sub-second noise in resets_at as one cycle", () => {
    const base = NOW + 3 * HOUR;
    const samples = readings({
      count: 13,
      everyMin: 5,
      endPct: 50,
      pctPerHour: 10,
      resetsAtMs: base,
    });
    samples.forEach((sample, index) => {
      sample.resetsAtMs = base + (index % 3) * 400;
    });
    expect(project(samples)).toMatchObject({ status: "projected", samples: 13 });
  });
});

describe("projectWindow: weekly windows look further back", () => {
  it("fits a weekly window over six hours where a session window would use one", () => {
    // 6 hours at 2 points/hour; a 60-minute fit would see only 2 points of movement either way,
    // but the six-hour span is what carries enough movement to be `ok`.
    const samples = readings({
      count: 73,
      everyMin: 5,
      endPct: 30,
      pctPerHour: 2,
      resetsAtMs: NOW + 4 * 24 * HOUR,
    });
    const weekly = project(samples, "weekly");
    const session = project(samples, "five_hour");
    expect(weekly).toMatchObject({ status: "projected", confidence: "ok" });
    expect(weekly.spanMinutes).toBeGreaterThan(300);
    expect(session.spanMinutes).toBeLessThanOrEqual(60);
  });
});
