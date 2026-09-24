/**
 * Pure detection for AgentStallSweep: whether an agent sitting in `running` has stopped doing
 * anything. No I/O and no clock reads; the sweep passes the signals and `nowMs` in. See
 * docs/stalled-agents.md for why each signal is there.
 */
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";

/**
 * Idle process-tree samples the sweep must have seen before it trusts the tree to be idle. Two
 * sweeps apart is long enough that a tool call pausing between steps does not read as a stall.
 */
export const MIN_IDLE_CPU_SAMPLES = 2;

export interface StallAgentView {
  lifecycle: AgentLifecycleStatus;
  internal: boolean;
  pendingPermissionCount: number;
  /** The done janitor's question is running; that turn is the janitor's. */
  quietTurn: boolean;
  /** The newest activity timestamp the agent manager holds: timeline rows, turn start, state. */
  lastActivityAtMs: number | null;
  /** The newest activity of each provider subagent still reported running. */
  runningSubagentActivityAtMs: readonly number[];
}

/** What the sweep has observed itself, across sweeps. */
export interface StallSignals {
  /** When the sweep first saw this agent running; stands in for a missing activity timestamp. */
  firstSeenRunningAtMs: number;
  /** The sweep that saw token usage differ from the sweep before. */
  usageChangedAtMs: number | null;
  /** The last sweep whose process-tree CPU was over the idle line. */
  cpuBusyAtMs: number | null;
  /** Idle process-tree samples since the last busy one. */
  idleCpuSamples: number;
}

export function newestActivityAtMs(view: StallAgentView, signals: StallSignals): number {
  return Math.max(
    view.lastActivityAtMs ?? signals.firstSeenRunningAtMs,
    ...view.runningSubagentActivityAtMs,
    signals.usageChangedAtMs ?? Number.NEGATIVE_INFINITY,
    signals.cpuBusyAtMs ?? Number.NEGATIVE_INFINITY,
  );
}

/** Null when the agent is stalled; otherwise why it is not. */
export function notStalledReason(input: {
  view: StallAgentView;
  signals: StallSignals;
  nowMs: number;
  thresholdMs: number;
}): string | null {
  const { view, signals, nowMs, thresholdMs } = input;
  if (view.lifecycle !== "running") return `not running (${view.lifecycle})`;
  if (view.internal) return "internal agent";
  if (view.pendingPermissionCount > 0) return "waiting on a permission";
  if (view.quietTurn) return "answering the done janitor";
  const quietForMs = nowMs - newestActivityAtMs(view, signals);
  if (quietForMs < thresholdMs) return `active ${Math.floor(quietForMs / 60_000)}m ago`;
  if (signals.idleCpuSamples < MIN_IDLE_CPU_SAMPLES) {
    return `only ${signals.idleCpuSamples} idle CPU sample(s) so far`;
  }
  return null;
}

/** Whether the agent did anything after `sinceMs`: how a nudged agent shows it has resumed. */
export function hasShownActivitySince(
  view: StallAgentView,
  signals: StallSignals,
  sinceMs: number,
): boolean {
  return newestActivityAtMs(view, signals) > sinceMs;
}

export interface CpuSignal {
  cpuBusyAtMs: number | null;
  idleCpuSamples: number;
}

/**
 * Folds one sweep's process-tree CPU into the agent's CPU signal. `rateBased` is false when the
 * tree's root was not in the previous sample: then `cpuPercent` is `ps`'s lifetime average,
 * which says nothing about now.
 */
export function recordCpuSample(
  previous: CpuSignal,
  sample: { cpuPercent: number; rateBased: boolean },
  idleCpuPercent: number,
  nowMs: number,
): CpuSignal {
  if (!sample.rateBased) return previous;
  if (sample.cpuPercent > idleCpuPercent) return { cpuBusyAtMs: nowMs, idleCpuSamples: 0 };
  return { cpuBusyAtMs: previous.cpuBusyAtMs, idleCpuSamples: previous.idleCpuSamples + 1 };
}

export interface UsageSignal {
  fingerprint: string;
  usageChangedAtMs: number | null;
}

/**
 * Token usage never touches the manager's activity timestamps, so the sweep compares readings
 * itself. The first reading is a baseline, not a change.
 */
export function recordUsage(
  previous: UsageSignal | undefined,
  fingerprint: string,
  nowMs: number,
): UsageSignal {
  if (!previous) return { fingerprint, usageChangedAtMs: null };
  if (previous.fingerprint === fingerprint) return previous;
  return { fingerprint, usageChangedAtMs: nowMs };
}
