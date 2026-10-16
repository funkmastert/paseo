import { describe, expect, test } from "vitest";
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
