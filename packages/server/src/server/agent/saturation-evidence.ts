import { describeProcess } from "./memory-consumers.js";
import type { AgentProcessTree } from "./process-attribution.js";
import type { ProcessSampleRow } from "./process-sampler.js";
import type { SystemLoadReading } from "./system-load.js";

/**
 * What was running while the machine was saturated, and what the load most likely is. Pure: the
 * monitor hands it a process sample and a load reading, and the ledger and the remediation rung
 * both read the result. See docs/resource-monitor.md.
 */

const TOP_AGENT_TREES = 5;
const TOP_COMMANDS_PER_TREE = 3;
const TOP_OTHER_PROCESSES = 8;
const TOP_IO_PROCESSES = 8;
const MAX_COMMAND_CHARS = 200;
// Sampled CPU at least this share of the cores is a CPU-bound machine. It is measured against the
// cores, not the load: sampled CPU can never exceed the cores, and saturation opens at 2x cores,
// so it never explains half the load. A high load with the cores not pegged is I/O: the macOS and
// Linux load average counts tasks waiting on disk, not only runnable ones.
const CPU_PEGGED_SHARE = 0.8;

/**
 * Programs that commonly load a machine through disk rather than CPU: Spotlight indexing fresh
 * `node_modules`, package installs, git, and tree walks. Used only to name suspects in I/O-bound
 * evidence, never to act on.
 */
const IO_PROCESS_NAMES = new Set([
  "mds",
  "mds_stores",
  "mdworker",
  "mdworker_shared",
  "mdsync",
  "fseventsd",
  "backupd",
  "bfs",
  "find",
  "fd",
  "du",
  "rg",
  "git",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "rsync",
  "tar",
  "unzip",
  "ditto",
  "cp",
]);

// A package install run through node (`node .../npm-cli.js ci`) shows up under node's name.
const PACKAGE_INSTALL = /\b(npm|pnpm|yarn)(-cli\.js)?\s+(ci|install|i|add)\b/;

function isLikelyIo(row: ProcessSampleRow): boolean {
  return IO_PROCESS_NAMES.has(describeProcess(row.command)) || PACKAGE_INSTALL.test(row.command);
}

/** The process sample the evidence came from: this sweep's, an older one reused, or none. */
export type ProcessSampleFreshness =
  | { status: "fresh"; ageMs: 0 }
  | { status: "stale"; ageMs: number }
  | { status: "none" };

export interface EvidenceProcess {
  pid: number;
  name: string;
  command: string;
  cpuPercent: number;
  rssBytes: number;
}

export interface EvidenceAgentTree {
  agentId: string;
  title: string | null;
  cwd: string | null;
  cpuPercent: number;
  rssBytes: number;
  topCommands: EvidenceProcess[];
}

/**
 * `cpu`: the sampled processes keep the cores pegged. `io`: they don't, and the sample is fresh,
 * so the load is tasks waiting on disk. `unknown`: no fresh sample to split it with.
 * Loads are in the load average's unit, cores' worth of work: summed CPU% / 100.
 */
export interface SaturationCause {
  kind: "cpu" | "io" | "unknown";
  explainedByAgents: number;
  explainedByOthers: number;
  unexplained: number;
  /** Likely I/O processes in the sample, named when the cause is `io`. */
  ioProcesses: EvidenceProcess[];
}

export interface SaturationEvidence {
  sample: ProcessSampleFreshness;
  cause: SaturationCause;
  agentTrees: EvidenceAgentTree[];
  otherProcesses: EvidenceProcess[];
}

export interface EvidenceProcessSample {
  /** Rows with CPU already turned into a rate (process-cpu-rate.ts). */
  rows: readonly ProcessSampleRow[];
  agentTrees: readonly AgentProcessTree[];
  takenAtMs: number;
}

export interface AgentLabel {
  title: string | null;
  cwd: string | null;
}

function toEvidenceProcess(row: ProcessSampleRow): EvidenceProcess {
  return {
    pid: row.pid,
    name: describeProcess(row.command),
    command: row.command.slice(0, MAX_COMMAND_CHARS),
    cpuPercent: Math.round(row.cpuPercent),
    rssBytes: row.rssKb * 1024,
  };
}

function byCpu(a: ProcessSampleRow, b: ProcessSampleRow): number {
  return b.cpuPercent - a.cpuPercent;
}

// Windows lists idle time as pid 0, "System Idle Process"; its CPU is the opposite of load.
function isIdlePseudoProcess(row: ProcessSampleRow): boolean {
  return row.pid === 0;
}

function sumCores(rows: readonly ProcessSampleRow[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.cpuPercent), 0) / 100;
}

function classifyCause(input: {
  load: SystemLoadReading | undefined;
  fresh: boolean;
  agentRows: readonly ProcessSampleRow[];
  otherRows: readonly ProcessSampleRow[];
}): SaturationCause {
  const explainedByAgents = sumCores(input.agentRows);
  const explainedByOthers = sumCores(input.otherRows);
  const load1 = input.load?.load1 ?? 0;
  const unexplained = Math.max(0, load1 - explainedByAgents - explainedByOthers);
  const base = { explainedByAgents, explainedByOthers, unexplained };
  if (!input.fresh || !input.load) return { kind: "unknown", ...base, ioProcesses: [] };
  // Windows' reading is CPU busy time, so nothing in it is waiting on disk: whatever the sample
  // misses is CPU spent by processes too short-lived to be sampled, or by the kernel.
  const pegged = explainedByAgents + explainedByOthers >= CPU_PEGGED_SHARE * input.load.cores;
  if (input.load.kind === "cpu-busy" || pegged) {
    return { kind: "cpu", ...base, ioProcesses: [] };
  }
  const ioProcesses = [...input.agentRows, ...input.otherRows]
    .filter(isLikelyIo)
    .sort(byCpu)
    .slice(0, TOP_IO_PROCESSES)
    .map(toEvidenceProcess);
  return { kind: "io", ...base, ioProcesses };
}

export function buildSaturationEvidence(input: {
  load: SystemLoadReading | undefined;
  sample: EvidenceProcessSample | undefined;
  /** False when `sample` is an older sample reused because this sweep's failed. */
  fresh: boolean;
  nowMs: number;
  agentLabels: ReadonlyMap<string, AgentLabel>;
}): SaturationEvidence {
  const { sample } = input;
  if (!sample) {
    return {
      sample: { status: "none" },
      cause: classifyCause({ load: input.load, fresh: false, agentRows: [], otherRows: [] }),
      agentTrees: [],
      otherProcesses: [],
    };
  }

  const rows = sample.rows.filter((row) => !isIdlePseudoProcess(row));
  const rowsByPid = new Map(rows.map((row) => [row.pid, row] as const));
  const agentPids = new Set(sample.agentTrees.flatMap((tree) => tree.pids));
  const agentRows = rows.filter((row) => agentPids.has(row.pid));
  const otherRows = rows.filter((row) => !agentPids.has(row.pid));

  const agentTrees = [...sample.agentTrees]
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, TOP_AGENT_TREES)
    .map((tree): EvidenceAgentTree => {
      const label = input.agentLabels.get(tree.agentId);
      const treeRows = tree.pids.flatMap((pid) => rowsByPid.get(pid) ?? []);
      return {
        agentId: tree.agentId,
        title: label?.title ?? null,
        cwd: label?.cwd ?? null,
        cpuPercent: Math.round(tree.cpuPercent),
        rssBytes: tree.rssBytes,
        topCommands: treeRows.sort(byCpu).slice(0, TOP_COMMANDS_PER_TREE).map(toEvidenceProcess),
      };
    });

  return {
    sample: input.fresh
      ? { status: "fresh", ageMs: 0 }
      : { status: "stale", ageMs: Math.max(0, input.nowMs - sample.takenAtMs) },
    cause: classifyCause({ load: input.load, fresh: input.fresh, agentRows, otherRows }),
    agentTrees,
    otherProcesses: [...otherRows].sort(byCpu).slice(0, TOP_OTHER_PROCESSES).map(toEvidenceProcess),
  };
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatLoad(load: SystemLoadReading | undefined): string {
  if (!load) return "Load: no reading yet.";
  if (load.kind === "cpu-busy") {
    return `CPU ${Math.round(load.busyFraction * 100)}% busy across ${load.cores} cores.`;
  }
  return (
    `Load ${load.load1.toFixed(1)} / ${load.load5.toFixed(1)} / ${load.load15.toFixed(1)} ` +
    `on ${load.cores} cores.`
  );
}

function formatSample(sample: ProcessSampleFreshness): string {
  if (sample.status === "fresh") return "Processes sampled this sweep.";
  if (sample.status === "none") return "No process sample yet; what is running is unknown.";
  return `Process sample is ${Math.round(sample.ageMs / 1000)}s old (sampling is failing).`;
}

function formatProcess(process: EvidenceProcess): string {
  return `${process.name} pid ${process.pid}: ${process.cpuPercent}% CPU, ${formatGb(process.rssBytes)}`;
}

function formatCause(cause: SaturationCause): string {
  const split =
    `agents ${cause.explainedByAgents.toFixed(1)}, other processes ` +
    `${cause.explainedByOthers.toFixed(1)}, unexplained ${cause.unexplained.toFixed(1)}`;
  if (cause.kind === "cpu") return `Cause: CPU (${split}).`;
  if (cause.kind === "unknown") return `Cause: unknown, no fresh process sample (${split}).`;
  const suspects = cause.ioProcesses.map((process) => process.name);
  return (
    `Cause: I/O, tasks waiting on disk (${split}).` +
    (suspects.length > 0 ? ` Likely I/O: ${[...new Set(suspects)].join(", ")}.` : "")
  );
}

/** Plain-text evidence for a person or a remediation agent. */
export function formatSaturationEvidence(
  load: SystemLoadReading | undefined,
  evidence: SaturationEvidence,
): string {
  const lines = [formatLoad(load), formatSample(evidence.sample), formatCause(evidence.cause)];
  if (evidence.agentTrees.length > 0) {
    lines.push("Heaviest agent trees:");
    for (const tree of evidence.agentTrees) {
      const name = tree.title ?? tree.agentId;
      lines.push(
        `- ${name} (${tree.agentId}${tree.cwd ? `, ${tree.cwd}` : ""}): ${tree.cpuPercent}% CPU, ` +
          `${formatGb(tree.rssBytes)}`,
      );
      for (const command of tree.topCommands) lines.push(`  - ${formatProcess(command)}`);
    }
  }
  if (evidence.otherProcesses.length > 0) {
    lines.push("Heaviest other processes:");
    for (const process of evidence.otherProcesses) lines.push(`- ${formatProcess(process)}`);
  }
  return lines.join("\n");
}
