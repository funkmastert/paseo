import os from "node:os";

/**
 * The nice value agent provider processes and the daemon's own background subprocesses run at.
 * On Windows libuv maps 10 to BELOW_NORMAL_PRIORITY_CLASS. Children inherit it on macOS, Linux
 * and Windows (a BELOW_NORMAL parent's children default to BELOW_NORMAL), so a build an agent
 * starts runs low too. See docs/resource-monitor.md.
 */
export const BACKGROUND_NICE = os.constants.priority.PRIORITY_BELOW_NORMAL;

/**
 * The nice the resource monitor's sampling children (`ps`, `sysctl`, `vm_stat`, PowerShell) run
 * at: below normal, but ahead of every agent process. At BACKGROUND_NICE `ps` competed equally
 * with the builds it measures and timed out when the machine saturated, blinding the monitor. On
 * Windows there is no class between NORMAL and BELOW_NORMAL, and libuv maps 0..9 to NORMAL, so
 * there the samplers run at normal priority.
 */
export const SAMPLER_NICE = 5;

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

export interface ProcessPriorityPolicy {
  enabled: boolean;
  /** Nice for agent provider processes, and through inheritance the builds and tests they run. */
  agentNice: number;
  /** Nice for the daemon's own periodic subprocesses (forge polling, `git fetch`). */
  backgroundNice: number;
}

export const DEFAULT_PROCESS_PRIORITY_POLICY: Readonly<ProcessPriorityPolicy> = Object.freeze({
  enabled: true,
  agentNice: BACKGROUND_NICE,
  backgroundNice: BACKGROUND_NICE,
});

// Provider and git code has no daemon-config access, so bootstrap keeps this current from the
// config store (start and every change) and the spawn sites read it at spawn time. Module state
// like this leaks between test cases; tests call resetProcessPriorityPolicy() in afterEach.
let currentPolicy: ProcessPriorityPolicy = { ...DEFAULT_PROCESS_PRIORITY_POLICY };

export function getProcessPriorityPolicy(): ProcessPriorityPolicy {
  return { ...currentPolicy };
}

/** Replaces the policy; fields the config leaves unset fall back to the defaults. */
export function setProcessPriorityPolicy(config: Partial<ProcessPriorityPolicy> | undefined): void {
  currentPolicy = {
    enabled: config?.enabled ?? DEFAULT_PROCESS_PRIORITY_POLICY.enabled,
    agentNice: config?.agentNice ?? DEFAULT_PROCESS_PRIORITY_POLICY.agentNice,
    backgroundNice: config?.backgroundNice ?? DEFAULT_PROCESS_PRIORITY_POLICY.backgroundNice,
  };
}

export function resetProcessPriorityPolicy(): void {
  currentPolicy = { ...DEFAULT_PROCESS_PRIORITY_POLICY };
}

/** The nice terminals an agent creates should start at, or undefined to leave them normal. */
export function resolveAgentNice(): number | undefined {
  return currentPolicy.enabled && currentPolicy.agentNice > 0 ? currentPolicy.agentNice : undefined;
}

/** Lowers a just-spawned agent provider process (or terminal an agent owns) per the policy. */
export function lowerAgentProcessPriority(
  pid: number | undefined,
  ops: PriorityOps = os,
): LowerPriorityResult {
  if (!currentPolicy.enabled) return "unchanged";
  return lowerProcessPriority(pid, currentPolicy.agentNice, ops);
}

/** Lowers a just-spawned background subprocess of the daemon per the policy. */
export function lowerBackgroundProcessPriority(
  pid: number | undefined,
  ops: PriorityOps = os,
): LowerPriorityResult {
  if (!currentPolicy.enabled) return "unchanged";
  return lowerProcessPriority(pid, currentPolicy.backgroundNice, ops);
}
