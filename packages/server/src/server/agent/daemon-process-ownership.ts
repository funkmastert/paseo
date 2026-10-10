/**
 * Tells the done janitor's idle-workspace sweep which processes inside a worktree are the
 * daemon's own — a forge poll it spawned directly, never an agent's (R4, docs/done-janitor.md)
 * — from the resource monitor's attributed `ps` sample it already takes once a minute
 * (`reportAttributedSample`), the same sharing `native-build-gate.ts` does for the device cap.
 * No second `ps` scan.
 */

import { isDaemonOwnChildPid, type AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";

export interface DaemonProcessOwnershipTracker {
  observeSample(sample: {
    rows: readonly ProcessSampleRow[];
    agentTrees: readonly AgentProcessTree[];
  }): void;
  /** False until the first sample arrives: nothing is excluded, so every worktree keeps today's behavior. */
  isDaemonOwnProcess(pid: number): boolean;
}

export function createDaemonProcessOwnershipTracker(
  daemonPid: number,
): DaemonProcessOwnershipTracker {
  let latest: { rows: readonly ProcessSampleRow[]; attributedPids: ReadonlySet<number> } | null =
    null;
  return {
    observeSample(sample) {
      latest = {
        rows: sample.rows,
        attributedPids: new Set(sample.agentTrees.flatMap((tree) => tree.pids)),
      };
    },
    isDaemonOwnProcess(pid) {
      if (!latest) return false;
      return isDaemonOwnChildPid({
        pid,
        rows: latest.rows,
        daemonPid,
        attributedPids: latest.attributedPids,
      });
    },
  };
}
