import { describe, expect, test } from "vitest";
import type { ProviderUsage, ProviderUsageWindow } from "@getpaseo/protocol/messages";
import {
  planBudgetPacingAdvice,
  recordBudgetPacingDelivery,
  resolveBudgetPacingConfig,
  type BudgetPacingAdvisory,
  type BudgetPacingAgentInput,
  type BudgetPacingMemory,
  type BudgetPacingSettings,
  type PlanBudgetPacingAdviceResult,
} from "./budget-pacing-advisor.js";

const NOW_MS = Date.parse("2026-09-19T12:00:00Z");
const MS_PER_MINUTE = 60_000;

function at(minutesFromNow: number): number {
  return NOW_MS + minutesFromNow * MS_PER_MINUTE;
}

function iso(minutesFromNow: number): string {
  return new Date(at(minutesFromNow)).toISOString();
}

interface WindowInput {
  id?: string;
  label?: string;
  usedPct: number;
  /** Minutes from the reference `now`, not from the sweep. */
  resetsInMinutes: number;
}

function usageWindow(input: WindowInput): ProviderUsageWindow {
  return {
    id: input.id ?? "five_hour",
    label: input.label ?? "Session",
    usedPct: input.usedPct,
    resetsAt: iso(input.resetsInMinutes),
  };
}

function account(providerId: string, windows: readonly WindowInput[]): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: "Max",
    windows: windows.map(usageWindow),
  };
}

function leader(overrides: Partial<BudgetPacingAgentInput> = {}): BudgetPacingAgentInput {
  return {
    id: "leader-1",
    provider: "claude",
    internal: false,
    isDelegated: false,
    isRunning: true,
    tokenRate: undefined,
    ...overrides,
  };
}

interface SweepInput {
  atMinutes: number;
  usage: readonly ProviderUsage[];
  /** Defaults to the sweep time: a snapshot read this instant. */
  fetchedAtMinutes?: number;
}

interface Runner {
  sweep: (input: SweepInput) => PlanBudgetPacingAdviceResult;
  memory: () => BudgetPacingMemory | undefined;
}

function createRunner(options: {
  agents?: readonly BudgetPacingAgentInput[];
  workers?: readonly string[];
  settings?: BudgetPacingSettings;
}): Runner {
  const config = resolveBudgetPacingConfig(options.settings ?? {});
  const workerProviderIds = new Set(options.workers ?? ["claude-personal", "claude-backup"]);
  let memory: BudgetPacingMemory | undefined;
  return {
    sweep(input) {
      const result = planBudgetPacingAdvice({
        usage: input.usage,
        usageFetchedAtMs: at(input.fetchedAtMinutes ?? input.atMinutes),
        workerProviderIds,
        agents: options.agents ?? [leader()],
        previous: memory,
        config,
        nowMs: at(input.atMinutes),
      });
      memory = result.memory;
      return result;
    },
    memory: () => memory,
  };
}

/**
 * Tyler's case: a session window half unused with half an hour to go. 52 points left over 34
 * minutes needs 1.53%/min; it has been going at 8 points over 22 minutes, or 0.36%/min.
 */
function underusedAccount(usedPct: number, resetsInMinutes: number): ProviderUsage[] {
  return [
    account("claude-personal", [{ usedPct, resetsInMinutes }]),
    account("claude-backup", [{ usedPct: 9, resetsInMinutes: 200 }]),
  ];
}

function runUnderusedSweeps(runner: Runner, resetsInMinutes = 34): PlanBudgetPacingAdviceResult {
  runner.sweep({ atMinutes: -22, usage: underusedAccount(40, resetsInMinutes) });
  return runner.sweep({ atMinutes: 0, usage: underusedAccount(48, resetsInMinutes) });
}

/** 18 points left with two hours to run, going at 12 points per 30 minutes. */
function overusedAccount(usedPct: number): ProviderUsage[] {
  return [
    account("claude-personal", [{ usedPct, resetsInMinutes: 120 }]),
    account("claude-backup", [{ usedPct: 9, resetsInMinutes: 200 }]),
  ];
}

function runOverusedSweeps(runner: Runner, finalUsedPct = 82): PlanBudgetPacingAdviceResult {
  runner.sweep({ atMinutes: -30, usage: overusedAccount(finalUsedPct - 12) });
  return runner.sweep({ atMinutes: 0, usage: overusedAccount(finalUsedPct) });
}

function only(result: PlanBudgetPacingAdviceResult): BudgetPacingAdvisory {
  expect(result.advisories).toHaveLength(1);
  return result.advisories[0]!;
}

describe("planBudgetPacingAdvice", () => {
  test("one usage reading is two numbers, not a pace", () => {
    const runner = createRunner({});

    const result = runner.sweep({ atMinutes: 0, usage: underusedAccount(48, 34) });

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("no-measurable-window");
  });

  test("a span shorter than the minimum observation is still not a pace", () => {
    const runner = createRunner({});

    runner.sweep({ atMinutes: -10, usage: underusedAccount(40, 34) });
    const result = runner.sweep({ atMinutes: 0, usage: underusedAccount(48, 34) });

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("no-measurable-window");
  });

  test("re-reading one cached snapshot does not shorten the measured span", () => {
    const runner = createRunner({});

    runner.sweep({ atMinutes: -22, usage: underusedAccount(40, 34) });
    runner.sweep({ atMinutes: -1, usage: underusedAccount(48, 34), fetchedAtMinutes: -1 });
    // Same snapshot, read again a minute later. Recording it would move the newest sample's
    // timestamp and leave the span reading 1 minute instead of 21.
    const result = runner.sweep({
      atMinutes: 0,
      usage: underusedAccount(48, 34),
      fetchedAtMinutes: -1,
    });

    expect(only(result).observationMinutes).toBeCloseTo(21, 5);
    expect(only(result).observationSamples).toBe(2);
  });

  test("advises speeding up when a session window is about to expire part-used", () => {
    const runner = createRunner({});

    const advisory = only(runUnderusedSweeps(runner));

    expect(advisory.direction).toBe("speedUp");
    expect(advisory.providerId).toBe("claude-personal");
    expect(advisory.remainingPct).toBe(52);
    expect(advisory.minutesToReset).toBe(34);
    expect(advisory.observedPctPerMin).toBeCloseTo(8 / 22, 5);
    expect(advisory.requiredPctPerMin).toBeCloseTo(52 / 34, 5);
    // 52 left, 0.364%/min for 34 more minutes spends 12.4 of it.
    expect(advisory.gapPct).toBeCloseTo(52 - (8 / 22) * 34, 5);
    expect(advisory.alternatives).toEqual([
      { providerId: "claude-backup", displayName: "claude-backup", remainingPct: 91 },
    ]);
  });

  test("says nothing about a window whose reset is beyond the horizon", () => {
    const runner = createRunner({});

    const result = runUnderusedSweeps(runner, 180);

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("no-window-past-threshold");
  });

  test("says nothing inside the last twenty minutes, when a fresh subagent cannot finish", () => {
    const runner = createRunner({});

    const result = runUnderusedSweeps(runner, 15);

    expect(result.advisories).toEqual([]);
  });

  test("does not advise a wider fan-out while another window on the account is nearly spent", () => {
    const runner = createRunner({});
    const usage = (usedPct: number): ProviderUsage[] => [
      account("claude-personal", [
        { usedPct, resetsInMinutes: 34 },
        { id: "weekly", label: "Weekly", usedPct: 96, resetsInMinutes: 4000 },
      ]),
    ];

    runner.sweep({ atMinutes: -22, usage: usage(40) });
    const result = runner.sweep({ atMinutes: 0, usage: usage(48) });

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("no-window-past-threshold");
  });

  test("advises slowing down when the window caps before it resets", () => {
    const runner = createRunner({});

    const advisory = only(runOverusedSweeps(runner));

    expect(advisory.direction).toBe("slowDown");
    expect(advisory.remainingPct).toBe(18);
    expect(advisory.observedPctPerMin).toBeCloseTo(0.4, 5);
    expect(advisory.requiredPctPerMin).toBeCloseTo(18 / 120, 5);
    expect(advisory.minutesToExhaust).toBeCloseTo(45, 5);
    expect(advisory.earlyByMinutes).toBeCloseTo(75, 5);
    // 0.4%/min for the full 120 minutes would want 48 points; it has 18.
    expect(advisory.gapPct).toBeCloseTo(30, 5);
  });

  test("ignores a burst while most of the window is still there", () => {
    const runner = createRunner({});

    // Same pace, same projection, but only a quarter of the window is gone — the agents that
    // caused this will finish long before it matters.
    const result = runOverusedSweeps(runner, 25);

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("no-window-past-threshold");
  });

  test("slowing down outranks speeding up", () => {
    const runner = createRunner({});
    const usage = (personalUsed: number, backupUsed: number): ProviderUsage[] => [
      account("claude-personal", [{ usedPct: personalUsed, resetsInMinutes: 34 }]),
      account("claude-backup", [{ usedPct: backupUsed, resetsInMinutes: 120 }]),
    ];

    runner.sweep({ atMinutes: -30, usage: usage(40, 70) });
    const result = runner.sweep({ atMinutes: 0, usage: usage(48, 82) });

    expect(result.advisories.map((advisory) => advisory.direction)).toEqual([
      "slowDown",
      "speedUp",
    ]);
  });

  test("a stale usage snapshot is not evidence", () => {
    const runner = createRunner({});

    runner.sweep({ atMinutes: -22, usage: underusedAccount(40, 34) });
    const result = runner.sweep({
      atMinutes: 0,
      usage: underusedAccount(48, 34),
      fetchedAtMinutes: -20,
    });

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("stale-usage");
  });

  test("accounts outside the worker pool are never paced", () => {
    const runner = createRunner({ workers: ["claude-backup"] });

    const result = runUnderusedSweeps(runner);

    expect(result.advisories).toEqual([]);
  });

  test("with no worker accounts there is nothing to pace", () => {
    const runner = createRunner({ workers: [] });

    const result = runUnderusedSweeps(runner);

    expect(result.skipped).toBe("no-worker-accounts");
  });

  test("a usage figure revised downward reads as no burn, not as a refund", () => {
    const runner = createRunner({});

    runner.sweep({ atMinutes: -22, usage: underusedAccount(50, 34) });
    const result = runner.sweep({ atMinutes: 0, usage: underusedAccount(48, 34) });

    expect(only(result).observedPctPerMin).toBe(0);
  });

  test("a window that resets starts its measurement over", () => {
    const runner = createRunner({});

    const usage = (usedPct: number, resetsInMinutes: number): ProviderUsage[] => [
      account("claude-personal", [{ usedPct, resetsInMinutes }]),
    ];

    runner.sweep({ atMinutes: -22, usage: usage(88, 2) });
    // The window rolled over: a new reset, and a percentage that fell. Differencing across that
    // boundary would read as a huge refund on a budget that no longer exists.
    const result = runner.sweep({ atMinutes: 0, usage: usage(3, 60) });

    expect(result.advisories).toEqual([]);
    expect(result.skipped).toBe("no-measurable-window");
  });

  test("leaders are the running root agents, and nothing else", () => {
    const runner = createRunner({
      agents: [
        leader({ id: "running-leader" }),
        leader({ id: "idle-leader", isRunning: false }),
        leader({ id: "subagent", isDelegated: true }),
        leader({ id: "internal", internal: true }),
      ],
    });

    const result = runUnderusedSweeps(runner);

    expect(result.leaderIds).toEqual(["running-leader"]);
  });

  test("names the running agents on the account and what they burn between them", () => {
    const runner = createRunner({
      agents: [
        leader({ id: "running-leader" }),
        leader({
          id: "worker-a",
          provider: "claude-personal",
          isDelegated: true,
          tokenRate: 120_000,
        }),
        leader({
          id: "worker-b",
          provider: "claude-personal",
          isDelegated: true,
          tokenRate: 90_000,
        }),
        leader({
          id: "worker-idle",
          provider: "claude-personal",
          isDelegated: true,
          isRunning: false,
          tokenRate: 400_000,
        }),
      ],
    });

    const advisory = only(runUnderusedSweeps(runner));

    expect(advisory.runningAgentsOnAccount).toBe(2);
    expect(advisory.accountTokenRatePerMinute).toBe(210_000);
  });
});

/**
 * A window 90 minutes from its reset, 70 points left, measured at 0.09 points a minute: 52 of
 * those points are on course to expire. Wide enough that the repeat sweeps below still land
 * inside the horizon.
 */
function pacedAccount(usedPct: number): ProviderUsage[] {
  return [account("claude-personal", [{ usedPct, resetsInMinutes: 90 }])];
}

function runPacedSweeps(runner: Runner): PlanBudgetPacingAdviceResult {
  runner.sweep({ atMinutes: -20, usage: pacedAccount(26) });
  return runner.sweep({ atMinutes: 0, usage: pacedAccount(30) });
}

describe("recordBudgetPacingDelivery", () => {
  test("an advisory is said once, not once a sweep", () => {
    const runner = createRunner({});
    const first = runPacedSweeps(runner);
    recordBudgetPacingDelivery(first.memory, only(first), NOW_MS);

    const second = runner.sweep({ atMinutes: 1, usage: pacedAccount(30) });

    expect(second.advisories).toEqual([]);
  });

  test("it repeats once when the gap has grown", () => {
    const runner = createRunner({ settings: { repeatAfterMinutes: 0 } });
    const first = runPacedSweeps(runner);
    recordBudgetPacingDelivery(first.memory, only(first), NOW_MS);

    // 25 more minutes, nothing more spent: the pace fell and the deadline came closer, so what
    // is on course to expire has grown from 52 points to 64.
    const second = runner.sweep({ atMinutes: 25, usage: pacedAccount(30) });

    expect(only(second).direction).toBe("speedUp");
    expect(only(second).gapPct - only(first).gapPct).toBeGreaterThan(10);
  });

  test("it does not repeat inside the cooldown, however much worse it got", () => {
    const runner = createRunner({ settings: { repeatWorseningPct: 0 } });
    const first = runPacedSweeps(runner);
    recordBudgetPacingDelivery(first.memory, only(first), NOW_MS);

    const second = runner.sweep({ atMinutes: 10, usage: pacedAccount(30) });

    expect(second.advisories).toEqual([]);
  });

  test("it does not repeat when the gap has not materially worsened", () => {
    const runner = createRunner({ settings: { repeatAfterMinutes: 0 } });
    const first = runPacedSweeps(runner);
    recordBudgetPacingDelivery(first.memory, only(first), NOW_MS);

    // The leader took the advice: 10 more points went in the next 25 minutes, and the figure on
    // course to expire fell rather than grew.
    const second = runner.sweep({ atMinutes: 25, usage: pacedAccount(40) });

    expect(second.advisories).toEqual([]);
  });

  test("it is never said a third time in one cycle", () => {
    const runner = createRunner({ settings: { repeatAfterMinutes: 0, repeatWorseningPct: 0 } });
    const first = runPacedSweeps(runner);
    recordBudgetPacingDelivery(first.memory, only(first), NOW_MS);
    const second = runner.sweep({ atMinutes: 25, usage: pacedAccount(30) });
    recordBudgetPacingDelivery(second.memory, only(second), at(25));

    const third = runner.sweep({ atMinutes: 50, usage: pacedAccount(30) });

    expect(third.advisories).toEqual([]);
  });

  test("a reset re-arms the window", () => {
    const runner = createRunner({});
    const first = runPacedSweeps(runner);
    recordBudgetPacingDelivery(first.memory, only(first), NOW_MS);
    const nextCycle = (usedPct: number): ProviderUsage[] => [
      account("claude-personal", [{ usedPct, resetsInMinutes: 180 }]),
    ];

    // The window reset at +90 and the one after it is 60 minutes from its own reset with the same
    // gap. It is a different budget, so it is worth saying again.
    runner.sweep({ atMinutes: 100, usage: nextCycle(26) });
    const afterReset = runner.sweep({ atMinutes: 120, usage: nextCycle(30) });

    expect(only(afterReset).direction).toBe("speedUp");
  });
});
