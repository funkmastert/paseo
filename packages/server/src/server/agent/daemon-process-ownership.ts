/**
 * Tells the done janitor's idle-workspace sweep which processes inside a worktree are the
 * daemon's own — a forge poll it spawned directly, never an agent's (R4, docs/done-janitor.md)
 * — from the resource monitor's attributed `ps` sample it already takes once a minute
 * (`reportAttributedSample`), the same sharing `native-build-gate.ts` does for the device cap.
 * No second `ps` scan.
 *
 * The resource monitor's sweep that feeds `observeSample` is skipped entirely while
 * `resourceMonitor.enabled` is `false` (agent-resource-monitor.ts's `sweep()` returns before
 * calling `reportAttributedSample`), so this tracker never receives a sample and every pid reads
 * as "unknown" below — the exclusion goes quiet rather than wrong. `bootstrap.ts` logs that
 * config combination once at startup so it isn't a silent gap.
 */

import { isDaemonOwnChildPid, type AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

/**
 * A sample older than this is "can't tell": the resource monitor samples roughly once a minute,
 * so a sample this old means the monitor stalled or its sweep was disabled mid-run. Classifying a
 * pid from a stale sample risks naming a long-gone daemon forge poll "foreign" (the pid vanished
 * from the daemon's tree and was reused), which the janitor would tag `category: "process"` and
 * lock with an up-to-6h cooldown (R5) for a process that was never really there.
 */
const MAX_SAMPLE_AGE_MS = 3 * 60_000;

export type DaemonProcessOwnershipVerdict = boolean | "unknown";

export interface DaemonProcessOwnershipTracker {
  observeSample(sample: {
    rows: readonly ProcessSampleRow[];
    agentTrees: readonly AgentProcessTree[];
  }): void;
  /**
   * `"unknown"` until the first sample arrives, or once the latest sample ages past
   * `MAX_SAMPLE_AGE_MS` — callers must not treat "unknown" the same as a confident `false`
   * (see R5 in docs/done-janitor.md).
   */
  isDaemonOwnProcess(pid: number): DaemonProcessOwnershipVerdict;
}

export function createDaemonProcessOwnershipTracker(
  daemonPid: number,
  now: () => number = Date.now,
): DaemonProcessOwnershipTracker {
  let latest: {
    rows: readonly ProcessSampleRow[];
    attributedPids: ReadonlySet<number>;
    takenAtMs: number;
  } | null = null;
  return {
    observeSample(sample) {
      latest = {
        rows: sample.rows,
        attributedPids: new Set(sample.agentTrees.flatMap((tree) => tree.pids)),
        takenAtMs: now(),
      };
    },
    isDaemonOwnProcess(pid) {
      if (!latest) return "unknown";
      if (now() - latest.takenAtMs > MAX_SAMPLE_AGE_MS) return "unknown";
      return isDaemonOwnChildPid({
        pid,
        rows: latest.rows,
        daemonPid,
        attributedPids: latest.attributedPids,
      });
    },
  };
}
