import type { TestArtifactSweepResult } from "./agent/test-artifact-janitor.js";
import type { DoneJanitorSweepReport } from "./agent-done-janitor.js";
import { formatBytes } from "./session/doctor/helpers.js";

/**
 * What one on-demand remedy did, in the shape worktree-disk-monitor.ts turns into a
 * `RemedyAttempt` and a `RemedyState`. `state` says whether the remedy can act at all: a remedy
 * that is off or in dry run is not live even when it ran, and the ladder tells a person rather
 * than starting an agent when nothing is live.
 */
export type DiskRemedyReport =
  | { state: "disabled"; detail: string }
  | { state: "dry-run"; detail: string }
  | {
      state: "live";
      outcome: "acted" | "nothing-to-do" | "failed" | "skipped";
      detail: string;
    };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * `tick()` returns null both when the janitor is off and when a sweep is already running, so the
 * caller says which from the config it read.
 */
export function summarizeDoneJanitorRun(input: {
  enabled: boolean;
  dryRun: boolean;
  report: DoneJanitorSweepReport | null;
}): DiskRemedyReport {
  if (!input.enabled) {
    return { state: "disabled", detail: "the done janitor is off (agents.doneJanitor.enabled)" };
  }
  if (input.report === null) {
    return {
      state: "live",
      outcome: "skipped",
      detail: "a done janitor sweep was already running",
    };
  }
  const count = (action: DoneJanitorSweepReport["entries"][number]["action"]) =>
    input.report?.entries.filter((entry) => entry.action === action) ?? [];
  if (input.dryRun) {
    const archives = count("would-archive");
    const deletes = count("would-delete");
    const bytes = deletes.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    return {
      state: "dry-run",
      detail: `dry run: would archive ${plural(archives.length, "agent")} and delete ${plural(deletes.length, "worktree")}, freeing ${formatBytes(bytes)}`,
    };
  }
  const archived = count("archived");
  const deleted = count("deleted");
  if (archived.length === 0 && deleted.length === 0) {
    return {
      state: "live",
      outcome: "nothing-to-do",
      detail: "swept; no agent was dead or finished long enough and no worktree was reclaimable",
    };
  }
  const bytes = deleted.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  const kept = count("kept-workspace").length;
  const keptNote = kept > 0 ? `; kept ${plural(kept, "worktree")}` : "";
  return {
    state: "live",
    outcome: "acted",
    detail: `archived ${plural(archived.length, "agent")} and deleted ${plural(deleted.length, "worktree")}, freeing ${formatBytes(bytes)}${keptNote}`,
  };
}

/** The caller does not sample processes or sweep when the janitor is off: `result` is null then. */
export function summarizeArtifactJanitorRun(input: {
  enabled: boolean;
  dryRun: boolean;
  result: TestArtifactSweepResult | null;
}): DiskRemedyReport {
  if (!input.enabled || input.result === null) {
    return {
      state: "disabled",
      detail: "the artifact janitor is off (agents.artifactJanitor.enabled)",
    };
  }
  const bytes = input.result.reclaimed.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const count = input.result.reclaimed.length;
  if (input.dryRun) {
    return {
      state: "dry-run",
      detail: `dry run: would reclaim ${plural(count, "leftover test artifact")}, freeing ${formatBytes(bytes)}`,
    };
  }
  if (count === 0) {
    return {
      state: "live",
      outcome: "nothing-to-do",
      detail: "no leftover test artifact met the abandonment rules yet",
    };
  }
  return {
    state: "live",
    outcome: "acted",
    detail: `reclaimed ${plural(count, "leftover test artifact")}, freeing ${formatBytes(bytes)}`,
  };
}
