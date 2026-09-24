import { describe, expect, test } from "vitest";

import {
  MIN_IDLE_CPU_SAMPLES,
  hasShownActivitySince,
  newestActivityAtMs,
  notStalledReason,
  recordCpuSample,
  recordUsage,
  type StallAgentView,
  type StallSignals,
} from "./stall-detector.js";

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const THRESHOLD = 30 * MINUTE;

function view(overrides: Partial<StallAgentView> = {}): StallAgentView {
  return {
    lifecycle: "running",
    internal: false,
    pendingPermissionCount: 0,
    quietTurn: false,
    lastActivityAtMs: NOW - 20 * 60 * MINUTE,
    runningSubagentActivityAtMs: [],
    ...overrides,
  };
}

function signals(overrides: Partial<StallSignals> = {}): StallSignals {
  return {
    firstSeenRunningAtMs: NOW - 60 * MINUTE,
    usageChangedAtMs: null,
    cpuBusyAtMs: null,
    idleCpuSamples: MIN_IDLE_CPU_SAMPLES,
    ...overrides,
  };
}

function evaluate(agent: StallAgentView, observed: StallSignals = signals()): string | null {
  return notStalledReason({ view: agent, signals: observed, nowMs: NOW, thresholdMs: THRESHOLD });
}

describe("notStalledReason", () => {
  test("a running agent with no activity past the threshold and an idle process tree is stalled", () => {
    expect(evaluate(view())).toBeNull();
  });

  test("only a running agent can stall", () => {
    expect(evaluate(view({ lifecycle: "idle" }))).toMatch(/not running/);
    expect(evaluate(view({ lifecycle: "error" }))).toMatch(/not running/);
  });

  test("an internal agent is never stalled", () => {
    expect(evaluate(view({ internal: true }))).toMatch(/internal/);
  });

  test("a pending permission is waiting on a person, not a stall", () => {
    expect(evaluate(view({ pendingPermissionCount: 1 }))).toMatch(/permission/);
  });

  test("the done janitor's quiet turn is the janitor's, not the sweep's", () => {
    expect(evaluate(view({ quietTurn: true }))).toMatch(/done janitor/);
  });

  test("the activity threshold is inclusive: exactly at it stalls, a millisecond short does not", () => {
    expect(evaluate(view({ lastActivityAtMs: NOW - THRESHOLD }))).toBeNull();
    expect(evaluate(view({ lastActivityAtMs: NOW - THRESHOLD + 1 }))).toMatch(/active \d+m ago/);
  });

  test("token usage changing counts as activity", () => {
    expect(evaluate(view(), signals({ usageChangedAtMs: NOW - THRESHOLD + 1 }))).not.toBeNull();
    expect(evaluate(view(), signals({ usageChangedAtMs: NOW - THRESHOLD }))).toBeNull();
  });

  test("CPU over the idle line inside the window is activity: a long build is never stalled", () => {
    expect(evaluate(view(), signals({ cpuBusyAtMs: NOW - 5 * MINUTE }))).not.toBeNull();
    expect(evaluate(view(), signals({ cpuBusyAtMs: NOW - THRESHOLD }))).toBeNull();
  });

  test("needs enough idle CPU samples before it trusts the process tree", () => {
    expect(evaluate(view(), signals({ idleCpuSamples: MIN_IDLE_CPU_SAMPLES - 1 }))).toMatch(/CPU/);
    expect(evaluate(view(), signals({ idleCpuSamples: MIN_IDLE_CPU_SAMPLES }))).toBeNull();
  });

  test("a running provider subagent counts only while it is itself active", () => {
    const activeChild = view({ runningSubagentActivityAtMs: [NOW - 2 * MINUTE] });
    expect(evaluate(activeChild)).not.toBeNull();
    const quietChild = view({ runningSubagentActivityAtMs: [NOW - THRESHOLD] });
    expect(evaluate(quietChild)).toBeNull();
  });

  test("an agent with no activity timestamp is timed from when the sweep first saw it running", () => {
    const unknown = view({ lastActivityAtMs: null });
    expect(
      evaluate(unknown, signals({ firstSeenRunningAtMs: NOW - THRESHOLD + 1 })),
    ).not.toBeNull();
    expect(evaluate(unknown, signals({ firstSeenRunningAtMs: NOW - THRESHOLD }))).toBeNull();
  });
});

describe("newestActivityAtMs", () => {
  test("is the newest of every signal", () => {
    expect(
      newestActivityAtMs(
        view({
          lastActivityAtMs: NOW - 50 * MINUTE,
          runningSubagentActivityAtMs: [NOW - 40 * MINUTE],
        }),
        signals({ usageChangedAtMs: NOW - 45 * MINUTE, cpuBusyAtMs: NOW - 35 * MINUTE }),
      ),
    ).toBe(NOW - 35 * MINUTE);
  });
});

describe("hasShownActivitySince", () => {
  test("after a nudge only activity newer than the settle point counts", () => {
    const since = NOW - 10 * MINUTE;
    expect(hasShownActivitySince(view({ lastActivityAtMs: since }), signals(), since)).toBe(false);
    expect(hasShownActivitySince(view({ lastActivityAtMs: since + 1 }), signals(), since)).toBe(
      true,
    );
    expect(hasShownActivitySince(view(), signals({ usageChangedAtMs: since + 1 }), since)).toBe(
      true,
    );
    expect(hasShownActivitySince(view(), signals({ cpuBusyAtMs: since + 1 }), since)).toBe(true);
  });
});

describe("recordCpuSample", () => {
  const idle = { cpuBusyAtMs: null, idleCpuSamples: 0 };

  test("at or below the idle line is one more idle sample", () => {
    expect(recordCpuSample(idle, { cpuPercent: 5, rateBased: true }, 5, NOW)).toEqual({
      cpuBusyAtMs: null,
      idleCpuSamples: 1,
    });
  });

  test("above the idle line is activity now and restarts the idle count", () => {
    expect(
      recordCpuSample(
        { cpuBusyAtMs: null, idleCpuSamples: 3 },
        { cpuPercent: 5.1, rateBased: true },
        5,
        NOW,
      ),
    ).toEqual({ cpuBusyAtMs: NOW, idleCpuSamples: 0 });
  });

  test("a first sighting is ps's lifetime average, so it proves neither busy nor idle", () => {
    expect(recordCpuSample(idle, { cpuPercent: 80, rateBased: false }, 5, NOW)).toEqual(idle);
    expect(recordCpuSample(idle, { cpuPercent: 0, rateBased: false }, 5, NOW)).toEqual(idle);
  });
});

describe("recordUsage", () => {
  test("the first reading is not a change; a different reading is activity now", () => {
    const first = recordUsage(undefined, "a", NOW - MINUTE);
    expect(first).toEqual({ fingerprint: "a", usageChangedAtMs: null });
    expect(recordUsage(first, "a", NOW)).toEqual(first);
    expect(recordUsage(first, "b", NOW)).toEqual({ fingerprint: "b", usageChangedAtMs: NOW });
  });
});
