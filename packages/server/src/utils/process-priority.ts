import os from "node:os";

/**
 * The nice value agent provider processes and the daemon's own background subprocesses run at.
 * On Windows libuv maps 10 to BELOW_NORMAL_PRIORITY_CLASS. Children inherit it on macOS, Linux
 * and Windows (a BELOW_NORMAL parent's children default to BELOW_NORMAL), so a build an agent
 * starts runs low too. See docs/resource-monitor.md.
 */
export const BACKGROUND_NICE = os.constants.priority.PRIORITY_BELOW_NORMAL;

const MAX_NICE = os.constants.priority.PRIORITY_LOW;

export type PriorityOps = Pick<typeof os, "getPriority" | "setPriority">;

export type LowerPriorityResult = "lowered" | "unchanged" | "failed";

/**
 * Lowers one process's scheduling priority to `nice` and never raises it: a process already at
 * or below that priority is left alone, since only root may raise one and a lower priority was
 * put there on purpose. Best-effort and never throws — the process may already have exited, or
 * belong to another user.
 */
export function lowerProcessPriority(
  pid: number | undefined,
  nice: number,
  ops: PriorityOps = os,
): LowerPriorityResult {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || nice <= 0) return "unchanged";
  const target = Math.min(nice, MAX_NICE);
  try {
    if (ops.getPriority(pid) >= target) return "unchanged";
    ops.setPriority(pid, target);
    return "lowered";
  } catch {
    return "failed";
  }
}
