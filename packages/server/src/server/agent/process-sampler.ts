import { type ExecFileOptions, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { lowerProcessPriority, SAMPLER_NICE } from "../../utils/process-priority.js";
import {
  createSystemLoadSampler,
  type SystemLoadSample,
  type SystemLoadSampler,
} from "./system-load.js";

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
   * process; nothing in the reporting-only legs reads it. Undefined on Windows, which has no
   * uid: the reaper refuses to signal a row without one. */
  uid: number | undefined;
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

function readJsonNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

/** Formats seconds the way `ps` prints `etime` (`[dd-][hh:]mm:ss`), so parseClockSeconds reads it. */
function formatClock(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const seconds = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad(minutes)}:${pad(seconds)}`;
  if (days > 0) return `${days}-${pad(hours)}:${clock}`;
  return hours > 0 ? `${pad(hours)}:${clock}` : clock;
}

// Win32_Process's CPU counters are in 100-nanosecond units.
const WINDOWS_CPU_TICKS_PER_SECOND = 10_000_000;

function parseWindowsProcess(entry: unknown): ProcessSampleRow | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const pid = readJsonNumber(record.ProcessId);
  const ppid = readJsonNumber(record.ParentProcessId);
  if (pid === undefined || ppid === undefined) return undefined;
  const cpuSeconds =
    ((readJsonNumber(record.UserModeTime) ?? 0) + (readJsonNumber(record.KernelModeTime) ?? 0)) /
    WINDOWS_CPU_TICKS_PER_SECOND;
  const ageSeconds = readJsonNumber(record.AgeSeconds) ?? 0;
  const commandLine = typeof record.CommandLine === "string" ? record.CommandLine : "";
  const name = typeof record.Name === "string" ? record.Name : "";
  return {
    pid,
    ppid,
    uid: undefined,
    rssKb: Math.round((readJsonNumber(record.WorkingSetSize) ?? 0) / 1024),
    // ps's %CPU is a lifetime average; this is the same number, and process-cpu-rate.ts replaces
    // it with the rate between sweeps from the second sighting on.
    cpuPercent: ageSeconds > 0 ? (cpuSeconds / ageSeconds) * 100 : 0,
    etime: formatClock(ageSeconds),
    cpuSeconds,
    // Protected processes hide their command line from a non-elevated caller.
    command: commandLine || name,
  };
}

/**
 * Parses the JSON WINDOWS_PROCESS_QUERY prints into the rows `ps` produces elsewhere.
 * ConvertTo-Json emits a bare object for a single process and an array otherwise; UInt64
 * counters may come out as numbers or strings depending on the PowerShell version.
 */
export function parseWindowsProcessJson(output: string): ProcessSampleRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessSampleRow[] = [];
  for (const entry of entries) {
    const row = parseWindowsProcess(entry);
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
 * Injectable seam for the process table and system memory — the real implementation shells out
 * to `ps`/`sysctl` (PowerShell on Windows) or reads `/proc/meminfo`; tests supply a fake that
 * returns fixture rows without spawning anything. Both methods are best-effort telemetry, never a
 * critical path: they resolve to "no signal" (`[]` / undefined) on any failure — the tool missing
 * (minimal containers), a hung child (bounded by a timeout), unrecognized output — rather than
 * throwing. A caller that must tell "no processes" from "could not look" uses
 * ResourceMonitorSampler.sampleProcessTable instead.
 */
export interface ProcessSampler {
  sampleProcesses(): Promise<ProcessSampleRow[]>;
  sampleSystemMemory(): Promise<SystemMemorySample | undefined>;
}

export type ProcessTableSample =
  | { status: "ok"; rows: ProcessSampleRow[] }
  | { status: "failed"; error: unknown };

/** What AgentResourceMonitor needs on top of ProcessSampler. See docs/resource-monitor.md. */
export interface ResourceMonitorSampler extends ProcessSampler {
  /** Like sampleProcesses, but a failed read says so instead of looking like an empty machine. */
  sampleProcessTable(): Promise<ProcessTableSample>;
  /** Load and free memory from `os`, which spawns nothing and so cannot go blind. */
  sampleSystemLoad(): SystemLoadSample;
}

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-axo", "pid,ppid,uid,rss,pcpu,etime,cputime,command"];
const PROCESS_TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
// The monitor exists for overloaded machines, where `ps` itself can take a long time to be
// scheduled; at load 38 on 16 cores a 15s timeout failed every sweep and blinded the monitor
// exactly when it mattered. 45s still ends inside the 60s sweep interval, and the monitor's
// sweepInFlight guard stops a slow sweep from overlapping the next.
const SAMPLE_TIMEOUT_MS = 45_000;

/**
 * Runs a sampling tool at SAMPLER_NICE: below normal, so the daemon's own telemetry yields to
 * interactive work, but ahead of the agent builds it measures, so it is still scheduled on a
 * saturated machine. Only the child is lowered, never the daemon: a lowered priority cannot be
 * raised again without root.
 */
export async function execFileAtLowPriority(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<string> {
  const pending = execFileAsync(file, [...args], { ...options, encoding: "utf8" });
  lowerProcessPriority(pending.child.pid, SAMPLER_NICE);
  const { stdout } = await pending;
  return stdout;
}

async function sampleMacosMemory(): Promise<SystemMemorySample | undefined> {
  const options = { timeout: SAMPLE_TIMEOUT_MS };
  try {
    const [memsize, swapUsage, vmStat] = await Promise.all([
      execFileAtLowPriority("sysctl", ["-n", "hw.memsize"], options),
      execFileAtLowPriority("sysctl", ["vm.swapusage"], options),
      execFileAtLowPriority("vm_stat", [], options).catch(() => undefined),
    ]);
    const totalPhysicalBytes = Number.parseInt(memsize.trim(), 10);
    const swap = parseMacosSwapUsage(swapUsage);
    if (!Number.isFinite(totalPhysicalBytes) || !swap) return undefined;
    const availableBytes = vmStat ? parseMacosVmStat(vmStat) : undefined;
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

// Windows has no `ps`. CreationDate is turned into an age in PowerShell so the parser never has
// to read CIM or /Date()/ timestamps, whose JSON shape differs between PowerShell 5.1 and 7.
const WINDOWS_PROCESS_QUERY =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $now=Get-Date; " +
  "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ " +
  "ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; WorkingSetSize=$_.WorkingSetSize; " +
  "UserModeTime=$_.UserModeTime; KernelModeTime=$_.KernelModeTime; " +
  "AgeSeconds=$(if ($_.CreationDate) { [int64]($now - $_.CreationDate).TotalSeconds } else { $null }); " +
  "Name=$_.Name; CommandLine=$_.CommandLine } } | ConvertTo-Json -Compress";

async function readSystemProcessTable(): Promise<ProcessSampleRow[]> {
  const options = { maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES, timeout: SAMPLE_TIMEOUT_MS };
  if (process.platform === "win32") {
    const stdout = await execFileAtLowPriority(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_PROCESS_QUERY,
      ],
      { ...options, windowsHide: true },
    );
    return parseWindowsProcessJson(stdout);
  }
  return parsePsOutput(await execFileAtLowPriority("ps", PS_ARGS, options));
}

export interface SystemProcessSamplerOptions {
  logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
  };
  /** Reads the platform's process table; injectable so tests can fail it without spawning. */
  readProcessTable?: () => Promise<ProcessSampleRow[]>;
  /** Injectable so tests control load and free memory. */
  loadSampler?: SystemLoadSampler;
}

export function createSystemProcessSampler(
  options: SystemProcessSamplerOptions,
): ResourceMonitorSampler {
  const readProcessTable = options.readProcessTable ?? readSystemProcessTable;
  const loadSampler = options.loadSampler ?? createSystemLoadSampler();
  // Warn when a failure streak starts and say when it ends, rather than once for the life of the
  // daemon: the outage that matters is the second one, on a loaded machine, hours after the first.
  let failedSamples = 0;
  async function sampleProcessTable(): Promise<ProcessTableSample> {
    try {
      const rows = await readProcessTable();
      // A machine always has processes; an empty table is output nobody could parse.
      if (rows.length === 0) throw new Error("The process table came back empty");
      if (failedSamples > 0) {
        options.logger.info({ failedSamples }, "Resource monitor can sample processes again");
        failedSamples = 0;
      }
      return { status: "ok", rows };
    } catch (error) {
      failedSamples += 1;
      if (failedSamples === 1) {
        options.logger.warn(
          { err: error },
          "Resource monitor cannot sample processes; load and memory are still watched, " +
            "and attribution uses the last good sample until this recovers",
        );
      }
      return { status: "failed", error };
    }
  }
  return {
    sampleProcessTable,
    async sampleProcesses() {
      const sample = await sampleProcessTable();
      return sample.status === "ok" ? sample.rows : [];
    },
    async sampleSystemMemory() {
      if (process.platform === "darwin") return sampleMacosMemory();
      if (process.platform === "linux") return sampleLinuxMemory();
      return undefined;
    },
    sampleSystemLoad: () => loadSampler.sample(),
  };
}
