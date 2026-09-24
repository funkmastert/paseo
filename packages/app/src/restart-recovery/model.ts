import type {
  RestartRecoveryEntry,
  RestartRecoveryPlan,
} from "@getpaseo/protocol/restart-recovery/rpc-schemas";

export interface RestartRecoveryStripModel {
  /** Entries still waiting on a decision: pending, resuming, or failed and retryable. */
  open: RestartRecoveryEntry[];
  /** How many of the open entries can be resumed at all. */
  resumableCount: number;
}

const OPEN_STATES = new Set(["pending", "resuming", "failed"]);

/**
 * Null hides the strip: no plan yet, recovery off on the host, or nothing left to decide. The
 * daemon decides readiness and state; this only picks what to show.
 */
export function buildRestartRecoveryStripModel(
  plan: RestartRecoveryPlan | null | undefined,
): RestartRecoveryStripModel | null {
  if (!plan || plan.mode === "off") return null;
  const open = plan.entries.filter((entry) => OPEN_STATES.has(entry.state));
  if (open.length === 0) return null;
  return {
    open,
    resumableCount: open.filter((entry) => entry.readiness !== "not_restorable").length,
  };
}
