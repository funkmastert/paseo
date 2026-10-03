import type { ResourceAlert } from "@getpaseo/protocol/agent-types";
import {
  buildBatchedResourceNotificationPayload,
  buildResourceAgentNotificationPayload,
  buildArtifactJanitorNotificationPayload,
  buildResourceBuildDaemonReapNotificationPayload,
  type ReapedBuildDaemon,
} from "@getpaseo/protocol/resource-monitor-notification";
import type { AgentManager, ResourceMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  evaluateAgentResourceBreach,
  evaluateMachineResourceBreach,
  type MachineResourceMonitorState,
  type ResourceMonitorDetectorConfig,
} from "./agent/resource-monitor-detector.js";
import {
  type BuildDaemonConnectionChecker,
  type BuildDaemonCwdResolver,
  type BuildDaemonReapCandidate,
  type BuildDaemonReaperConfig,
  type BuildDaemonReaperMemory,
  type BuildDaemonSighting,
  type BuildDaemonVerdict,
  createSystemBuildDaemonConnectionChecker,
  createSystemBuildDaemonCwdResolver,
  createSystemProcessSignaller,
  evaluateBuildDaemonReapCandidates,
  markBuildDaemonHandled,
  type ProcessSignaller,
  selectBuildDaemonPidsNeedingConnectionCheck,
  selectBuildDaemonPidsNeedingCwd,
} from "./agent/build-daemon-reaper.js";
import {
  describePressure,
  evaluateMemoryBrake,
  MEMORY_HOLD_NOTICE_MS,
  MEMORY_HOLD_TRICKLE_AFTER_MS,
  type MemoryBrakeState,
} from "./agent/memory-brake.js";
import {
  describeProcess,
  formatMemoryConsumers,
  summarizeMemoryConsumers,
} from "./agent/memory-consumers.js";
import { attributeProcessTrees, type AgentProcessTree } from "./agent/process-attribution.js";
import { detectRunningDevices, type RunningDevice } from "./agent/device-detection.js";
import type { TestArtifactSweepResult } from "./agent/test-artifact-janitor.js";
import { withRecentCpuPercent, type CpuRateMemory } from "./agent/process-cpu-rate.js";
import type { OrphanBuildDaemonSummary } from "./agent/process-attribution.js";
import type {
  ProcessSampleRow,
  ResourceMonitorSampler,
  SystemMemorySample,
} from "./agent/process-sampler.js";
import {
  evaluateSaturation,
  isSaturated,
  type SaturationConfig,
  type SaturationEpisode,
  type SaturationState,
  type SaturationTransition,
} from "./agent/saturation-detector.js";
import {
  type AgentLabel,
  buildSaturationEvidence,
  type EvidenceProcessSample,
  formatSaturationEvidence,
  type SaturationEvidence,
} from "./agent/saturation-evidence.js";
import {
  buildSaturationLedgerRecord,
  type SaturationLedger,
  type SaturationLedgerEvent,
} from "./agent/saturation-ledger.js";
import type { SystemLoadReading, SystemLoadSample } from "./agent/system-load.js";
import type { PushNotificationSender, PushSendMeta } from "./push/index.js";
import { MonitorModeLog } from "./monitor-mode-log.js";
import {
  NULL_REMEDIATION_SINK,
  type RemediationSink,
  type RemedyAttempt,
  type RemedyState,
} from "./remediation/contract.js";
import {
  lowerProcessPriority as lowerProcessPriorityDefault,
  type LowerPriorityResult,
} from "../utils/process-priority.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const GIBIBYTE = 1024 ** 3;
const DEFAULT_MEMORY_BYTES_PER_AGENT = 6 * GIBIBYTE;
const DEFAULT_CPU_PERCENT_PER_AGENT = 400;
const DEFAULT_SUSTAINED_MINUTES = 3;
const DEFAULT_SYSTEM_SWAP_USED_RATIO = 0.9;
const DEFAULT_ORPHAN_BUILD_DAEMON_BYTES = 2 * GIBIBYTE;
const DEFAULT_BREACH_BATCH_THRESHOLD = 3;
// Reaper defaults. Off unless turned on, and deliberately slow to act once it is: a daemon has
// to look abandoned for a quarter of an hour across at least three sweeps, and at most two go
// per sweep. Gradle daemons exit cleanly on SIGTERM, so the grace window only has to cover an
// orderly shutdown — it blocks the sweep, so it stays well under the 60s interval.
const DEFAULT_REAPER_IDLE_CPU_PERCENT = 2;
const DEFAULT_REAPER_IDLE_MINUTES = 15;
const DEFAULT_REAPER_MIN_IDLE_SWEEPS = 3;
const DEFAULT_REAPER_MAX_PER_SWEEP = 2;
const DEFAULT_REAPER_GRACE_MS = 10_000;
// How long the ladder waits on swap pressure before it sends an agent. The reaper and the
// artifact janitor run inside every sweep, so ten minutes is ten chances for them to clear it.
const SYSTEM_MEMORY_GRACE_MS = 10 * 60_000;
// Saturation: a 1-minute load of two runnable tasks per core (macOS/Linux) or 90% of CPU time
// busy (Windows), for as many sweeps as the other legs' sustainedMinutes.
const DEFAULT_SATURATION_LOAD_PER_CORE = 2;
const DEFAULT_SATURATION_BUSY_FRACTION = 0.9;
// While an incident holds, the ledger gets a record this often, besides the open and the clear.
const SATURATION_LEDGER_INTERVAL_MS = 5 * 60_000;
// Child admission is held from the open until load falls to 1.5 runnable tasks per core (or 75%
// busy on Windows), a line below the threshold so a load hovering at it does not flap the hold.
const DEFAULT_SATURATION_RELEASE_LOAD_PER_CORE = 1.5;
const DEFAULT_SATURATION_RELEASE_BUSY_FRACTION = 0.75;
const DEFAULT_SATURATION_RENICE_TOP_TREES = 3;
// Agents already run at nice 10. On macOS and Linux 15 is a real step below them that still
// leaves room under it. On Windows libuv maps 10..18 to BELOW_NORMAL, where agents already are,
// so the only step further down is 19, IDLE.
const DEFAULT_SATURATION_RENICE_NICE = process.platform === "win32" ? 19 : 15;
// A tree using less than a core is not what is loading the machine, and a lowered priority is
// permanent on macOS and Linux, so it is left alone.
const SATURATION_RENICE_MIN_TREE_CPU_PERCENT = 100;
// Agent trees at or above this share of the sampled CPU are the cause, and the renice and the
// admission hold are the answer to it.
const SATURATION_AGENT_SHARE = 0.5;
// With a cause in hand the remedies (or the person's own apps) are the answer, so a person hears
// only if it outlasts them. With none, an agent goes to look soon.
const DEFAULT_SATURATION_ATTRIBUTED_GRACE_MINUTES = 30;
const DEFAULT_SATURATION_UNATTRIBUTED_GRACE_MINUTES = 5;
// An episode's list of what was done to it is capped so a daemon-heavy day cannot grow it forever.
const MAX_EPISODE_ATTEMPTS = 20;

// A critical-pressure push is announced once per spell; the key also rides the policy's cooldown.
const MEMORY_PRESSURE_CRITICAL_DEDUPE_KEY = "resource-monitor:memory-pressure-critical";
// The same for a memory hold that has outlasted MEMORY_HOLD_NOTICE_MS with children waiting.
const MEMORY_HOLD_NOTICE_DEDUPE_KEY = "resource-monitor:memory-hold-long";

const ORPHAN_DAEMONS_KEY = "orphan-build-daemons";
const SYSTEM_MEMORY_KEY = "system-memory";
const CPU_SATURATION_KEY = "cpu-saturation";

const ORPHAN_DAEMONS_TASK =
  "Find which orphaned build daemons are still running on this machine and why the reaper " +
  "spared them (the evidence lists them). They are Gradle and Kotlin daemons, .NET compiler and " +
  "build servers (VBCSCompiler, MSBuild node-reuse workers, the Razor server) and Metro " +
  "bundlers. Stop the ones that are safe to stop: run `./gradlew --stop` in the project that " +
  "owns a Gradle or Kotlin daemon, run `dotnet build-server shutdown` for the .NET servers, or " +
  "end an idle daemon whose build is gone. You must never touch a daemon under a running " +
  "agent's process tree, never a build that is still using CPU, and never any other process.";

const SYSTEM_MEMORY_TASK =
  "Find what is holding this machine's memory (the evidence lists the biggest process trees) and " +
  "stop only what is provably leftover: orphaned build daemons, simulators or emulators with no " +
  "device lease, and dev servers that belonged to archived agents. You must never touch a " +
  "process of a running agent, and never the Paseo daemon.";

const CPU_SATURATION_TASK =
  "Find what is loading this machine's CPU. Process sampling is failing, so the daemon could not " +
  "tell: the evidence has the load and the last sample it had, with its age. Stop only processes " +
  "that are provably leftover: orphaned build daemons whose launcher is gone (`./gradlew --stop`, " +
  "`dotnet build-server shutdown`), and test runners, simulators or dev servers that belonged to " +
  "archived agents. You must never touch a running agent's processes, the Paseo daemon, or the " +
  "user's own applications such as Android Studio, Xcode or a browser. If `ps` itself hangs, " +
  "say so and report what you could see.";

export interface ResourceMonitorReaperConfig {
  enabled?: boolean;
  dryRun?: boolean;
  idleCpuPercent?: number;
  idleMinutes?: number;
  minIdleSweeps?: number;
  maxPerSweep?: number;
  graceMs?: number;
}

export interface ResourceMonitorSaturationConfig {
  enabled?: boolean;
  loadPerCore?: number;
  busyFraction?: number;
  sustainedMinutes?: number;
  releaseLoadPerCore?: number;
  releaseBusyFraction?: number;
  reniceTopTrees?: number;
  reniceNice?: number;
  attributedGraceMinutes?: number;
  unattributedGraceMinutes?: number;
}

export interface ResourceMonitorConfig {
  enabled?: boolean;
  memoryBytesPerAgent?: number;
  cpuPercentPerAgent?: number;
  sustainedMinutes?: number;
  systemSwapUsedRatio?: number;
  orphanBuildDaemonBytes?: number;
  notifyAgent?: boolean;
  reaper?: ResourceMonitorReaperConfig;
  saturation?: ResourceMonitorSaturationConfig;
}

/**
 * The process sample attribution comes from. Kept after the sweep that took it, so a sweep whose
 * own sample failed can still say what was running, marked with its age.
 */
interface AttributedProcessSample extends EvidenceProcessSample {
  orphanBuildDaemons: OrphanBuildDaemonSummary;
}

/**
 * One sweep's saturation state, for whatever acts on it. Undefined (see getSaturationSweep) while
 * the machine is not saturated.
 */
export interface SaturationSweep {
  atMs: number;
  /** `opened`, `held` or `cleared`; `quiet` sweeps produce no SaturationSweep. */
  transition: Exclude<SaturationTransition, "quiet">;
  episode: SaturationEpisode;
  systemLoad: SystemLoadSample;
  systemMemory: SystemMemorySample | undefined;
  /** `evidence.sample` says whether the rows below are this sweep's or an older sample's. */
  evidence: SaturationEvidence;
  /**
   * The rows and trees the evidence came from. Stale unless `evidence.sample.status` is
   * `fresh`: never act on stale rows as proof that something is idle or gone.
   */
  processSample: EvidenceProcessSample | undefined;
}

interface AgentResourceMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentResourceMonitorOptions {
  agentManager: Pick<
    AgentManager,
    | "getChildAdmission"
    | "listAgentsForResourceMonitor"
    | "getResourceMonitorState"
    | "setResourceMonitorState"
    | "setResourceAlert"
    | "clearResourceAlert"
  >;
  /**
   * `list` widens the reaper's attribution beyond the agent marker: every cwd ever recorded for
   * an agent (live or archived) is a directory a build daemon found there can be tied to, even
   * with no marker in its own command line (docs/resource-monitor.md).
   */
  agentStorage: Pick<AgentStorage, "get" | "list">;
  pushNotificationSender: PushNotificationSender;
  /**
   * Where the two machine-level conditions (orphan build daemons, swap pressure) are reported.
   * The ladder owns the person-facing push for them; this monitor pushes nothing about either.
   * Absent: they are observed by no one (docs/remediation.md).
   */
  remediationSink?: RemediationSink;
  serverId: string;
  processSampler: ResourceMonitorSampler;
  /**
   * Where saturation incidents are written so they survive a reboot
   * (agent/saturation-ledger.ts). Absent: detected, but not recorded.
   */
  saturationLedger?: SaturationLedger;
  /**
   * Delivers ONE system-authored message into a running agent's conversation, reusing the same
   * steer path chat mentions and notify-on-finish use (agent-prompt.ts's sendPromptToAgent with
   * `activeTurnBehavior: "steer"`, `unarchive: false`). Injected as a narrow function rather
   * than called directly so this class's own dependency surface stays a
   * `Pick<AgentManager, ...>` instead of the full `AgentManager` sendPromptToAgent requires —
   * bootstrap.ts closes over the real agentManager/agentStorage/logger to build it.
   */
  sendSystemMessageToAgent: (agentId: string, body: string) => Promise<void>;
  readDaemonConfig: () => { resourceMonitor?: ResourceMonitorConfig };
  logger: AgentResourceMonitorLogger;
  sweepIntervalMs?: number;
  now?: () => number;
  /** Injectable for the same reason as processSampler: tests reap without signalling a real pid. */
  processSignaller?: ProcessSignaller;
  /** The uid the daemon runs as. Defaults to this process's; undefined disables reaping. */
  ownerUid?: number | undefined;
  /**
   * Configured Paseo worktree root directories (e.g. `~/.paseo/worktrees`), the other half of
   * the reaper's directory-based attribution alongside every agent's recorded cwd. Defaults to
   * none, which leaves attribution to the marker and agent cwds alone.
   */
  worktreeRootDirs?: readonly string[];
  /** Injectable so tests never shell out to a real `lsof`. Defaults to a batched system lookup. */
  cwdResolver?: BuildDaemonCwdResolver;
  /** Which Metro pids have an ESTABLISHED TCP client. Injectable for the same reason. */
  connectionChecker?: BuildDaemonConnectionChecker;
  /** Never an agent-owned directory, nor anything above it. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** The SIGTERM grace wait, injectable so tests don't spend it. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Hands the device cap (docs/device-leases.md) the simulators and emulators found in this
   * sweep's `ps` sample. It is a sibling of this monitor, not a leg of it: the cap decides
   * nothing here, it just gets the scan for free rather than running a second `ps` a minute.
   */
  reportDeviceSample?: (sample: {
    devices: RunningDevice[];
    systemMemory: SystemMemorySample | undefined;
  }) => Promise<void>;
  /**
   * Hands the artifact janitor (docs/artifact-janitor.md) this sweep's `ps` rows and returns
   * whatever it reclaimed. A sibling like the device cap, not a leg: the janitor decides
   * everything itself and only needs the scan and the cadence. Its result is pushed here rather
   * than by the janitor, so every "something was removed automatically" report in the daemon
   * goes out through one path.
   */
  sweepTestArtifacts?: (input: {
    rows: readonly ProcessSampleRow[];
  }) => Promise<TestArtifactSweepResult>;
  /**
   * Holds (true) or releases (false) the start of new child-agent turns while the machine is
   * saturated or short of memory: one hold for both, released only when neither holds it. Called
   * on changes only, and always with false on stop and when the monitor is turned off. Absent:
   * nothing is held.
   */
  holdChildAdmission?: (held: boolean, reason: string) => void;
  /** Injectable so tests never renice a real pid. Defaults to utils/process-priority.ts's. */
  lowerProcessPriority?: (pid: number, nice: number) => LowerPriorityResult;
  /**
   * Processes the daemon runs as an agent's own work (`ask_jev`'s command), by agent: extra roots
   * of each agent's tree (agent/agent-side-processes.ts). Absent: none.
   */
  readAgentSideProcesses?: () => ReadonlyMap<string, readonly number[]>;
}

interface ResolvedReaperConfig extends BuildDaemonReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  graceMs: number;
}

interface ResolvedSaturationConfig extends SaturationConfig {
  releaseLoadPerCore: number;
  releaseBusyFraction: number;
  reniceTopTrees: number;
  reniceNice: number;
  attributedGraceMs: number;
  unattributedGraceMs: number;
}

interface ResolvedResourceMonitorConfig extends ResourceMonitorDetectorConfig {
  notifyAgent: boolean;
  reaper: ResolvedReaperConfig;
  saturation: ResolvedSaturationConfig;
}

function resolveReaperConfig(
  config: ResourceMonitorReaperConfig | undefined,
): ResolvedReaperConfig {
  return {
    enabled: config?.enabled ?? false,
    dryRun: config?.dryRun ?? false,
    idleCpuPercent: config?.idleCpuPercent ?? DEFAULT_REAPER_IDLE_CPU_PERCENT,
    idleMinutes: config?.idleMinutes ?? DEFAULT_REAPER_IDLE_MINUTES,
    minIdleSweeps: config?.minIdleSweeps ?? DEFAULT_REAPER_MIN_IDLE_SWEEPS,
    maxPerSweep: config?.maxPerSweep ?? DEFAULT_REAPER_MAX_PER_SWEEP,
    graceMs: config?.graceMs ?? DEFAULT_REAPER_GRACE_MS,
  };
}

function resolveConfig(config: ResourceMonitorConfig | undefined): ResolvedResourceMonitorConfig {
  return {
    memoryBytesPerAgent: config?.memoryBytesPerAgent ?? DEFAULT_MEMORY_BYTES_PER_AGENT,
    cpuPercentPerAgent: config?.cpuPercentPerAgent ?? DEFAULT_CPU_PERCENT_PER_AGENT,
    sustainedMinutes: config?.sustainedMinutes ?? DEFAULT_SUSTAINED_MINUTES,
    systemSwapUsedRatio: config?.systemSwapUsedRatio ?? DEFAULT_SYSTEM_SWAP_USED_RATIO,
    orphanBuildDaemonBytes: config?.orphanBuildDaemonBytes ?? DEFAULT_ORPHAN_BUILD_DAEMON_BYTES,
    notifyAgent: config?.notifyAgent ?? true,
    reaper: resolveReaperConfig(config?.reaper),
    saturation: resolveSaturationConfig(config),
  };
}

function resolveSaturationConfig(
  config: ResourceMonitorConfig | undefined,
): ResolvedSaturationConfig {
  const saturation = config?.saturation;
  return {
    enabled: saturation?.enabled ?? true,
    loadPerCore: saturation?.loadPerCore ?? DEFAULT_SATURATION_LOAD_PER_CORE,
    busyFraction: saturation?.busyFraction ?? DEFAULT_SATURATION_BUSY_FRACTION,
    sustainedMinutes:
      saturation?.sustainedMinutes ?? config?.sustainedMinutes ?? DEFAULT_SUSTAINED_MINUTES,
    ...resolveSaturationRemedyConfig(saturation),
  };
}

/** The remediation rung's half of the saturation block. */
function resolveSaturationRemedyConfig(
  saturation: ResourceMonitorSaturationConfig | undefined,
): Omit<ResolvedSaturationConfig, keyof SaturationConfig> {
  return {
    releaseLoadPerCore: saturation?.releaseLoadPerCore ?? DEFAULT_SATURATION_RELEASE_LOAD_PER_CORE,
    releaseBusyFraction:
      saturation?.releaseBusyFraction ?? DEFAULT_SATURATION_RELEASE_BUSY_FRACTION,
    reniceTopTrees: saturation?.reniceTopTrees ?? DEFAULT_SATURATION_RENICE_TOP_TREES,
    reniceNice: saturation?.reniceNice ?? DEFAULT_SATURATION_RENICE_NICE,
    attributedGraceMs:
      (saturation?.attributedGraceMinutes ?? DEFAULT_SATURATION_ATTRIBUTED_GRACE_MINUTES) * 60_000,
    unattributedGraceMs:
      (saturation?.unattributedGraceMinutes ?? DEFAULT_SATURATION_UNATTRIBUTED_GRACE_MINUTES) *
      60_000,
  };
}

function isBelowRelease(load: SystemLoadReading, config: ResolvedSaturationConfig): boolean {
  return load.kind === "loadavg"
    ? load.load1 < config.releaseLoadPerCore * load.cores
    : load.busyFraction < config.releaseBusyFraction;
}

function describeLoad(load: SystemLoadReading | undefined): string {
  if (!load) return "no load reading";
  return load.kind === "loadavg"
    ? `load ${load.load1.toFixed(1)} on ${load.cores} cores`
    : `CPU ${Math.round(load.busyFraction * 100)}% busy on ${load.cores} cores`;
}

/**
 * What the evidence says is loading the machine, which decides the rung's response. Only
 * `unattributed` is a job for an agent: every other answer is either the remedies' to fix or
 * belongs to something no agent may touch.
 */
type SaturationAttribution = "agents" | "other-processes" | "io" | "unattributed";

function attributeSaturation(evidence: SaturationEvidence): SaturationAttribution {
  const { cause } = evidence;
  if (cause.kind === "unknown") return "unattributed";
  if (cause.kind === "io") return "io";
  const sampled = cause.explainedByAgents + cause.explainedByOthers;
  return sampled > 0 && cause.explainedByAgents / sampled >= SATURATION_AGENT_SHARE
    ? "agents"
    : "other-processes";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

function describeReapedDaemon(daemon: ReapedBuildDaemon): string {
  return (
    `${daemon.label} pid ${daemon.pid} (${formatBytes(daemon.rssBytes)}, ` +
    `idle ${Math.round(daemon.idleMs / 60_000)}m)`
  );
}

function toReapedBuildDaemon(candidate: BuildDaemonReapCandidate): ReapedBuildDaemon {
  return {
    pid: candidate.pid,
    label: candidate.label,
    rssBytes: candidate.rssBytes,
    idleMs: candidate.idleMs,
  };
}

function formatBytes(bytes: number): string {
  return bytes >= GIBIBYTE
    ? `${(bytes / GIBIBYTE).toFixed(1)} GB`
    : `${Math.round(bytes / 1_048_576)} MB`;
}

/**
 * Pushed at once when macOS reports critical memory pressure: jetsam is about to start killing,
 * and the ladder's system-memory grace is ten minutes. `resource_system_memory` is the swap
 * alarm's reason, so the app opens the server as it does for that one.
 */
function buildMemoryPressureCriticalPayload(serverId: string, systemMemory: SystemMemorySample) {
  return {
    title: "Memory pressure is critical",
    body:
      `macOS reports critical memory pressure (swap ${formatBytes(systemMemory.swapUsedBytes)} ` +
      `of ${formatBytes(systemMemory.swapTotalBytes)}). New child-agent turns are held; ` +
      "running turns are untouched.",
    data: { serverId, reason: "resource_system_memory" as const },
  };
}

/**
 * Pushed once per memory hold that has lasted MEMORY_HOLD_NOTICE_MS with a child waiting. The
 * ladder hears the hold only while its swap alarm is open, and warn from a full compressor with
 * little swap never opens it, so without this a hold could last all day and nobody would know.
 */
function buildMemoryHoldNoticePayload(input: {
  serverId: string;
  systemMemory: SystemMemorySample | undefined;
  heldForMs: number;
  waiting: number | undefined;
}) {
  const { systemMemory } = input;
  const level = systemMemory?.memoryPressureLevel;
  const pressure =
    level === undefined
      ? "memory pressure has not been readable"
      : `memory pressure is ${describePressure(level)} (${level})`;
  const swap = systemMemory
    ? `, swap ${formatBytes(systemMemory.swapUsedBytes)} of ${formatBytes(systemMemory.swapTotalBytes)}`
    : "";
  const waiting =
    input.waiting === undefined
      ? "New child-agent turns are waiting"
      : `${input.waiting} child-agent ${input.waiting === 1 ? "turn is" : "turns are"} waiting`;
  const trickleMinutes = MEMORY_HOLD_TRICKLE_AFTER_MS / 60_000;
  return {
    title: "Child agents are waiting on memory",
    body:
      `New child-agent turns have been held for ${Math.round(input.heldForMs / 60_000)} min: ` +
      `${pressure}${swap}. ${waiting}; running turns are untouched. Once it has held ` +
      `${trickleMinutes} min with swap not growing, one starts per minute. To start them all ` +
      "now, set agents.admission.enabled to false in config.json (this also lifts the " +
      "child-turn cap; it applies without a restart).",
    data: { serverId: input.serverId, reason: "resource_system_memory" as const },
  };
}

function computeSwapUsedRatio(systemMemory: SystemMemorySample): number {
  return systemMemory.swapTotalBytes > 0
    ? systemMemory.swapUsedBytes / systemMemory.swapTotalBytes
    : 0;
}

function formatAgentResourceMessage(input: {
  memoryBytes: number;
  cpuPercent: number;
  memoryBytesLimit: number;
  cpuPercentLimit: number;
}): string {
  const memoryGb = (input.memoryBytes / GIBIBYTE).toFixed(1);
  const limitGb = (input.memoryBytesLimit / GIBIBYTE).toFixed(1);
  return (
    `Bozeo resource monitor: your process tree is using ${memoryGb} GB of memory and ` +
    `${Math.round(input.cpuPercent)}% CPU over the last minute ` +
    `(limits ${limitGb} GB / ${input.cpuPercentLimit}%). ` +
    "Stop or trim heavy child processes before continuing; if you launched Gradle, run " +
    "`./gradlew --stop`. Prefer sequential builds."
  );
}

/** What the reaper did and saw in one sweep, for the conditions it is the remedy of. */
interface ReaperPass {
  /** Reaps, or in a dry run what it would have reaped. */
  attempts: RemedyAttempt[];
  /** Why the daemons it left alone were left alone; undefined when there were none. */
  spared: RemedyAttempt | undefined;
  /** Daemons selected this sweep. Zero on a live reaper means nothing reclaimable remains. */
  candidateCount: number;
}

const NO_REAPER_PASS: ReaperPass = { attempts: [], spared: undefined, candidateCount: 0 };

/** The verdicts that mean "left alone", in the order the summary lists them. */
const SPARED_VERDICTS: readonly BuildDaemonVerdict[] = [
  "busy",
  "serving-clients",
  "idle-accumulating",
  "first-sighting",
  "not-abandoned",
  "not-on-allowlist",
];

function reaperRemedyState(reaper: ResolvedReaperConfig): RemedyState {
  if (!reaper.enabled) return "disabled";
  return reaper.dryRun ? "dry-run" : "live";
}

function describeOrphanRemedyState(remedy: RemedyState): string {
  if (remedy === "live") return "";
  if (remedy === "dry-run") return " The reaper is in dry run, so it has not stopped them.";
  return " The reaper is off, so nothing has stopped them.";
}

function describeReaperLineForSystemMemory(
  reaper: ResolvedReaperConfig,
  candidateCount: number,
): string {
  if (!reaper.enabled) return "Reaper: off, so nothing reclaims build daemons automatically.";
  if (reaper.dryRun) return "Reaper: dry run, so it cannot free anything.";
  if (candidateCount === 0) return "Reaper: live, and it has no reclaimable daemons left.";
  return (
    `Reaper: live, with ${candidateCount} reclaimable daemon${candidateCount === 1 ? "" : "s"} ` +
    "this sweep."
  );
}

function summarizeSparedDaemons(
  sightings: readonly BuildDaemonSighting[],
  memory: BuildDaemonReaperMemory,
  selectedCount: number,
  at: string,
): RemedyAttempt | undefined {
  const counts = new Map<string, number>();
  const bump = (reason: string): void => void counts.set(reason, (counts.get(reason) ?? 0) + 1);
  let candidates = 0;
  for (const sighting of sightings) {
    if (memory.get(sighting.pid)?.handled === "not-permitted") {
      bump("not-permitted");
    } else if (sighting.verdict === "candidate") {
      candidates += 1;
    } else if (SPARED_VERDICTS.includes(sighting.verdict)) {
      bump(sighting.verdict);
    }
  }
  if (candidates > selectedCount)
    counts.set("queued behind maxPerSweep", candidates - selectedCount);
  if (counts.size === 0) return undefined;
  const reasons = [...SPARED_VERDICTS, "not-permitted", "queued behind maxPerSweep"]
    .filter((reason) => counts.has(reason))
    .map((reason) => `${reason} ${counts.get(reason)}`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return {
    remedy: "reaper",
    outcome: "skipped",
    detail: `Left ${total} orphaned build daemon${total === 1 ? "" : "s"} alone: ${reasons.join(", ")}`,
    at,
  };
}

interface AgentBreach {
  agentId: string;
  workspaceId: string | undefined;
  isRunning: boolean;
  trigger: ResourceAlert["trigger"];
  memoryBytes: number;
  cpuPercent: number;
}

/**
 * Daemon-side monitor for agent process-tree memory/CPU and machine-level swap pressure and
 * orphaned build daemons. Mirrors AgentTokenBurnMonitor's shape: unref'd 60s timer, a fresh
 * config read each tick (live-toggleable, see daemon-config-store.ts's resourceMonitor
 * treatment), no persisted state of its own. Unlike token burn, its signal comes from an
 * OS-level `ps`/memory sample (process-sampler.ts) attributed to agents by command-line marker
 * (process-attribution.ts), not from anything the provider SDKs report. See
 * docs/resource-monitor.md.
 */
export class AgentResourceMonitor {
  private readonly agentManager: AgentResourceMonitorOptions["agentManager"];
  private readonly agentStorage: Pick<AgentStorage, "get" | "list">;
  private readonly pushNotificationSender: PushNotificationSender;
  private readonly remediationSink: RemediationSink;
  private readonly serverId: string;
  private readonly processSampler: ResourceMonitorSampler;
  private readonly saturationLedger: SaturationLedger | undefined;
  private readonly sendSystemMessageToAgent: AgentResourceMonitorOptions["sendSystemMessageToAgent"];
  private readonly readDaemonConfig: () => { resourceMonitor?: ResourceMonitorConfig };
  private readonly logger: AgentResourceMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly processSignaller: ProcessSignaller;
  private readonly ownerUid: number | undefined;
  private readonly worktreeRootDirs: readonly string[];
  private readonly cwdResolver: BuildDaemonCwdResolver;
  private readonly connectionChecker: BuildDaemonConnectionChecker;
  private readonly homeDir: string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reportDeviceSample: AgentResourceMonitorOptions["reportDeviceSample"];
  private readonly sweepTestArtifacts: AgentResourceMonitorOptions["sweepTestArtifacts"];
  private readonly holdChildAdmission: AgentResourceMonitorOptions["holdChildAdmission"];
  private readonly lowerProcessPriority: (pid: number, nice: number) => LowerPriorityResult;
  private readonly readAgentSideProcesses: () => ReadonlyMap<string, readonly number[]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Machine-level legs have no agent to attach state to, so this monitor instance — a
   * bootstrap-time singleton — owns it directly instead of round-tripping through AgentManager. */
  private machineState: MachineResourceMonitorState | undefined;
  /** Previous sweep's cumulative CPU per pid, so this sweep can report a rate (process-cpu-rate.ts). */
  private cpuRateMemory: CpuRateMemory | undefined;
  /** How long each reap candidate has been idle, accumulated across sweeps (build-daemon-reaper.ts). */
  private reapMemory: BuildDaemonReaperMemory | undefined;
  /** The last verdict set logged for the reaper, so the log line appears on change and not every minute. */
  private lastReaperWatch = "";
  /**
   * What this monitor's remedies did while each machine-level condition has been active, oldest
   * first; null while it is not. The ladder is idempotent per key, so the list is the monitor's
   * to keep and it hands the whole thing over on every sweep.
   */
  private orphanEpisode: RemedyAttempt[] | null = null;
  private systemMemoryEpisode: RemedyAttempt[] | null = null;
  private saturationEpisode: RemedyAttempt[] | null = null;
  /** Which conditions hold child admission now; holdChildAdmission hears their union. */
  private cpuHoldsAdmission = false;
  private memoryHoldsAdmission = false;
  /** Why each condition holding admission holds it, in the order they started. */
  private readonly admissionHoldReasons = new Map<"cpu" | "memory", string>();
  /** The memory brake's state between sweeps (agent/memory-brake.ts). */
  private memoryBrake: MemoryBrakeState | undefined;
  /** Whether this critical-pressure spell has been pushed. */
  private memoryCriticalAlerted = false;
  /** Whether this memory hold has been pushed for lasting MEMORY_HOLD_NOTICE_MS. */
  private memoryHoldNoticed = false;
  /** The last process sample that worked. A failed sample reuses it for evidence, never to act. */
  private lastProcessSample: AttributedProcessSample | undefined;
  private saturationState: SaturationState | undefined;
  private saturationSweep: SaturationSweep | undefined;
  /** When the ledger last got a record for the open incident. */
  private lastSaturationRecordAtMs = 0;
  private sweepInFlight = false;
  private readonly modeLog: MonitorModeLog;

  constructor(options: AgentResourceMonitorOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.pushNotificationSender = options.pushNotificationSender;
    this.remediationSink = options.remediationSink ?? NULL_REMEDIATION_SINK;
    this.serverId = options.serverId;
    this.processSampler = options.processSampler;
    this.saturationLedger = options.saturationLedger;
    this.sendSystemMessageToAgent = options.sendSystemMessageToAgent;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.processSignaller = options.processSignaller ?? createSystemProcessSignaller();
    this.ownerUid = "ownerUid" in options ? options.ownerUid : process.getuid?.();
    this.worktreeRootDirs = options.worktreeRootDirs ?? [];
    this.cwdResolver = options.cwdResolver ?? createSystemBuildDaemonCwdResolver();
    this.connectionChecker =
      options.connectionChecker ?? createSystemBuildDaemonConnectionChecker();
    this.homeDir = options.homeDir;
    this.sleep = options.sleep ?? defaultSleep;
    this.reportDeviceSample = options.reportDeviceSample;
    this.modeLog = new MonitorModeLog(options.logger);
    this.sweepTestArtifacts = options.sweepTestArtifacts;
    this.holdChildAdmission = options.holdChildAdmission;
    this.lowerProcessPriority =
      options.lowerProcessPriority ?? ((pid, nice) => lowerProcessPriorityDefault(pid, nice));
    this.readAgentSideProcesses = options.readAgentSideProcesses ?? (() => new Map());
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.reportMode();
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Resource monitor sweep failed");
      });
    }, this.sweepIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Nothing will be watching load or memory to release it later. A restart starts the brake
    // over, so a condition still present holds again on its first sweep.
    this.releaseAdmission("resource monitor stopped");
    this.memoryBrake = undefined;
    this.memoryCriticalAlerted = false;
    this.memoryHoldNoticed = false;
  }

  async tick(): Promise<void> {
    // On the kind of machine this monitor exists for, a sample can outlive the interval;
    // overlapping sweeps would stack `ps` processes onto the load being measured.
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      await this.sweep();
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** This sweep's saturation state and evidence; undefined while the machine is not saturated. */
  getSaturationSweep(): SaturationSweep | undefined {
    return this.saturationSweep;
  }

  /** Logs the mode this monitor reads from its config, once per change (monitor-mode-log.ts). */
  reportMode(): void {
    const rawConfig = this.readDaemonConfig().resourceMonitor;
    const enabled = rawConfig?.enabled !== false;
    const reaper = resolveReaperConfig(rawConfig?.reaper);
    this.modeLog.report([
      { monitor: "resource-monitor", enabled },
      { monitor: "reaper", enabled: enabled && reaper.enabled, dryRun: reaper.dryRun },
    ]);
  }

  private async sweep(): Promise<void> {
    this.reportMode();
    const rawConfig = this.readDaemonConfig().resourceMonitor;
    if (rawConfig?.enabled === false) {
      await this.closeMachineEpisodes();
      this.saturationState = undefined;
      this.saturationSweep = undefined;
      return;
    }
    const config = resolveConfig(rawConfig);
    const nowMs = this.now();

    // Machine-level legs (swap, orphan build daemons) matter even with zero live agents — an
    // idle daemon can still be sitting on 6 abandoned Gradle daemons — so this never
    // short-circuits on an empty agent list the way the token-burn monitor does.
    const agents = this.agentManager
      .listAgentsForResourceMonitor()
      .filter((agent) => !agent.internal);
    const childAgentIds = new Set(
      agents.filter((agent) => agent.parentAgentId !== null).map((agent) => agent.id),
    );
    const [table, systemMemory] = await Promise.all([
      this.processSampler.sampleProcessTable(),
      this.processSampler.sampleSystemMemory(),
    ]);
    // Load and free memory come from `os` and cannot fail the way `ps` can, so the load and
    // memory legs run every sweep whatever happened to the process sample.
    const systemLoad = this.processSampler.sampleSystemLoad();

    if (table.status === "failed") {
      await this.sweepWithoutProcessSample({ agents, systemMemory, systemLoad, config, nowMs });
      return;
    }

    const cpu = withRecentCpuPercent(table.rows, this.cpuRateMemory, nowMs);
    this.cpuRateMemory = cpu.memory;
    const attribution = attributeProcessTrees(
      cpu.rows,
      agents.map((agent) => agent.id),
      { extraRoots: this.readAgentSideProcesses() },
    );
    const sample: AttributedProcessSample = {
      rows: cpu.rows,
      agentTrees: attribution.agentTrees,
      orphanBuildDaemons: attribution.orphanBuildDaemons,
      takenAtMs: nowMs,
    };
    this.lastProcessSample = sample;

    const agentBreaches = this.evaluateAgentBreaches(agents, attribution.agentTrees, config, nowMs);
    this.advanceMachineState(systemMemory, attribution.orphanBuildDaemons, config);

    await this.reportDevices(cpu.rows, attribution.agentTrees, systemMemory);

    await this.sendAgentBreaches(agentBreaches, config);
    // Runs on its own criteria, not off the orphan condition's threshold: an abandoned daemon
    // sitting on 800 MB is worth reclaiming even though the condition only opens at 2 GiB.
    const reaperPass = await this.reapAbandonedBuildDaemons(
      cpu.rows,
      attribution.agentTrees,
      config.reaper,
      nowMs,
    );
    const janitorAttempts = await this.reclaimTestArtifacts(cpu.rows, nowMs);
    const brakeAttempts = await this.applyMemoryBrake(systemMemory, nowMs);

    // Last, so a reap or a reclaim in this very sweep is in what the ladder is told.
    await this.observeOrphanBuildDaemons({
      orphans: attribution.orphanBuildDaemons,
      rows: cpu.rows,
      config,
      reaperPass,
      nowMs,
    });
    await this.observeSystemMemory({
      systemMemory,
      sample,
      config,
      reaperPass,
      janitorAttempts: [...janitorAttempts, ...brakeAttempts],
      nowMs,
    });
    await this.observeSaturation({
      systemLoad,
      systemMemory,
      sample,
      fresh: true,
      childAgentIds,
      reaperPass,
      config,
      nowMs,
    });
  }

  /**
   * A sweep whose process sample failed, which on an overloaded machine is exactly when the
   * monitor matters. Load, swap and saturation carry on, with the last good sample standing in
   * for attribution in evidence, marked with its age. Nothing that acts on idle or absence runs
   * off stale rows: the reaper, the artifact janitor and the device cap all skip this sweep, and
   * the per-agent and orphan-daemon legs hold where they were, because "no tree found" would
   * otherwise read as "under threshold" and re-arm them.
   */
  private async sweepWithoutProcessSample(input: {
    agents: readonly ResourceMonitorAgentSummary[];
    systemMemory: SystemMemorySample | undefined;
    systemLoad: SystemLoadSample;
    config: ResolvedResourceMonitorConfig;
    nowMs: number;
  }): Promise<void> {
    const { systemMemory, config, nowMs } = input;
    const sample = this.lastProcessSample;
    this.advanceMachineState(
      systemMemory,
      sample?.orphanBuildDaemons ?? { count: 0, rssBytes: 0, pids: [] },
      config,
    );
    this.breakReaperIdleEvidence();
    // Memory comes from sysctl, not ps, so the brake runs whatever happened to the process sample.
    const brakeAttempts = await this.applyMemoryBrake(systemMemory, nowMs);
    await this.observeSystemMemory({
      systemMemory,
      sample,
      config,
      reaperPass: NO_REAPER_PASS,
      janitorAttempts: brakeAttempts,
      nowMs,
    });
    await this.observeSaturation({
      systemLoad: input.systemLoad,
      systemMemory,
      sample,
      fresh: false,
      childAgentIds: new Set(),
      reaperPass: NO_REAPER_PASS,
      config,
      nowMs,
    });
  }

  /**
   * A daemon's idle clock counts wall time between sweeps that saw it idle. Across a sweep that
   * could not look, it might have been building, so the run of idle sweeps starts over — the
   * same rule a busy sweep follows. What the reaper already did to a pid is kept.
   */
  private breakReaperIdleEvidence(): void {
    if (!this.reapMemory) return;
    for (const [pid, state] of this.reapMemory) {
      this.reapMemory.set(pid, { ...state, idleSinceMs: undefined, idleSweeps: 0 });
    }
  }

  /**
   * Machine CPU saturation: detection and evidence. Every sweep of an open incident is exposed
   * through getSaturationSweep; the ledger gets its open, a record every five minutes while it
   * holds, and its clear.
   */
  private async observeSaturation(input: {
    systemLoad: SystemLoadSample;
    systemMemory: SystemMemorySample | undefined;
    sample: AttributedProcessSample | undefined;
    fresh: boolean;
    /** Agents with a parent: the only trees the rung may lower. */
    childAgentIds: ReadonlySet<string>;
    reaperPass: ReaperPass;
    config: ResolvedResourceMonitorConfig;
    nowMs: number;
  }): Promise<void> {
    const { config, nowMs } = input;
    if (!config.saturation.enabled) {
      this.setAdmissionHold("cpu", false, "cpu-saturation: saturation monitoring turned off");
    }
    const saturation: SaturationConfig = config.saturation.enabled
      ? config.saturation
      : // Turned off mid-incident: treat every sweep as under threshold, so the incident closes
        // on the normal schedule and the ledger gets its clear.
        { ...config.saturation, loadPerCore: Number.POSITIVE_INFINITY, busyFraction: 2 };
    const result = evaluateSaturation({
      load: input.systemLoad.load,
      config: saturation,
      previousState: this.saturationState,
      nowMs,
    });
    this.saturationState = result.nextState;
    if (result.transition === "quiet" || !result.episode) {
      this.saturationSweep = undefined;
      return;
    }

    const evidence = buildSaturationEvidence({
      load: input.systemLoad.load,
      sample: input.sample,
      fresh: input.fresh,
      nowMs,
      agentLabels: await this.labelAgents(input.sample),
    });
    const sweep: SaturationSweep = {
      atMs: nowMs,
      transition: result.transition,
      episode: result.episode,
      systemLoad: input.systemLoad,
      systemMemory: input.systemMemory,
      evidence,
      processSample: input.sample,
    };
    this.saturationSweep = result.transition === "cleared" ? undefined : sweep;
    const actions = this.remedySaturation({
      sweep,
      childAgentIds: input.childAgentIds,
      config: config.saturation,
    });
    await this.recordSaturation(sweep, actions);
    await this.observeCpuSaturation({
      sweep,
      actions: [...input.reaperPass.attempts, ...actions],
      spared: input.reaperPass.spared,
      config,
    });
  }

  /**
   * Rung 1 for saturation, besides the reaper, which already ran this sweep on its own criteria:
   * hold child admission while load is high, and lower the heaviest child agent trees further.
   * Returns what it did, for the ladder and the ledger.
   */
  private remedySaturation(input: {
    sweep: SaturationSweep;
    childAgentIds: ReadonlySet<string>;
    config: ResolvedSaturationConfig;
  }): RemedyAttempt[] {
    const { sweep, config } = input;
    const at = new Date(sweep.atMs).toISOString();
    const load = sweep.systemLoad.load;
    const attempts: RemedyAttempt[] = [];
    const hold = (held: boolean, detail: string): void => {
      const said =
        !held && this.memoryHoldsAdmission ? `${detail}; memory pressure still holds it` : detail;
      if (this.setAdmissionHold("cpu", held, `cpu-saturation: ${said}`)) {
        attempts.push({ remedy: "admission-hold", outcome: "acted", detail: said, at });
      }
    };

    if (sweep.transition === "cleared") {
      hold(false, `Released child admission: saturation cleared, ${describeLoad(load)}`);
      return attempts;
    }
    // Hysteresis: held at the threshold, released only under the lower release line. No reading
    // (Windows' first sweep) changes nothing.
    if (load && isSaturated(load, config)) {
      hold(true, `Held new child-agent turns: ${describeLoad(load)}`);
    } else if (load && isBelowRelease(load, config)) {
      hold(false, `Released child admission: ${describeLoad(load)}`);
    }

    // Lowering acts on the processes it names, so only on this sweep's own sample, and only
    // when CPU is the cause: a lower priority does nothing for tasks waiting on disk.
    if (sweep.evidence.sample.status === "fresh" && sweep.evidence.cause.kind === "cpu") {
      attempts.push(...this.lowerHeaviestChildTrees(sweep, input.childAgentIds, config, at));
    }
    return attempts;
  }

  /**
   * Re-applied every saturated sweep, so a pid that joined one of these trees since the last
   * sweep is lowered too. lowerProcessPriority never raises and skips a pid already there, so a
   * tree's second pass reports only its new pids. Permanent on macOS and Linux: only root can
   * raise a priority back, so these processes stay lowered for their lifetime.
   */
  private lowerHeaviestChildTrees(
    sweep: SaturationSweep,
    childAgentIds: ReadonlySet<string>,
    config: ResolvedSaturationConfig,
    at: string,
  ): RemedyAttempt[] {
    const trees = (sweep.processSample?.agentTrees ?? [])
      .filter(
        (tree) =>
          childAgentIds.has(tree.agentId) &&
          tree.cpuPercent >= SATURATION_RENICE_MIN_TREE_CPU_PERCENT,
      )
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, config.reniceTopTrees);
    const attempts: RemedyAttempt[] = [];
    for (const tree of trees) {
      let lowered = 0;
      let failed = 0;
      for (const pid of tree.pids) {
        // Never the daemon, however the tree was attributed.
        if (pid <= 1 || pid === process.pid) continue;
        const result = this.lowerProcessPriority(pid, config.reniceNice);
        if (result === "lowered") lowered += 1;
        else if (result === "failed") failed += 1;
      }
      if (lowered === 0) continue;
      const label =
        sweep.evidence.agentTrees.find((evidence) => evidence.agentId === tree.agentId)?.title ??
        tree.agentId;
      const detail =
        `Lowered ${lowered} process${lowered === 1 ? "" : "es"} of ${label} ` +
        `(${Math.round(tree.cpuPercent)}% CPU) to nice ${config.reniceNice}` +
        (failed > 0 ? `; ${failed} could not be lowered` : "");
      this.logger.info(
        { agentId: tree.agentId, lowered, failed, nice: config.reniceNice },
        "Saturation: lowered a child agent tree's priority",
      );
      attempts.push({ remedy: "renice", outcome: "acted", detail, at });
    }
    return attempts;
  }

  /**
   * Sets one condition's hold. Returns whether that condition's hold changed; holdChildAdmission
   * hears changes to the union, so a release while the other condition holds releases nothing.
   */
  private setAdmissionHold(source: "cpu" | "memory", held: boolean, reason: string): boolean {
    if (!this.holdChildAdmission) return false;
    const current = source === "cpu" ? this.cpuHoldsAdmission : this.memoryHoldsAdmission;
    if (current === held) return false;
    const wasHeld = this.cpuHoldsAdmission || this.memoryHoldsAdmission;
    if (source === "cpu") this.cpuHoldsAdmission = held;
    else this.memoryHoldsAdmission = held;
    if (held) this.admissionHoldReasons.set(source, reason);
    else this.admissionHoldReasons.delete(source);
    this.applyAdmissionHold(wasHeld, reason, source);
    return true;
  }

  private releaseAdmission(reason: string): void {
    const wasHeld = this.cpuHoldsAdmission || this.memoryHoldsAdmission;
    this.cpuHoldsAdmission = false;
    this.memoryHoldsAdmission = false;
    this.admissionHoldReasons.clear();
    this.applyAdmissionHold(wasHeld, reason);
  }

  private applyAdmissionHold(wasHeld: boolean, reason: string, source?: "cpu" | "memory"): void {
    const held = this.cpuHoldsAdmission || this.memoryHoldsAdmission;
    if (held === wasHeld) {
      if (held) {
        this.logger.info(
          { source, reason, cpu: this.cpuHoldsAdmission, memory: this.memoryHoldsAdmission },
          "Child admission stays held",
        );
        // What holds it changed, so admission hears the conditions that hold it now: bootstrap
        // wires both to one source, and its queue lines would otherwise name the first one.
        this.callHoldChildAdmission(true, [...this.admissionHoldReasons.values()].join("; "));
      }
      return;
    }
    this.logger.info(
      { held, reason, cpu: this.cpuHoldsAdmission, memory: this.memoryHoldsAdmission },
      held ? "Holding child admission" : "Releasing child admission",
    );
    this.callHoldChildAdmission(held, reason);
  }

  private callHoldChildAdmission(held: boolean, reason: string): void {
    try {
      this.holdChildAdmission?.(held, reason);
    } catch (error) {
      this.logger.warn({ err: error, held }, "Failed to change child admission");
    }
  }

  /**
   * The memory brake: holds child admission on macOS memory pressure or fast swap growth, and
   * pushes an alert the moment pressure turns critical. It only ever holds new child turns: no
   * running process is signalled, stopped or lowered, since a stopped tree frees no memory and a
   * Bash timeout's SIGTERM waits on it, which can hang the turn. Returns what it did, for the
   * system-memory episode.
   */
  private async applyMemoryBrake(
    systemMemory: SystemMemorySample | undefined,
    nowMs: number,
  ): Promise<RemedyAttempt[]> {
    const result = evaluateMemoryBrake(systemMemory, this.memoryBrake, nowMs);
    this.memoryBrake = result.next;
    const attempts: RemedyAttempt[] = [];
    if (result.transition !== "none") {
      const held = result.transition === "held";
      const detail = held
        ? `Held new child-agent turns: ${result.detail}`
        : `Released child admission: ${result.detail}` +
          (this.cpuHoldsAdmission ? "; CPU saturation still holds it" : "");
      if (this.setAdmissionHold("memory", held, `memory-pressure: ${detail}`)) {
        attempts.push({
          remedy: "admission-hold",
          outcome: "acted",
          detail,
          at: new Date(nowMs).toISOString(),
        });
      }
    }
    if (systemMemory?.memoryPressureLevel !== undefined && !result.critical) {
      this.memoryCriticalAlerted = false;
    }
    if (result.critical && systemMemory && !this.memoryCriticalAlerted) {
      this.memoryCriticalAlerted = true;
      this.logger.warn(
        { memoryPressureLevel: systemMemory.memoryPressureLevel },
        "Memory pressure is critical",
      );
      await this.sendPush(buildMemoryPressureCriticalPayload(this.serverId, systemMemory), {
        level: "alert",
        dedupeKey: MEMORY_PRESSURE_CRITICAL_DEDUPE_KEY,
      });
    }
    attempts.push(...(await this.handleLongMemoryHold(result, systemMemory, nowMs)));
    return attempts;
  }

  /**
   * A memory hold that goes on: warn from a full compressor can last hours with little swap, and
   * then nothing else says children are stalled. Pushes once when it has held
   * MEMORY_HOLD_NOTICE_MS with a child waiting, and once it has been settled for
   * MEMORY_HOLD_TRICKLE_AFTER_MS lets one queued child through per sweep, unless CPU saturation
   * holds admission too.
   */
  private async handleLongMemoryHold(
    result: ReturnType<typeof evaluateMemoryBrake>,
    systemMemory: SystemMemorySample | undefined,
    nowMs: number,
  ): Promise<RemedyAttempt[]> {
    if (!this.memoryHoldsAdmission) {
      this.memoryHoldNoticed = false;
      return [];
    }
    const admission = this.agentManager.getChildAdmission();
    const waiting = admission?.queueLength();
    if (!this.memoryHoldNoticed && result.heldForMs >= MEMORY_HOLD_NOTICE_MS && waiting !== 0) {
      this.memoryHoldNoticed = true;
      this.logger.warn(
        {
          heldForMs: result.heldForMs,
          waiting,
          memoryPressureLevel: systemMemory?.memoryPressureLevel,
        },
        "Memory hold has lasted with children waiting",
      );
      await this.sendPush(
        buildMemoryHoldNoticePayload({
          serverId: this.serverId,
          systemMemory,
          heldForMs: result.heldForMs,
          waiting,
        }),
        { level: "notice", dedupeKey: MEMORY_HOLD_NOTICE_DEDUPE_KEY },
      );
    }
    if (!result.trickle || this.cpuHoldsAdmission || !admission) return [];
    const minutes = Math.round(result.heldForMs / 60_000);
    const agentId = admission.admitNextWhileHeld(
      `trickle: memory held ${minutes} min with swap not growing`,
    );
    if (!agentId) return [];
    return [
      {
        remedy: "admission-hold",
        outcome: "acted",
        detail:
          `Let one queued child turn through (${agentId}): memory has held admission for ` +
          `${minutes} min without turning critical or swap growing`,
        at: new Date(nowMs).toISOString(),
      },
    ];
  }

  /**
   * Reports saturation to the ladder. The response follows the cause: agent trees are what the
   * remedies act on, the person's own processes and I/O are known and no agent may help, and
   * only a load nothing can attribute asks for an agent.
   */
  private async observeCpuSaturation(input: {
    sweep: SaturationSweep;
    /** This sweep's reaper pass and rung-1 actions. */
    actions: readonly RemedyAttempt[];
    spared: RemedyAttempt | undefined;
    config: ResolvedResourceMonitorConfig;
  }): Promise<void> {
    const { sweep, config } = input;
    const remedy = this.saturationRemedyState(config);
    const base = {
      key: CPU_SATURATION_KEY,
      kind: "cpu-saturation" as const,
      remedy,
      title: "The machine's CPU is saturated",
    };
    if (sweep.transition === "cleared") {
      const attempts = this.appendEpisodeAttempts(this.saturationEpisode, input.actions);
      this.saturationEpisode = null;
      await this.observe({
        ...base,
        active: false,
        summary: `CPU saturation cleared; the peak was load ${sweep.episode.peakLoad1.toFixed(1)}.`,
        attempts,
      });
      return;
    }

    this.saturationEpisode = this.appendEpisodeAttempts(this.saturationEpisode, input.actions);
    const attribution = attributeSaturation(sweep.evidence);
    const minutes = Math.round((sweep.atMs - sweep.episode.openedAtMs) / 60_000);
    const since = `${describeLoad(sweep.systemLoad.load)}, saturated for ${minutes} min`;
    const summaries: Record<SaturationAttribution, string> = {
      agents:
        `${since}. Agent builds are most of it; new child-agent turns are held and the heaviest ` +
        "child trees are running at lower priority.",
      "other-processes":
        `${since}. Most of it is processes outside any agent (see the evidence), which the ` +
        "daemon leaves alone.",
      io: `${since}. It is mostly tasks waiting on disk; it passes when that work finishes.`,
      unattributed: `${since}. Process sampling is failing, so the cause is unknown.`,
    };
    await this.observe({
      ...base,
      active: true,
      summary: summaries[attribution],
      evidence: formatSaturationEvidence(sweep.systemLoad.load, sweep.evidence),
      attempts: [...this.saturationEpisode, ...(input.spared ? [input.spared] : [])],
      ...(attribution === "unattributed"
        ? {
            graceMs: config.saturation.unattributedGraceMs,
            level: "alert" as const,
            escalation: { task: CPU_SATURATION_TASK, taskClass: "standard" as const },
          }
        : { graceMs: config.saturation.attributedGraceMs, level: "notice" as const }),
    });
  }

  private saturationRemedyState(config: ResolvedResourceMonitorConfig): RemedyState {
    const canAct =
      this.holdChildAdmission !== undefined ||
      config.saturation.reniceTopTrees > 0 ||
      reaperRemedyState(config.reaper) === "live";
    return canAct ? "live" : "none";
  }

  private async recordSaturation(
    sweep: SaturationSweep,
    actions: readonly RemedyAttempt[],
  ): Promise<void> {
    let event: SaturationLedgerEvent | undefined;
    if (sweep.transition === "opened") event = "open";
    else if (sweep.transition === "cleared") event = "clear";
    else if (
      actions.length > 0 ||
      sweep.atMs - this.lastSaturationRecordAtMs >= SATURATION_LEDGER_INTERVAL_MS
    ) {
      // A sweep that acted gets a record of its own, so the ledger says what the daemon did.
      event = "ongoing";
    }
    if (!event) return;
    this.lastSaturationRecordAtMs = sweep.atMs;
    if (event === "open") {
      this.logger.warn(
        { load: sweep.systemLoad.load, cause: sweep.evidence.cause.kind },
        "Machine CPU saturated",
      );
    } else if (event === "clear") {
      this.logger.info(
        { openedAtMs: sweep.episode.openedAtMs, peakLoad1: sweep.episode.peakLoad1 },
        "Machine CPU saturation cleared",
      );
    }
    await this.saturationLedger?.append(
      buildSaturationLedgerRecord({
        event,
        atMs: sweep.atMs,
        openedAtMs: sweep.episode.openedAtMs,
        peakLoad1: sweep.episode.peakLoad1,
        systemLoad: sweep.systemLoad,
        systemMemory: sweep.systemMemory,
        evidence: sweep.evidence,
        actions,
      }),
    );
  }

  /** Titles and working directories for the heaviest agent trees in a sample. */
  private async labelAgents(
    sample: EvidenceProcessSample | undefined,
  ): Promise<Map<string, AgentLabel>> {
    const labels = new Map<string, AgentLabel>();
    const heaviest = [...(sample?.agentTrees ?? [])]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 5);
    for (const tree of heaviest) {
      const record = await this.agentStorage.get(tree.agentId).catch(() => null);
      labels.set(tree.agentId, { title: record?.title ?? null, cwd: record?.cwd ?? null });
    }
    return labels;
  }

  /**
   * Never lets the janitor's bookkeeping break a sweep, for the same reason the device cap
   * cannot: this monitor's own legs have already run by here, and a failed disk scan must not
   * cost the next one. Returns what it reclaimed as attempts, for the conditions it helps.
   */
  private async reclaimTestArtifacts(
    rows: readonly ProcessSampleRow[],
    nowMs: number,
  ): Promise<RemedyAttempt[]> {
    if (!this.sweepTestArtifacts) return [];
    let result: TestArtifactSweepResult;
    try {
      result = await this.sweepTestArtifacts({ rows });
    } catch (error) {
      this.logger.warn({ err: error }, "Artifact janitor sweep failed");
      return [];
    }
    if (result.reclaimed.length === 0) return [];
    await this.sendPush(
      buildArtifactJanitorNotificationPayload({
        serverId: this.serverId,
        dryRun: result.dryRun,
        artifacts: result.reclaimed.map((artifact) => ({
          label: artifact.label,
          name: artifact.name,
          path: artifact.path,
          sizeBytes: artifact.sizeBytes,
          ageMs: artifact.ageMs,
          claim: artifact.claim,
        })),
      }),
      { level: "record" },
    );
    const at = new Date(nowMs).toISOString();
    return result.reclaimed.map((artifact) => ({
      remedy: "artifact-janitor",
      outcome: result.dryRun ? "skipped" : "acted",
      detail:
        `${result.dryRun ? "Dry run, would have reclaimed" : "Reclaimed"} ${artifact.label} ` +
        `${artifact.name} (${formatBytes(artifact.sizeBytes)})`,
      at,
    }));
  }

  /** Never lets the cap's bookkeeping break a sweep: this monitor's own legs come first. */
  private async reportDevices(
    rows: readonly ProcessSampleRow[],
    agentTrees: readonly AgentProcessTree[],
    systemMemory: SystemMemorySample | undefined,
  ): Promise<void> {
    if (!this.reportDeviceSample) return;
    try {
      await this.reportDeviceSample({
        devices: detectRunningDevices({ rows, agentTrees }),
        systemMemory,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to report running devices to the device cap");
    }
  }

  private evaluateAgentBreaches(
    agents: readonly ResourceMonitorAgentSummary[],
    trees: readonly AgentProcessTree[],
    config: ResolvedResourceMonitorConfig,
    nowMs: number,
  ): AgentBreach[] {
    const treeByAgentId = new Map(trees.map((tree) => [tree.agentId, tree] as const));
    const breaches: AgentBreach[] = [];

    for (const agent of agents) {
      const tree = treeByAgentId.get(agent.id);
      const previousState = this.agentManager.getResourceMonitorState(agent.id);
      const result = evaluateAgentResourceBreach({
        rssBytes: tree?.rssBytes,
        cpuPercent: tree?.cpuPercent,
        config,
        previousState,
      });
      this.agentManager.setResourceMonitorState(agent.id, result.nextState);

      if (result.rearmed) {
        this.agentManager.clearResourceAlert(agent.id);
      }
      if (result.triggers.length === 0) {
        continue;
      }

      const alert: ResourceAlert = {
        trigger: result.triggers[0] as ResourceAlert["trigger"],
        memoryBytes: tree?.rssBytes ?? 0,
        cpuPercent: tree?.cpuPercent ?? 0,
        firstBreachedAt: new Date(nowMs).toISOString(),
      };
      this.agentManager.setResourceAlert(agent.id, alert);
      breaches.push({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        isRunning: agent.isRunning,
        trigger: alert.trigger,
        memoryBytes: alert.memoryBytes,
        cpuPercent: alert.cpuPercent,
      });
    }

    return breaches;
  }

  /**
   * Only the swap leg is read back from the detector: its sustained fire-and-re-arm shape is
   * what keeps a ratio hovering at the threshold from opening and closing an episode every
   * sweep. The orphan condition is a raw comparison, because the ladder's grace window is the
   * persistence it needs.
   */
  private advanceMachineState(
    systemMemory: SystemMemorySample | undefined,
    orphanBuildDaemons: OrphanBuildDaemonSummary,
    config: ResolvedResourceMonitorConfig,
  ): void {
    const result = evaluateMachineResourceBreach({
      swapUsedRatio: systemMemory ? computeSwapUsedRatio(systemMemory) : undefined,
      orphanBuildDaemonBytes: orphanBuildDaemons.rssBytes,
      config,
      previousState: this.machineState,
    });
    this.machineState = result.nextState;
  }

  private async sendAgentBreaches(
    breaches: AgentBreach[],
    config: ResolvedResourceMonitorConfig,
  ): Promise<void> {
    if (breaches.length === 0) {
      return;
    }

    // Steer first: whether the agent was told is what ranks the push. A running agent that was
    // told to trim its children has had the remedy applied, so the push is only a record of it.
    // An idle agent cannot be steered — the steer path would start a turn for it (agent-prompt.ts),
    // spending tokens on an agent nobody is driving, and an idle agent with a heavy leftover
    // child is the most likely breach shape — so it stays a notice: nothing has acted on it.
    const steered = new Set<string>();
    if (config.notifyAgent) {
      for (const breach of breaches) {
        if (!breach.isRunning) {
          continue;
        }
        const body = formatAgentResourceMessage({
          memoryBytes: breach.memoryBytes,
          cpuPercent: breach.cpuPercent,
          memoryBytesLimit: config.memoryBytesPerAgent,
          cpuPercentLimit: config.cpuPercentPerAgent,
        });
        try {
          await this.sendSystemMessageToAgent(breach.agentId, body);
          steered.add(breach.agentId);
        } catch (error) {
          this.logger.warn(
            { err: error, agentId: breach.agentId },
            "Failed to steer resource-monitor message into agent",
          );
        }
      }
    }

    if (breaches.length > DEFAULT_BREACH_BATCH_THRESHOLD) {
      await this.sendPush(
        buildBatchedResourceNotificationPayload({
          serverId: this.serverId,
          breaches: breaches.map((breach) => ({
            agentId: breach.agentId,
            workspaceId: breach.workspaceId,
          })),
        }),
        { level: breaches.every((breach) => steered.has(breach.agentId)) ? "record" : "notice" },
      );
      return;
    }

    for (const breach of breaches) {
      const record = await this.agentStorage.get(breach.agentId).catch(() => null);
      await this.sendPush(
        buildResourceAgentNotificationPayload({
          serverId: this.serverId,
          workspaceId: breach.workspaceId,
          agentId: breach.agentId,
          agentTitle: record?.title ?? null,
          trigger: breach.trigger,
          memoryBytes: breach.memoryBytes,
          cpuPercent: breach.cpuPercent,
          memoryBytesLimit: config.memoryBytesPerAgent,
          cpuPercentLimit: config.cpuPercentPerAgent,
        }),
        { level: steered.has(breach.agentId) ? "record" : "notice" },
      );
    }
  }

  /** Never throws: the sink's own contract, and a sweep must not depend on it anyway. */
  private async observe(observation: Parameters<RemediationSink["observe"]>[0]): Promise<void> {
    try {
      await this.remediationSink.observe(observation);
    } catch (error) {
      this.logger.warn(
        { err: error, key: observation.key },
        "Remediation sink rejected an observation",
      );
    }
  }

  private appendEpisodeAttempts(
    episode: RemedyAttempt[] | null,
    attempts: readonly RemedyAttempt[],
  ): RemedyAttempt[] {
    const next = [...(episode ?? []), ...attempts];
    return next.slice(-MAX_EPISODE_ATTEMPTS);
  }

  /**
   * Reports the orphan-build-daemon condition to the ladder. This monitor no longer pushes about
   * it: a live reaper is the remedy, and the ladder decides whether an agent, then a person, is
   * needed once the reaper has had its chance. Opens at the same 2 GiB the old push did.
   */
  private async observeOrphanBuildDaemons(input: {
    orphans: OrphanBuildDaemonSummary;
    rows: readonly ProcessSampleRow[];
    config: ResolvedResourceMonitorConfig;
    reaperPass: ReaperPass;
    nowMs: number;
  }): Promise<void> {
    const { orphans, config, reaperPass } = input;
    const remedy = reaperRemedyState(config.reaper);
    const active = orphans.count > 0 && orphans.rssBytes >= config.orphanBuildDaemonBytes;
    if (!active) {
      if (this.orphanEpisode) {
        const attempts = this.appendEpisodeAttempts(this.orphanEpisode, reaperPass.attempts);
        this.orphanEpisode = null;
        await this.observe({
          ...this.orphanObservationBase(remedy, orphans),
          active: false,
          attempts,
        });
      }
      return;
    }

    this.orphanEpisode = this.appendEpisodeAttempts(this.orphanEpisode, reaperPass.attempts);
    const rowsByPid = new Map(input.rows.map((row) => [row.pid, row] as const));
    const daemonLines = orphans.pids.map((pid) => {
      const row = rowsByPid.get(pid);
      return row
        ? `- pid ${pid} (${describeProcess(row.command)}): ${formatBytes(row.rssKb * 1024)}, ` +
            `${Math.round(row.cpuPercent)}% CPU`
        : `- pid ${pid}`;
    });
    await this.observe({
      ...this.orphanObservationBase(remedy, orphans),
      active: true,
      evidence:
        `${orphans.count} orphaned build daemon${orphans.count === 1 ? "" : "s"} (their launcher ` +
        `is gone) hold ${formatBytes(orphans.rssBytes)}; the condition opens at ` +
        `${formatBytes(config.orphanBuildDaemonBytes)}.\n${daemonLines.join("\n")}\n` +
        `Reaper: ${remedy}, idle for ${config.reaper.idleMinutes} min across at least ` +
        `${config.reaper.minIdleSweeps} sweeps before it acts.`,
      attempts: [...this.orphanEpisode, ...(reaperPass.spared ? [reaperPass.spared] : [])],
      // The reaper needs the idle window to elapse plus the sweeps that observe it, then one
      // sweep to act. Past that it has had its chance.
      graceMs: config.reaper.idleMinutes * 60_000 + 2 * this.sweepIntervalMs,
      // A live reaper that could not clear it is worth interrupting for. With the reaper off or
      // in dry run nothing can act, so it stays the notice it always was.
      level: remedy === "live" ? "alert" : "notice",
      escalation: { task: ORPHAN_DAEMONS_TASK, taskClass: "mechanical" },
    });
  }

  private orphanObservationBase(remedy: RemedyState, orphans: OrphanBuildDaemonSummary) {
    return {
      key: ORPHAN_DAEMONS_KEY,
      kind: "orphan-build-daemons" as const,
      remedy,
      title: "Orphaned build daemons are holding memory",
      summary:
        `${orphans.count} orphaned build daemon${orphans.count === 1 ? "" : "s"} hold ` +
        `${formatBytes(orphans.rssBytes)}.` +
        describeOrphanRemedyState(remedy),
    };
  }

  /**
   * Reports swap pressure to the ladder. Its remedies are the two that already run inside this
   * sweep: the reaper (when it is live) and the artifact janitor. This monitor pushes nothing
   * about it any more.
   */
  private async observeSystemMemory(input: {
    systemMemory: SystemMemorySample | undefined;
    /** This sweep's sample, or the last good one when this sweep's failed. */
    sample: AttributedProcessSample | undefined;
    config: ResolvedResourceMonitorConfig;
    reaperPass: ReaperPass;
    janitorAttempts: readonly RemedyAttempt[];
    nowMs: number;
  }): Promise<void> {
    const { systemMemory, config, reaperPass } = input;
    const reaper = config.reaper;
    const live = reaper.enabled && !reaper.dryRun;
    const remedy: RemedyState = live ? "live" : "none";
    const active = this.machineState?.systemMemory.fired === true;
    const newAttempts = [...reaperPass.attempts, ...input.janitorAttempts];
    if (!active) {
      if (this.systemMemoryEpisode) {
        const attempts = this.appendEpisodeAttempts(this.systemMemoryEpisode, newAttempts);
        this.systemMemoryEpisode = null;
        await this.observe({
          ...this.systemMemoryObservationBase(remedy, systemMemory, config),
          active: false,
          attempts,
        });
      }
      return;
    }
    if (!systemMemory) {
      // Still over threshold as far as the detector knows, but there is nothing to describe.
      return;
    }

    this.systemMemoryEpisode = this.appendEpisodeAttempts(this.systemMemoryEpisode, newAttempts);
    const { sample } = input;
    const consumers = await this.describeMemoryConsumers(
      sample?.rows ?? [],
      sample?.agentTrees ?? [],
    );
    const sampleAgeMs = sample ? input.nowMs - sample.takenAtMs : undefined;
    const reaperLine = describeReaperLineForSystemMemory(reaper, reaperPass.candidateCount);
    let consumersHeading = "Biggest process trees by memory:";
    if (sampleAgeMs === undefined) {
      consumersHeading = "No process sample yet, so what holds the memory is unknown.";
    } else if (sampleAgeMs > 0) {
      consumersHeading =
        `Biggest process trees by memory, from a sample ${Math.round(sampleAgeMs / 1000)}s old ` +
        "(process sampling is failing):";
    }
    await this.observe({
      ...this.systemMemoryObservationBase(remedy, systemMemory, config),
      active: true,
      evidence:
        `Swap: ${formatBytes(systemMemory.swapUsedBytes)} of ${formatBytes(systemMemory.swapTotalBytes)} ` +
        `used, over the ${Math.round(config.systemSwapUsedRatio * 100)}% threshold.\n` +
        `${reaperLine}\n${consumersHeading}\n${formatMemoryConsumers(consumers)}`,
      attempts: this.systemMemoryEpisode,
      graceMs: SYSTEM_MEMORY_GRACE_MS,
      level: "alert",
      escalation: { task: SYSTEM_MEMORY_TASK, taskClass: "standard" },
    });
  }

  private systemMemoryObservationBase(
    remedy: RemedyState,
    systemMemory: SystemMemorySample | undefined,
    config: ResolvedResourceMonitorConfig,
  ) {
    const ratio = systemMemory ? computeSwapUsedRatio(systemMemory) : config.systemSwapUsedRatio;
    return {
      key: SYSTEM_MEMORY_KEY,
      kind: "system-memory" as const,
      remedy,
      title: "The machine is running out of memory",
      summary:
        `Swap is ${Math.round(ratio * 100)}% used` +
        (systemMemory
          ? ` (${formatBytes(systemMemory.swapUsedBytes)} of ${formatBytes(systemMemory.swapTotalBytes)}).`
          : "."),
    };
  }

  /** The largest process trees in the sample, labelled with their agent's title where there is one. */
  private async describeMemoryConsumers(
    rows: readonly ProcessSampleRow[],
    agentTrees: readonly AgentProcessTree[],
  ) {
    const largestAgents = [...agentTrees].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 8);
    const agentLabels = new Map<string, string>();
    for (const tree of largestAgents) {
      const record = await this.agentStorage.get(tree.agentId).catch(() => null);
      if (record?.title) agentLabels.set(tree.agentId, record.title);
    }
    return summarizeMemoryConsumers({ rows, agentTrees, agentLabels });
  }

  /** The monitor was switched off mid-condition: nothing is observing it any more. */
  private async closeMachineEpisodes(): Promise<void> {
    this.releaseAdmission("resource monitor turned off");
    this.memoryBrake = undefined;
    this.memoryCriticalAlerted = false;
    this.memoryHoldNoticed = false;
    if (this.saturationEpisode) {
      const attempts = this.saturationEpisode;
      this.saturationEpisode = null;
      await this.observe({
        key: CPU_SATURATION_KEY,
        kind: "cpu-saturation",
        remedy: "disabled",
        title: "The machine's CPU is saturated",
        summary: "The resource monitor was turned off, so saturation is no longer watched.",
        active: false,
        attempts,
      });
    }
    if (this.orphanEpisode) {
      const attempts = this.orphanEpisode;
      this.orphanEpisode = null;
      await this.observe({
        ...this.orphanObservationBase("disabled", { count: 0, rssBytes: 0, pids: [] }),
        active: false,
        attempts,
      });
    }
    if (this.systemMemoryEpisode) {
      const attempts = this.systemMemoryEpisode;
      this.systemMemoryEpisode = null;
      await this.observe({
        ...this.systemMemoryObservationBase("none", undefined, resolveConfig(undefined)),
        active: false,
        attempts,
      });
    }
  }

  private async reapAbandonedBuildDaemons(
    rows: readonly ProcessSampleRow[],
    agentTrees: readonly AgentProcessTree[],
    reaper: ResolvedReaperConfig,
    nowMs: number,
  ): Promise<ReaperPass> {
    if (!reaper.enabled) {
      // Turning the reaper on starts the evidence over. Sweeps observed while it was off were
      // never checked against the abandonment rules, and acting on them would skip the wait.
      this.reapMemory = undefined;
      this.lastReaperWatch = "";
      return NO_REAPER_PASS;
    }

    const attributedPids = new Set(agentTrees.flatMap((tree) => tree.pids));
    const pidsNeedingCwd = selectBuildDaemonPidsNeedingCwd(
      rows,
      attributedPids,
      this.ownerUid,
      this.reapMemory,
    );
    const pidsNeedingConnectionCheck = selectBuildDaemonPidsNeedingConnectionCheck(
      rows,
      attributedPids,
      this.ownerUid,
      this.reapMemory,
    );
    const [pidCwd, pidTcpConnected, agentRecords] = await Promise.all([
      this.cwdResolver.resolve(pidsNeedingCwd),
      this.connectionChecker.check(pidsNeedingConnectionCheck),
      this.agentStorage.list(),
    ]);
    const agentOwnedDirs = [...this.worktreeRootDirs, ...agentRecords.map((record) => record.cwd)];
    const { candidates, memory, sightings } = evaluateBuildDaemonReapCandidates({
      rows,
      attributedPids,
      ownerUid: this.ownerUid,
      config: reaper,
      agentOwnedDirs,
      pidCwd,
      pidTcpConnected,
      ...(this.homeDir !== undefined ? { homeDir: this.homeDir } : {}),
      previous: this.reapMemory,
      nowMs,
    });
    this.reapMemory = memory;
    this.reportReaperSightings(sightings);
    const at = new Date(nowMs).toISOString();
    const pass = (attempts: RemedyAttempt[]): ReaperPass => ({
      attempts,
      spared: summarizeSparedDaemons(sightings, memory, candidates.length, at),
      candidateCount: candidates.length,
    });
    if (candidates.length === 0) {
      return pass([]);
    }

    if (reaper.dryRun) {
      this.logger.info(
        { dryRun: true, daemons: candidates },
        "Resource monitor would reap orphaned build daemons",
      );
      // Reported once, not once a minute for as long as the daemon sits there.
      for (const candidate of candidates) {
        markBuildDaemonHandled(memory, candidate.pid, "reported");
      }
      await this.sendPush(
        buildResourceBuildDaemonReapNotificationPayload({
          serverId: this.serverId,
          dryRun: true,
          daemons: candidates.map(toReapedBuildDaemon),
        }),
        { level: "record" },
      );
      return pass(
        candidates.map((candidate) => ({
          remedy: "reaper",
          outcome: "skipped",
          detail: `Dry run, would have reaped ${describeReapedDaemon(toReapedBuildDaemon(candidate))}`,
          at,
        })),
      );
    }

    const reaped = await this.terminateBuildDaemons(candidates, reaper, memory);
    if (reaped.length === 0) {
      return pass([]);
    }
    await this.sendPush(
      buildResourceBuildDaemonReapNotificationPayload({
        serverId: this.serverId,
        dryRun: false,
        daemons: reaped,
      }),
      { level: "record" },
    );
    return pass(
      reaped.map((daemon) => ({
        remedy: "reaper",
        outcome: "acted",
        detail: `Stopped ${describeReapedDaemon(daemon)}`,
        at,
      })),
    );
  }

  /**
   * Says what the reaper is looking at and why it is sparing each daemon. Without it a dry run
   * that never selects anything is unfalsifiable: no candidate looks the same whether no orphan
   * daemon existed, the allowlist rejected a real one, or a busy build was correctly spared.
   * Logged when a pid's verdict changes, not on every sweep, so a daemon that stays busy for a
   * day costs one line.
   */
  private reportReaperSightings(sightings: readonly BuildDaemonSighting[]): void {
    const key = sightings
      .map((sighting) => `${sighting.pid}:${sighting.verdict}`)
      .sort()
      .join(",");
    if (key === this.lastReaperWatch) {
      return;
    }
    this.lastReaperWatch = key;
    this.logger.info(
      {
        daemons: sightings.map((sighting) => ({
          pid: sighting.pid,
          verdict: sighting.verdict,
          kind: sighting.kind,
          rssBytes: sighting.rssBytes,
          cpuPercent: Math.round(sighting.cpuPercent),
          idleSweeps: sighting.idleSweeps,
        })),
      },
      sightings.length === 0
        ? "Reaper: no orphaned build daemons in view"
        : "Reaper: orphaned build daemons in view",
    );
  }

  /**
   * SIGTERM everything selected, wait out one shared grace window, then SIGKILL whatever is
   * still there. Gradle and Kotlin daemons shut down cleanly on SIGTERM, so the escalation is
   * the exception; one window for the whole batch rather than one each keeps the sweep — which
   * cannot overlap the next tick — short.
   */
  private async terminateBuildDaemons(
    candidates: readonly BuildDaemonReapCandidate[],
    reaper: ResolvedReaperConfig,
    memory: BuildDaemonReaperMemory,
  ): Promise<ReapedBuildDaemon[]> {
    const terminated: BuildDaemonReapCandidate[] = [];
    for (const candidate of candidates) {
      const outcome = this.processSignaller.signal(candidate.pid, "SIGTERM");
      if (outcome === "not-permitted") {
        // Not ours to signal after all. Stop asking every 60 seconds.
        markBuildDaemonHandled(memory, candidate.pid, "not-permitted");
        this.logger.warn(
          { pid: candidate.pid, kind: candidate.kind },
          "Not permitted to reap orphaned build daemon; skipping it from now on",
        );
        continue;
      }
      if (outcome !== "sent") {
        // "gone" means it exited between the sample and the signal — nothing was reclaimed by
        // us, so it is not reported as a reap.
        continue;
      }
      // One decision per pid: a daemon slow to die is still in the next sample, and re-running
      // the whole sequence on it every sweep would double-report what was already reclaimed.
      markBuildDaemonHandled(memory, candidate.pid, "signalled");
      terminated.push(candidate);
    }
    if (terminated.length === 0) {
      return [];
    }

    await this.sleep(reaper.graceMs);

    const reaped: ReapedBuildDaemon[] = [];
    for (const candidate of terminated) {
      const escalated = this.processSignaller.isRunning(candidate.pid);
      if (escalated) {
        this.processSignaller.signal(candidate.pid, "SIGKILL");
      }
      this.logger.info(
        {
          pid: candidate.pid,
          kind: candidate.kind,
          rssBytes: candidate.rssBytes,
          idleMs: candidate.idleMs,
          idleSweeps: candidate.idleSweeps,
          escalated,
        },
        "Reaped orphaned build daemon",
      );
      reaped.push(toReapedBuildDaemon(candidate));
    }
    return reaped;
  }

  private async sendPush(
    payload: {
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
    meta: PushSendMeta,
  ): Promise<void> {
    try {
      await this.pushNotificationSender.send(payload, meta);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send resource-monitor push notification");
    }
  }
}
