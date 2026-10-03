import { parseClockSeconds, type ProcessSampleRow } from "./process-sampler.js";

/** What one sweep remembers per pid so the next sweep can turn cumulative CPU time into a rate. */
export interface CpuRateSample {
  cpuSeconds: number;
  sampledAtMs: number;
  etimeSeconds: number | undefined;
}

export type CpuRateMemory = Map<number, CpuRateSample>;

const MIN_WALL_SECONDS = 1;

/**
 * Replaces each row's `cpuPercent` with the rate since the previous sweep: cumulative CPU
 * seconds consumed divided by wall-clock elapsed, times 100 — the number `top` shows, and the
 * only one that means "is using N% CPU right now". `ps`'s own %CPU is a decayed lifetime
 * average, so a process that spiked an hour ago reads high all day and a fresh runaway on a
 * long-lived tree reads low for a long time; a "sustained N sweeps" rule over that value would
 * measure history, not load.
 *
 * A pid seen for the first time keeps the `ps` value (for a young process the lifetime average
 * is the recent rate). A pid whose cumulative CPU went down, or whose elapsed time went down, is
 * a reused pid: also treated as first sighting.
 */
export function withRecentCpuPercent(
  rows: readonly ProcessSampleRow[],
  previous: CpuRateMemory | undefined,
  nowMs: number,
): { rows: ProcessSampleRow[]; memory: CpuRateMemory } {
  const memory: CpuRateMemory = new Map();
  const nextRows = rows.map((row) => {
    if (row.cpuSeconds === undefined) {
      return row;
    }
    const etimeSeconds = parseClockSeconds(row.etime);
    memory.set(row.pid, { cpuSeconds: row.cpuSeconds, sampledAtMs: nowMs, etimeSeconds });
    const before = previous?.get(row.pid);
    if (!before) {
      return row;
    }
    const wallSeconds = (nowMs - before.sampledAtMs) / 1000;
    const samePid =
      row.cpuSeconds >= before.cpuSeconds &&
      (etimeSeconds === undefined ||
        before.etimeSeconds === undefined ||
        etimeSeconds >= before.etimeSeconds);
    if (!samePid || wallSeconds < MIN_WALL_SECONDS) {
      return row;
    }
    const cpuPercent = ((row.cpuSeconds - before.cpuSeconds) / wallSeconds) * 100;
    return { ...row, cpuPercent };
  });
  return { rows: nextRows, memory };
}
