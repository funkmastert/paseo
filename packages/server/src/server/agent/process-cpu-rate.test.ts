import { describe, expect, test } from "vitest";
import { withRecentCpuPercent } from "./process-cpu-rate.js";
import type { ProcessSampleRow } from "./process-sampler.js";

function row(
  overrides: Partial<ProcessSampleRow> & Pick<ProcessSampleRow, "pid">,
): ProcessSampleRow {
  return {
    ppid: 1,
    rssKb: 1000,
    cpuPercent: 3,
    etime: "10:00",
    cpuSeconds: 100,
    command: "some-process",
    ...overrides,
  };
}

describe("withRecentCpuPercent", () => {
  test("keeps ps's lifetime average on a pid's first sighting", () => {
    const first = withRecentCpuPercent([row({ pid: 10, cpuPercent: 3 })], undefined, 60_000);
    expect(first.rows[0]?.cpuPercent).toBe(3);
    expect(first.memory.get(10)).toEqual({
      cpuSeconds: 100,
      sampledAtMs: 60_000,
      etimeSeconds: 600,
    });
  });

  test("reports the rate since the previous sweep once a pid has been seen", () => {
    const first = withRecentCpuPercent([row({ pid: 10 })], undefined, 60_000);
    // 30 CPU-seconds in 60 wall-seconds is half a core, whatever ps's lifetime figure says.
    const second = withRecentCpuPercent(
      [row({ pid: 10, cpuSeconds: 130, cpuPercent: 0.4, etime: "11:00" })],
      first.memory,
      120_000,
    );
    expect(second.rows[0]?.cpuPercent).toBeCloseTo(50);
  });

  test("a reused pid (cumulative CPU or elapsed went down) counts as a first sighting", () => {
    const first = withRecentCpuPercent(
      [row({ pid: 10, cpuSeconds: 500, etime: "1:00:00" })],
      undefined,
      60_000,
    );
    const reused = withRecentCpuPercent(
      [row({ pid: 10, cpuSeconds: 2, cpuPercent: 7, etime: "00:03" })],
      first.memory,
      120_000,
    );
    expect(reused.rows[0]?.cpuPercent).toBe(7);
  });

  test("rows without a parsable cputime are passed through untouched and not remembered", () => {
    const result = withRecentCpuPercent(
      [row({ pid: 10, cpuSeconds: undefined, cpuPercent: 12 })],
      new Map([[10, { cpuSeconds: 1, sampledAtMs: 0, etimeSeconds: 1 }]]),
      60_000,
    );
    expect(result.rows[0]?.cpuPercent).toBe(12);
    expect(result.memory.size).toBe(0);
  });

  test("forgets pids that disappeared so the memory never grows", () => {
    const first = withRecentCpuPercent([row({ pid: 10 }), row({ pid: 11 })], undefined, 60_000);
    const second = withRecentCpuPercent([row({ pid: 11 })], first.memory, 120_000);
    expect([...second.memory.keys()]).toEqual([11]);
  });
});
