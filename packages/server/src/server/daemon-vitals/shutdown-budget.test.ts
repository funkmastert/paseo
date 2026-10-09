import { describe, expect, test } from "vitest";
import {
  SHUTDOWN_STEP_BOUNDS_MS,
  SIMULATOR_SHUTDOWN_WAIT_MS,
  UNBOUNDED_SHUTDOWN_STEPS_RESERVE_MS,
} from "./shutdown-budget.js";
import { DAEMON_SHUTDOWN_BUDGET_MS } from "./shutdown-receipt.js";

describe("daemon stop() budget", () => {
  test("the bounded steps leave the unbounded ones their reserve before the forced exit", () => {
    const bounded = Object.values(SHUTDOWN_STEP_BOUNDS_MS).reduce((sum, ms) => sum + ms, 0);

    expect(bounded + UNBOUNDED_SHUTDOWN_STEPS_RESERVE_MS).toBeLessThanOrEqual(
      DAEMON_SHUTDOWN_BUDGET_MS,
    );
  });

  test("the simulator teardown is one of the bounded steps", () => {
    // A wedged simctl (the 2026-10-08 CoreSimulatorService failure) must not be able to spend
    // the budget the held-child and storage flushes need.
    expect(Object.values(SHUTDOWN_STEP_BOUNDS_MS)).toContain(SIMULATOR_SHUTDOWN_WAIT_MS);
  });
});
