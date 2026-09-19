import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * One row of `ps -axo pid,ppid,uid,rss,pcpu,etime,cputime,command` output. `command` is the full
 * command line (used by process-attribution.ts to find the `callerAgentId=<id>` marker and to
 * recognize known build daemons), so it's read greedily as everything past the fixed columns —
 * it's the one field that legitimately contains spaces.
 *
 * `cpuPercent` as `ps` reports it is a decayed average over the process's lifetime, not a
 * current reading; process-cpu-rate.ts replaces it with the rate since the previous sweep using
 * `cpuSeconds` (cumulative CPU time), which is why both are carried.
 */
export interface ProcessSampleRow {
  pid: number;
  ppid: number;
  /** Owning user id. Carried so build-daemon-reaper.ts can refuse to signal another user's
   * process; nothing in the reporting-only legs reads it. */
  uid: number;
  rssKb: number;
  cpuPercent: number;
  etime: string;
  /** Cumulative CPU seconds (`cputime`); undefined when the column didn't parse. */
  cpuSeconds?: number;
  command: string;
}

const PS_ROW_FIELD_COUNT = 8;

/**
 * Parses `ps` clock columns — `etime` and `cputime` — into seconds. Shapes seen on macOS and
 * Linux: `mm:ss`, `mm:ss.cc`, `hh:mm:ss`, `dd-hh:mm:ss`.
 */
export function parseClockSeconds(text: string): number | undefined {
  const match = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number.parseInt(days ?? "0", 10) * 86_400 +
    Number.parseInt(hours ?? "0", 10) * 3_600 +
    Number.parseInt(minutes, 10) * 60 +
    Number.parseFloat(seconds)
  );
}

function parsePsLine(line: string): ProcessSampleRow | undefined {
  const parts = line.split(/\s+/);
  if (parts.length < PS_ROW_FIELD_COUNT) {
    return undefined;
  }
  const [pidText, ppidText, uidText, rssText, cpuText, etime, cputime, ...commandParts] = parts;
  const pid = Number.parseInt(pidText, 10);
  const ppid = Number.parseInt(ppidText, 10);
  const uid = Number.parseInt(uidText, 10);
  const rssKb = Number.parseInt(rssText, 10);
  const cpuPercent = Number.parseFloat(cpuText);
  if (![pid, ppid, uid, rssKb, cpuPercent].every(Number.isFinite)) {
    return undefined;
  }
  const cpuSeconds = parseClockSeconds(cputime);
  return {
    pid,
    ppid,
    uid,
    rssKb,
    cpuPercent,
    etime,
    ...(cpuSeconds !== undefined ? { cpuSeconds } : {}),
    command: commandParts.join(" "),
  };
}

/**
 * Parses `ps -axo pid,ppid,uid,rss,pcpu,etime,cputime,command` output. The first line is `ps`'s
 * own header (`PID PPID UID RSS %CPU ELAPSED TIME COMMAND` on both macOS and Linux for this
 * column spec) and is always skipped; any other line that doesn't parse to the numeric leading fields
 * is dropped rather than throwing — a `ps` snapshot racing process exit routinely has partial
 * or empty lines.
 */
export function parsePsOutput(output: string): ProcessSampleRow[] {
  const rows: ProcessSampleRow[] = [];
  for (const line of output.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = parsePsLine(trimmed);
    if (row) rows.push(row);
  }
  return rows;
}

export interface SystemMemorySample {
  totalPhysicalBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  /**
   * Memory a new process could have right now, for the device-lease headroom gate
   * (device-slot-defaults.ts). Deliberately excludes the file cache: macOS keeps most of RAM
   * mapped to files, so counting it would report tens of gigabytes "available" on the machine
   * that was swapping 20 GiB. Optional — a host whose memory tool is missing reports nothing,
   * and the gate treats no signal as no objection.
   */
  availableBytes?: number;
}

const SWAP_UNIT_MULTIPLIER: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function parseSwapAmount(amount: string): number | undefined {
  const match = amount.match(/^([\d.]+)([KMG])$/i);
  if (!match) return undefined;
  const multiplier = SWAP_UNIT_MULTIPLIER[match[2].toUpperCase()];
  return multiplier === undefined ? undefined : Number.parseFloat(match[1]) * multiplier;
}

/**
 * Parses macOS `sysctl vm.swapusage` output, e.g.
 * `vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)`.
 */
export function parseMacosSwapUsage(
  output: string,
): Pick<SystemMemorySample, "swapTotalBytes" | "swapUsedBytes"> | undefined {
  const totalMatch = output.match(/total\s*=\s*([\d.]+[KMG])/i);
  const usedMatch = output.match(/used\s*=\s*([\d.]+[KMG])/i);
  if (!totalMatch || !usedMatch) return undefined;
  const swapTotalBytes = parseSwapAmount(totalMatch[1]);
  const swapUsedBytes = parseSwapAmount(usedMatch[1]);
  if (swapTotalBytes === undefined || swapUsedBytes === undefined) return undefined;
  return { swapTotalBytes, swapUsedBytes };
}

const VM_STAT_PAGE_SIZE = /page size of (\d+) bytes/;

/**
 * Parses macOS `vm_stat`. Available means free + speculative + purgeable: pages that are
 * genuinely spare or can be dropped without writing anything back. Inactive pages are left out
 * on purpose — on this machine "inactive" was 21 GiB while the compressor held 22 GiB and swap
 * was full, and calling that available is how you talk yourself into booting one more device.
 */
export function parseMacosVmStat(output: string): number | undefined {
  const pageSize = Number.parseInt(VM_STAT_PAGE_SIZE.exec(output)?.[1] ?? "", 10);
  if (!Number.isFinite(pageSize)) return undefined;
  const readPages = (label: string): number => {
    const match = new RegExp(`^${label}:\\s*(\\d+)\\.`, "m").exec(output);
    return match ? Number.parseInt(match[1], 10) : 0;
  };
  const free = readPages("Pages free");
  if (free === 0 && !/^Pages free:/m.test(output)) return undefined;
  return (free + readPages("Pages speculative") + readPages("Pages purgeable")) * pageSize;
}

function extractMeminfoKb(content: string, key: string): number | undefined {
  const match = content.match(new RegExp(`^${key}:\\s*(\\d+)\\s*kB`, "m"));
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** Parses Linux `/proc/meminfo` content into the same shape `parseMacosSwapUsage` produces. */
export function parseProcMeminfo(content: string): SystemMemorySample | undefined {
  const totalKb = extractMeminfoKb(content, "MemTotal");
  const swapTotalKb = extractMeminfoKb(content, "SwapTotal");
  const swapFreeKb = extractMeminfoKb(content, "SwapFree");
  if (totalKb === undefined || swapTotalKb === undefined || swapFreeKb === undefined) {
    return undefined;
  }
  const availableKb = extractMeminfoKb(content, "MemAvailable");
  return {
    totalPhysicalBytes: totalKb * 1024,
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: (swapTotalKb - swapFreeKb) * 1024,
    ...(availableKb !== undefined ? { availableBytes: availableKb * 1024 } : {}),
  };
}

/**
 * Injectable seam for AgentResourceMonitor's sweep — the real implementation shells out to
 * `ps`/`sysctl` or reads `/proc/meminfo`; tests supply a fake that returns fixture rows without
 * spawning anything. Both methods are best-effort telemetry, never a critical path: they resolve
 * to "no signal" (`[]` / undefined) on any failure — `ps` or `sysctl` missing (minimal
 * containers), a hung child (bounded by a timeout), unrecognized output — rather than throwing.
 */
export interface ProcessSampler {
  sampleProcesses(): Promise<ProcessSampleRow[]>;
  sampleSystemMemory(): Promise<SystemMemorySample | undefined>;
}

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-axo", "pid,ppid,uid,rss,pcpu,etime,cputime,command"];
const PS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
// The monitor exists for overloaded machines, where `ps` itself can stall; a stalled sample must
// not outlive the sweep interval or pile up child processes on top of the load being measured.
const SAMPLE_TIMEOUT_MS = 15_000;

async function sampleMacosMemory(): Promise<SystemMemorySample | undefined> {
  try {
    const [memsize, swapUsage, vmStat] = await Promise.all([
      execFileAsync("sysctl", ["-n", "hw.memsize"], { timeout: SAMPLE_TIMEOUT_MS }),
      execFileAsync("sysctl", ["vm.swapusage"], { timeout: SAMPLE_TIMEOUT_MS }),
      execFileAsync("vm_stat", [], { timeout: SAMPLE_TIMEOUT_MS }).catch(() => undefined),
    ]);
    const totalPhysicalBytes = Number.parseInt(memsize.stdout.trim(), 10);
    const swap = parseMacosSwapUsage(swapUsage.stdout);
    if (!Number.isFinite(totalPhysicalBytes) || !swap) return undefined;
    const availableBytes = vmStat ? parseMacosVmStat(vmStat.stdout) : undefined;
    return {
      totalPhysicalBytes,
      ...swap,
      ...(availableBytes !== undefined ? { availableBytes } : {}),
    };
  } catch {
    // sysctl is unavailable or its output shape changed — no system memory signal this sweep.
    return undefined;
  }
}

async function sampleLinuxMemory(): Promise<SystemMemorySample | undefined> {
  try {
    const content = await readFile("/proc/meminfo", "utf8");
    return parseProcMeminfo(content);
  } catch {
    // /proc/meminfo is unreadable (container, permissions) — no system memory signal this sweep.
    return undefined;
  }
}

export interface SystemProcessSamplerOptions {
  logger?: { warn: (obj: object, msg?: string) => void };
  /** Runs `ps` and resolves its stdout; injectable so tests can fail it without spawning. */
  runPs?: () => Promise<string>;
}

async function runSystemPs(): Promise<string> {
  const { stdout } = await execFileAsync("ps", PS_ARGS, {
    maxBuffer: PS_MAX_BUFFER_BYTES,
    timeout: SAMPLE_TIMEOUT_MS,
  });
  return stdout;
}

export function createSystemProcessSampler(
  options: SystemProcessSamplerOptions = {},
): ProcessSampler {
  const runPs = options.runPs ?? runSystemPs;
  // A host without `ps` fails the same way every sweep; say so once, not every 60 seconds.
  let warnedAboutPs = false;
  return {
    async sampleProcesses() {
      try {
        return parsePsOutput(await runPs());
      } catch (error) {
        if (!warnedAboutPs) {
          warnedAboutPs = true;
          options.logger?.warn(
            { err: error },
            "Resource monitor cannot sample processes; process legs are off until ps works",
          );
        }
        return [];
      }
    },
    async sampleSystemMemory() {
      if (process.platform === "darwin") return sampleMacosMemory();
      if (process.platform === "linux") return sampleLinuxMemory();
      return undefined;
    },
  };
}
