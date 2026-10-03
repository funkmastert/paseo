import os from "node:os";

/**
 * One reading of how loaded the machine is. macOS and Linux have a load average: runnable
 * processes plus (on both) those waiting on disk, so it can exceed the core count and "2x cores"
 * means something. Windows reports zeros from `os.loadavg()`, so there the reading is the share
 * of CPU time spent busy since the previous sample, which saturates at 1 and can never say
 * "2x cores". `load1` is the busy share times the core count, kept so both kinds print alike.
 */
export type SystemLoadReading =
  | { kind: "loadavg"; cores: number; load1: number; load5: number; load15: number }
  | { kind: "cpu-busy"; cores: number; busyFraction: number; load1: number };

export interface SystemLoadSample {
  /** Undefined when there is nothing to report yet (Windows' first sample) or no CPUs visible. */
  load: SystemLoadReading | undefined;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
}

export interface SystemLoadSampler {
  sample(): SystemLoadSample;
}

export type LoadOps = Pick<typeof os, "loadavg" | "cpus" | "freemem" | "totalmem">;

interface CpuTimeTotals {
  busy: number;
  total: number;
}

function sumCpuTimes(cpus: readonly os.CpuInfo[]): CpuTimeTotals {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus) {
    const all = times.user + times.nice + times.sys + times.irq + times.idle;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

/**
 * Reads load from `os` alone. Nothing here spawns a process, so it keeps working on a machine too
 * loaded for `ps` to finish, which is when it is needed.
 */
export function createSystemLoadSampler(
  options: { platform?: NodeJS.Platform; ops?: LoadOps } = {},
): SystemLoadSampler {
  const platform = options.platform ?? process.platform;
  const ops = options.ops ?? os;
  let previous: CpuTimeTotals | undefined;

  function readLoad(): SystemLoadReading | undefined {
    const cpus = ops.cpus();
    const cores = cpus.length;
    if (cores === 0) return undefined;
    if (platform !== "win32") {
      const [load1, load5, load15] = ops.loadavg();
      return { kind: "loadavg", cores, load1, load5, load15 };
    }
    const current = sumCpuTimes(cpus);
    const before = previous;
    previous = current;
    const total = before ? current.total - before.total : 0;
    if (!before || total <= 0) return undefined;
    const busyFraction = Math.min(1, Math.max(0, (current.busy - before.busy) / total));
    return { kind: "cpu-busy", cores, busyFraction, load1: busyFraction * cores };
  }

  return {
    sample() {
      return {
        load: readLoad(),
        freeMemoryBytes: ops.freemem(),
        totalMemoryBytes: ops.totalmem(),
      };
    },
  };
}
