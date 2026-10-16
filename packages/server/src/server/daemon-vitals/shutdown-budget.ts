/**
 * The bounded waits in the daemon's stop() (bootstrap.ts), in one place so their sum can be held
 * under the worker's forced exit at DAEMON_SHUTDOWN_BUDGET_MS (shutdown-receipt.ts). Past that, `process.exit(1)` cuts
 * whatever is still running and the receipt says `timed-out`. A new bounded step in stop() goes
 * in SHUTDOWN_STEP_BOUNDS_MS, and shutdown-budget.test.ts fails if the budget no longer fits.
 */

/** Held child prompts on their way to disk. */
export const ADMISSION_QUEUE_FLUSH_TIMEOUT_MS = 5_000;

/**
 * How long stop() waits for the simulator teardown once the durability steps are done. The
 * teardown starts before agents close and runs beside them and the flushes, so this is only what
 * is left of it by then. A wedged `simctl` is left for the OS (docs/device-leases.md#shutdown).
 */
export const SIMULATOR_SHUTDOWN_WAIT_MS = 2_000;

/** Every bounded wait stop() runs one after another. */
export const SHUTDOWN_STEP_BOUNDS_MS: Readonly<Record<string, number>> = {
  admissionQueueFlush: ADMISSION_QUEUE_FLUSH_TIMEOUT_MS,
  simulatorShutdownWait: SIMULATOR_SHUTDOWN_WAIT_MS,
};

/**
 * What the bounded steps must leave for the unbounded ones: closing agents, the storage flush,
 * the provider runtime, closing sockets. They are fast on a healthy machine, but nothing caps them.
 */
export const UNBOUNDED_SHUTDOWN_STEPS_RESERVE_MS = 3_000;
