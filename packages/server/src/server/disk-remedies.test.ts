import { describe, expect, test } from "vitest";
import type { TestArtifactSweepResult } from "./agent/test-artifact-janitor.js";
import type { DoneJanitorSweepReport } from "./agent-done-janitor.js";
import { summarizeArtifactJanitorRun, summarizeDoneJanitorRun } from "./disk-remedies.js";

const GIB = 1024 ** 3;

function doneReport(entries: DoneJanitorSweepReport["entries"], dryRun = false) {
  return { dryRun, removedProjectCount: 0, entries } satisfies DoneJanitorSweepReport;
}

describe("summarizeDoneJanitorRun", () => {
  test("off: the remedy cannot act, and says which switch", () => {
    expect(summarizeDoneJanitorRun({ enabled: false, dryRun: false, report: null })).toEqual({
      state: "disabled",
      detail: "the done janitor is off (agents.doneJanitor.enabled)",
    });
  });

  test("live and acted: counts archives and deleted worktrees with the bytes freed", () => {
    const report = doneReport([
      { action: "archived", reason: "dead", agentId: "a" },
      { action: "archived", reason: "dead", agentId: "b" },
      { action: "deleted", reason: "clean", path: "/w/one", bytes: 3 * GIB },
      { action: "deleted", reason: "clean", path: "/w/two", bytes: 2 * GIB },
      { action: "kept-workspace", reason: "uncommitted files", path: "/w/three" },
    ]);

    expect(summarizeDoneJanitorRun({ enabled: true, dryRun: false, report })).toEqual({
      state: "live",
      outcome: "acted",
      detail: "archived 2 agents and deleted 2 worktrees, freeing 5.0 GB; kept 1 worktree",
    });
  });

  test("live with nothing to reclaim", () => {
    const report = doneReport([
      { action: "kept-agent", reason: "quiet for 14h of the 3d required" },
    ]);

    expect(summarizeDoneJanitorRun({ enabled: true, dryRun: false, report })).toEqual({
      state: "live",
      outcome: "nothing-to-do",
      detail: "swept; no agent was dead or finished long enough and no worktree was reclaimable",
    });
  });

  test("a sweep already running is a skip, not a failure", () => {
    expect(summarizeDoneJanitorRun({ enabled: true, dryRun: false, report: null })).toEqual({
      state: "live",
      outcome: "skipped",
      detail: "a done janitor sweep was already running",
    });
  });

  test("dry run cannot act and reports what it would have done", () => {
    const report = doneReport(
      [
        { action: "would-archive", reason: "dead", agentId: "a" },
        { action: "would-delete", reason: "clean", path: "/w/one", bytes: 4 * GIB },
      ],
      true,
    );

    expect(summarizeDoneJanitorRun({ enabled: true, dryRun: true, report })).toEqual({
      state: "dry-run",
      detail: "dry run: would archive 1 agent and delete 1 worktree, freeing 4.0 GB",
    });
  });
});

describe("summarizeArtifactJanitorRun", () => {
  const reclaimed = (sizeBytes: number): TestArtifactSweepResult["reclaimed"][number] => ({
    setId: "xctest-devices",
    label: "XCTest device clone",
    name: "1C56B10C",
    path: "/x/1C56B10C",
    sizeBytes,
    ageMs: 1,
    claim: "unowned",
  });

  test("off: the recorded attempt names the switch", () => {
    expect(summarizeArtifactJanitorRun({ enabled: false, dryRun: false, result: null })).toEqual({
      state: "disabled",
      detail: "the artifact janitor is off (agents.artifactJanitor.enabled)",
    });
  });

  test("acted: counts clones and bytes", () => {
    const result = { dryRun: false, reclaimed: [reclaimed(4 * GIB), reclaimed(4 * GIB)] };

    expect(summarizeArtifactJanitorRun({ enabled: true, dryRun: false, result })).toEqual({
      state: "live",
      outcome: "acted",
      detail: "reclaimed 2 leftover test artifacts, freeing 8.0 GB",
    });
  });

  test("nothing met the abandonment rules", () => {
    const result = { dryRun: false, reclaimed: [] };

    expect(summarizeArtifactJanitorRun({ enabled: true, dryRun: false, result })).toEqual({
      state: "live",
      outcome: "nothing-to-do",
      detail: "no leftover test artifact met the abandonment rules yet",
    });
  });

  test("dry run", () => {
    const result = { dryRun: true, reclaimed: [reclaimed(4 * GIB)] };

    expect(summarizeArtifactJanitorRun({ enabled: true, dryRun: true, result })).toEqual({
      state: "dry-run",
      detail: "dry run: would reclaim 1 leftover test artifact, freeing 4.0 GB",
    });
  });
});
