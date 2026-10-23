import { afterEach, describe, expect, test } from "vitest";
import { clearForgeCliChildPid, markForgeCliChildPidLive } from "./daemon-forge-cli-pids.js";
import { createDaemonProcessOwnershipTracker } from "./daemon-process-ownership.js";
import type { ProcessSampleRow } from "./process-sampler.js";

function row(
  overrides: Partial<ProcessSampleRow> & Pick<ProcessSampleRow, "pid">,
): ProcessSampleRow {
  return {
    ppid: 1,
    uid: 501,
    rssKb: 1000,
    cpuPercent: 0,
    etime: "00:01",
    command: "some-process",
    ...overrides,
  };
}

const daemonPid = 100;

describe("createDaemonProcessOwnershipTracker", () => {
  test("before any sample arrives, every pid is unknown rather than a confident false", () => {
    const tracker = createDaemonProcessOwnershipTracker(daemonPid);
    expect(tracker.isDaemonOwnProcess(300)).toBe("unknown");
  });

  test("classifies a direct child of the daemon as daemon-owned from a fresh sample", () => {
    let clock = 0;
    const tracker = createDaemonProcessOwnershipTracker(daemonPid, () => clock);
    tracker.observeSample({
      rows: [
        row({ pid: daemonPid, ppid: 1 }),
        row({ pid: 300, ppid: daemonPid, command: "tea pr list" }),
      ],
      agentTrees: [],
    });
    expect(tracker.isDaemonOwnProcess(300)).toBe(true);
  });

  test("a sample older than the staleness bound reads as unknown, not a confident false", () => {
    let clock = 0;
    const tracker = createDaemonProcessOwnershipTracker(daemonPid, () => clock);
    tracker.observeSample({
      rows: [
        row({ pid: daemonPid, ppid: 1 }),
        row({ pid: 300, ppid: daemonPid, command: "tea pr list" }),
      ],
      agentTrees: [],
    });
    clock += 3 * 60_000 + 1;
    expect(tracker.isDaemonOwnProcess(300)).toBe("unknown");
  });

  test("a sample within the staleness bound still answers confidently", () => {
    let clock = 0;
    const tracker = createDaemonProcessOwnershipTracker(daemonPid, () => clock);
    tracker.observeSample({
      rows: [row({ pid: daemonPid, ppid: 1 }), row({ pid: 999, ppid: 1, command: "/usr/bin/vim" })],
      agentTrees: [],
    });
    clock += 3 * 60_000 - 1;
    expect(tracker.isDaemonOwnProcess(999)).toBe(false);
  });
});

describe("createDaemonProcessOwnershipTracker, the live forge-CLI pid registry", () => {
  afterEach(() => {
    clearForgeCliChildPid(300);
  });

  test("a pid the registry says is a live forge poll reads as daemon-owned before any sample arrives", () => {
    const tracker = createDaemonProcessOwnershipTracker(daemonPid);
    markForgeCliChildPidLive(300);
    expect(tracker.isDaemonOwnProcess(300)).toBe(true);
  });

  test("overrides a confident false from a sample that never captured the short-lived child", () => {
    const tracker = createDaemonProcessOwnershipTracker(daemonPid, () => 0);
    // The only sample taken this sweep never saw pid 300 at all -- it started and exited
    // between two `ps` samples -- so isDaemonOwnChildPid would read it as a confident "not the
    // daemon's own" rather than "unknown". The live registry is the fix: it is checked first.
    tracker.observeSample({ rows: [row({ pid: daemonPid, ppid: 1 })], agentTrees: [] });
    markForgeCliChildPidLive(300);
    expect(tracker.isDaemonOwnProcess(300)).toBe(true);
  });

  test("falls back to the sample once the registry no longer holds the pid (the poll exited)", () => {
    const tracker = createDaemonProcessOwnershipTracker(daemonPid, () => 0);
    tracker.observeSample({ rows: [row({ pid: daemonPid, ppid: 1 })], agentTrees: [] });
    markForgeCliChildPidLive(300);
    clearForgeCliChildPid(300);
    expect(tracker.isDaemonOwnProcess(300)).toBe(false);
  });
});
