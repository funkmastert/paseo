import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/**
 * One row of `ps -axo pid,ppid,rss,pcpu,etime,command` output. `command` is the full command
 * line (used by process-attribution.ts to find the `callerAgentId=<id>` marker and to
 * recognize known build daemons), so it's read greedily as everything past the fixed columns —
 * it's the one field that legitimately contains spaces.
 */
export interface ProcessSampleRow {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuPercent: number;
  etime: string;
  command: string;
}

const PS_ROW_FIELD_COUNT = 6;

function parsePsLine(line: string): ProcessSampleRow | undefined {
  const parts = line.split(/\s+/);
  if (parts.length < PS_ROW_FIELD_COUNT) {
    return undefined;
  }
  const [pidText, ppidText, rssText, cpuText, etime, ...commandParts] = parts;
  const pid = Number.parseInt(pidText, 10);
  const ppid = Number.parseInt(ppidText, 10);
  const rssKb = Number.parseInt(rssText, 10);
  const cpuPercent = Number.parseFloat(cpuText);
  if (![pid, ppid, rssKb, cpuPercent].every(Number.isFinite)) {
    return undefined;
  }
  return { pid, ppid, rssKb, cpuPercent, etime, command: commandParts.join(" ") };
}

/**
 * Parses `ps -axo pid,ppid,rss,pcpu,etime,command` output. The first line is `ps`'s own header
 * (`PID PPID RSS %CPU ELAPSED COMMAND` on both macOS and Linux for this column spec) and is
 * always skipped; any other line that doesn't parse to five numeric-ish leading fields is
 * dropped rather than throwing — a `ps` snapshot racing process exit routinely has partial or
 * empty lines.
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
  return {
    totalPhysicalBytes: totalKb * 1024,
    swapTotalBytes: swapTotalKb * 1024,
    swapUsedBytes: (swapTotalKb - swapFreeKb) * 1024,
  };
}

/**
 * Injectable seam for AgentResourceMonitor's sweep — the real implementation shells out to
 * `ps`/`sysctl` or reads `/proc/meminfo`; tests supply a fake that returns fixture rows without
 * spawning anything. `sampleSystemMemory` resolves to undefined on any failure (unreadable
 * `/proc/meminfo`, `sysctl` missing, unrecognized platform) — the caller treats that sweep as
 * "no system memory signal" rather than throwing, since this is best-effort telemetry, not a
 * critical path.
 */
export interface ProcessSampler {
  sampleProcesses(): Promise<ProcessSampleRow[]>;
  sampleSystemMemory(): Promise<SystemMemorySample | undefined>;
}

const execFileAsync = promisify(execFile);
const PS_ARGS = ["-axo", "pid,ppid,rss,pcpu,etime,command"];
const PS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

async function sampleMacosMemory(): Promise<SystemMemorySample | undefined> {
  try {
    const [memsize, swapUsage] = await Promise.all([
      execFileAsync("sysctl", ["-n", "hw.memsize"]),
      execFileAsync("sysctl", ["vm.swapusage"]),
    ]);
    const totalPhysicalBytes = Number.parseInt(memsize.stdout.trim(), 10);
    const swap = parseMacosSwapUsage(swapUsage.stdout);
    if (!Number.isFinite(totalPhysicalBytes) || !swap) return undefined;
    return { totalPhysicalBytes, ...swap };
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

export function createSystemProcessSampler(): ProcessSampler {
  return {
    async sampleProcesses() {
      const { stdout } = await execFileAsync("ps", PS_ARGS, { maxBuffer: PS_MAX_BUFFER_BYTES });
      return parsePsOutput(stdout);
    },
    async sampleSystemMemory() {
      if (process.platform === "darwin") return sampleMacosMemory();
      if (process.platform === "linux") return sampleLinuxMemory();
      return undefined;
    },
  };
}
