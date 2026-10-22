/**
 * The native build gate (docs/resource-monitor.md, "The native build gate"): at most
 * `agents.buildGate.maxConcurrent` native builds at once across the machine, and none while free
 * disk is under the disk-low line (`agents.remediation.disk.lowFreeGB`). Built after 2026-10-08,
 * when an iOS build with UI tests and an Android Gradle build ran together for an hour, wrote over
 * 40 GB and took the machine down. One build writes 10 to 34 GB, so the 5 GB critical floor would
 * let one start that fills the disk.
 *
 * It follows the device cap's layers (docs/device-leases.md): the process scan is the count
 * (native-build-detection.ts), and the launch gate every provider already calls before a shell
 * command is the enforcement point. It wraps that gate as a decorator, like
 * test-artifact-launch-gate.ts, so it works with the device cap off and the providers keep taking
 * a plain `DeviceLaunchGate`. It runs first: a build it refuses never takes a device slot.
 *
 * The count comes from the resource monitor's attributed sample, handed over every sweep. A
 * decision takes its own `ps` only when that sample is older than the device cap's 5 seconds, one
 * `ps` shared by every decision waiting on it, bounded well under the provider hook's 20 seconds.
 * The decision itself runs with no await, so two builds asking together are decided one after the
 * other against the same allowances.
 *
 * Fails open on every uncertainty, like the gate it wraps: a disk read that throws skips the disk
 * check, and with no sample in time the build is allowed.
 *
 * `maxConcurrent` is the guaranteed floor. Above it, up to `burst.maxConcurrent`, a build is
 * allowed only while the machine has headroom (native-build-headroom.ts), judged from the
 * resource monitor's reading of the machine and a free-disk read at decision time. Burst fails
 * closed: a missing, old or partial reading refuses it. A burst build already running is never
 * touched when headroom drops; only the next build is refused.
 */

import os from "node:os";
import { type RemediationConfig, resolveDiskRemediationConfig } from "../remediation/config.js";
import type { DeviceLaunchGate, DeviceLaunchGateDecision } from "./device-lease-manager.js";
import { basename } from "./device-launch-commands.js";
import { formatGigabytes } from "./gigabytes.js";
import {
  type BuildLauncher,
  detectNativeBuildIntents,
  type NativeBuildIntent,
} from "./native-build-commands.js";
import {
  type BuildGateBurstConfig,
  type BuildGateHardware,
  type BuildGateMachineReading,
  type BurstCheck,
  type BurstHeadroomVerdict,
  type BuildGateSlotDefaults,
  deriveBuildGateDefaults,
  describeDiskReserve,
  diskReserveBytes,
  evaluateBurstHeadroom,
  recordSwapUse,
  type ResolvedBurstConfig,
  resolveBurstConfig,
  type SwapUseReading,
} from "./native-build-headroom.js";
import {
  type NativeBuildScan,
  type RunningBuildRunner,
  type RunningNativeBuild,
  scanNativeBuilds,
  tokenizeProcessRow,
} from "./native-build-detection.js";
import { type AgentProcessTree, attributeProcessTrees } from "./process-attribution.js";
import {
  parseClockSeconds,
  type ProcessSampleRow,
  type ResourceMonitorSampler,
} from "./process-sampler.js";

/** A sample this young decides without a `ps` of the gate's own: the device cap's bound. */
export const BUILD_GATE_SAMPLE_MAX_AGE_MS = 5_000;
/** How long a decision waits for its own `ps`, well under the provider hook's 20 seconds. */
export const BUILD_GATE_SAMPLE_TIMEOUT_MS = 8_000;
/** When that `ps` is late, the monitor's last sample still decides if it is this young. */
const STALE_SAMPLE_MAX_AGE_MS = 2 * 60_000;
/**
 * An allowance is judged only by a sample taken this long after it. The provider runs the
 * command after the hook answers, so an earlier sample has not seen it yet, and two builds asked
 * for in one message must not both pass.
 */
export const BUILD_GATE_GRANT_GRACE_MS = 5_000;
/** An allowance whose launcher stays alive without its build ever appearing lets go here. */
export const BUILD_GATE_GRANT_BACKSTOP_MS = 60 * 60_000;
/**
 * A runner (`expo run`, `react-native run`, `eas build --local`) holds a slot while it sets up,
 * until its native build has been seen and ended. One never seen building lets go after this.
 */
export const BUILD_GATE_RUNNER_SETUP_MS = 30 * 60_000;
const DEFAULT_MAX_BUILD_MINUTES = 120;
/** Characters a shell wraps a word in: `eval './gradlew assembleDebug'`. */
const WORD_EDGES = /^['"`(){}[\];&|]+|['"`(){}[\];&|]+$/g;

export interface BuildGateConfig {
  enabled?: boolean;
  dryRun?: boolean;
  /** The guaranteed floor. Absent: derived from the machine (native-build-headroom.ts). */
  maxConcurrent?: number;
  maxBuildMinutes?: number;
  burst?: BuildGateBurstConfig;
}

interface ResolvedBuildGateConfig {
  enabled: boolean;
  dryRun: boolean;
  maxConcurrent: number;
  maxBuildMs: number;
  burst: ResolvedBurstConfig;
}

interface BuildGateAgent {
  agentId: string;
  title?: string;
}

interface BuildGateLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

/** A `ps` sample attributed to agents, and when it was taken. */
interface BuildGateSample {
  rows: readonly ProcessSampleRow[];
  agentTrees: readonly AgentProcessTree[];
  takenAtMs: number;
}

export interface NativeBuildGateOptions {
  /** The device cap and what it wraps. Every command this gate lets through goes on to it. */
  inner: DeviceLaunchGate;
  /** For a decision whose sample is too old. Never throws: a failed read says so. */
  processSampler: Pick<ResourceMonitorSampler, "sampleProcessTable">;
  /** Who the agents are, to attribute builds and name them in a refusal. */
  listAgents: () => readonly BuildGateAgent[];
  /** Processes the daemon runs as an agent's own work (`ask_jev`), as the monitor attributes them. */
  readAgentSideProcesses?: () => ReadonlyMap<string, readonly number[]>;
  /** `remediation.disk.lowFreeGB` is the free-space line under which no build starts. */
  readConfig: () => { buildGate?: BuildGateConfig; remediation?: RemediationConfig };
  /** Free bytes on the volume builds write to. Throws when it cannot read. */
  readFreeDiskBytes: () => Promise<number>;
  /**
   * Explains a refusal to a provider whose rejection carries no sentence (Codex, ACP), over the
   * steer path. Absent: those agents see a bare rejection.
   */
  sendSystemMessageToAgent?: (agentId: string, body: string) => Promise<void>;
  logger: BuildGateLogger;
  now?: () => number;
  sampleTimeoutMs?: number;
  /** Cores and memory the slot defaults are derived from. Default: this machine, read once. */
  readHardware?: () => BuildGateHardware;
  /** Which signals the monitor reports (docs/resource-monitor.md). Default: this platform. */
  platform?: NodeJS.Platform;
}

export interface NativeBuildGate extends DeviceLaunchGate {
  /** The resource monitor's attributed sample, each sweep: the count's usual source. */
  observeSample(sample: {
    rows: readonly ProcessSampleRow[];
    agentTrees: readonly AgentProcessTree[];
  }): void;
  /**
   * The resource monitor's reading of the machine, every sweep: what burst is judged on. With
   * none, or an old one, no build is allowed above the floor.
   */
  observeMachine(reading: BuildGateMachineReading): void;
}

/** A build this gate allowed that the scan has not yet seen running. */
interface BuildGrant {
  agentId: string;
  command: string;
  launcher: BuildLauncher;
  atMs: number;
  /** How many counted builds the agent had when this was allowed. */
  baseline: number;
  /** When the grant before this one was made, put back if this one is rolled back. */
  priorGrantAtMs: number | undefined;
}

/** What holds slots in one sample. */
interface HeldSlots {
  builds: RunningNativeBuild[];
  /** Runners still setting up: no native build of theirs seen yet. */
  runners: RunningBuildRunner[];
}

type GateVerdict = { kind: "allow"; grant?: BuildGrant } | { kind: "deny"; message: string };

function resolveConfig(
  config: BuildGateConfig | undefined,
  defaults: BuildGateSlotDefaults,
): ResolvedBuildGateConfig {
  const maxConcurrent = Math.max(1, Math.floor(config?.maxConcurrent ?? defaults.maxConcurrent));
  return {
    enabled: config?.enabled ?? true,
    dryRun: config?.dryRun ?? false,
    maxConcurrent,
    maxBuildMs: (config?.maxBuildMinutes ?? DEFAULT_MAX_BUILD_MINUTES) * 60_000,
    burst: resolveBurstConfig(config?.burst, defaults, maxConcurrent),
  };
}

function defaultHardware(): BuildGateHardware {
  return { cpuCount: os.cpus().length, memoryBytes: os.totalmem() };
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole >= 3600) {
    const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
    return `${Math.floor(whole / 3600)}h${minutes}m`;
  }
  if (whole >= 60) return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
  return `${whole}s`;
}

/** How long a process has run, from its `ps` etime; undefined when that does not parse. */
function runningMs(entry: RunningNativeBuild): number | undefined {
  const seconds = parseClockSeconds(entry.etime);
  return seconds === undefined ? undefined : seconds * 1000;
}

function countOf(held: HeldSlots, agentId: string): number {
  return [...held.builds, ...held.runners].filter((entry) => entry.agentId === agentId).length;
}

function describeAgent(agentId: string, titles: ReadonlyMap<string, string>): string {
  const title = titles.get(agentId);
  return title ? `"${title}" (agent ${agentId})` : `agent ${agentId}`;
}

function describeHolder(input: {
  entry: RunningNativeBuild;
  state: string;
  askingAgentId: string;
  titles: ReadonlyMap<string, string>;
}): string {
  const { entry, askingAgentId, titles } = input;
  const ms = runningMs(entry);
  const running = `${input.state}${ms === undefined ? "" : `, running ${formatDuration(ms / 1000)}`}`;
  if (entry.agentId === askingAgentId) {
    return `your own earlier build \`${entry.command}\`${running}`;
  }
  if (entry.agentId) {
    return `\`${entry.command}\` by ${describeAgent(entry.agentId, titles)}${running}`;
  }
  return (
    `\`${entry.command}\`, outside every agent's process tree (started by hand, by an IDE, or ` +
    `left behind by an agent that is gone)${running}`
  );
}

function describeGrant(
  grant: BuildGrant,
  askingAgentId: string,
  titles: ReadonlyMap<string, string>,
  nowMs: number,
): string {
  const ago = formatDuration((nowMs - grant.atMs) / 1000);
  const whose =
    grant.agentId === askingAgentId
      ? `your own \`${grant.command}\``
      : `\`${grant.command}\` for ${describeAgent(grant.agentId, titles)}`;
  return `${whose}, allowed ${ago} ago and starting`;
}

/**
 * Why a build was refused for want of a slot: `floor` when burst is off or its ceiling is no
 * higher than the floor, `ceiling` when burst is full, `headroom` when a burst check failed,
 * `disk-reserve` when a build within the floor would not leave the disk room for every build taken.
 */
type CapCause =
  | { kind: "floor" }
  | { kind: "ceiling" }
  | { kind: "headroom"; check: BurstCheck; detail: string }
  | { kind: "disk-reserve"; detail: string; requiredBytes: number };

interface CapRefusal {
  reason: "at-cap" | "at-burst-cap" | "no-headroom" | "disk-reserve";
  cause: CapCause;
}

/** Whether a build at or over the floor is refused, and why. Undefined: it takes a burst slot. */
function refuseAboveFloor(input: {
  headroom: BurstHeadroomVerdict;
  taken: number;
  config: ResolvedBuildGateConfig;
}): CapRefusal | undefined {
  const { config, headroom } = input;
  if (!config.burst.enabled || config.burst.maxConcurrent <= config.maxConcurrent) {
    return { reason: "at-cap", cause: { kind: "floor" } };
  }
  if (input.taken >= config.burst.maxConcurrent) {
    return { reason: "at-burst-cap", cause: { kind: "ceiling" } };
  }
  if (headroom.ok) return undefined;
  return {
    reason: "no-headroom",
    cause: { kind: "headroom", check: headroom.check, detail: headroom.detail },
  };
}

/**
 * Whether a build within the floor is refused for disk. The first build needs only the low line,
 * checked before the scan; each one after it also needs a reserve for every build taken and the
 * new one, because builds already running have not finished writing. A failed free-disk read
 * skips this, as it skips the low line: the floor fails open.
 */
function refuseForDiskReserve(input: {
  config: ResolvedBuildGateConfig;
  taken: number;
  freeBytes: number | undefined;
  lowFreeBytes: number;
}): CapRefusal | undefined {
  const { freeBytes } = input;
  if (input.taken < 1 || freeBytes === undefined) return undefined;
  const reserve = {
    lowFreeBytes: input.lowFreeBytes,
    perBuildDiskBytes: input.config.burst.perBuildDiskBytes,
    taken: input.taken,
  };
  const requiredBytes = diskReserveBytes(reserve);
  if (freeBytes >= requiredBytes) return undefined;
  return {
    reason: "disk-reserve",
    cause: {
      kind: "disk-reserve",
      detail: describeDiskReserve({ ...reserve, freeBytes }),
      requiredBytes,
    },
  };
}

const CHECK_LABELS: Record<BurstCheck, string> = {
  reading: "machine reading",
  memory: "memory",
  swap: "swap",
  cpu: "CPU",
  disk: "disk",
  settling: "settling",
};

function describeCapCause(input: {
  held: number;
  cause: CapCause;
  config: ResolvedBuildGateConfig;
}): string {
  const { config, cause } = input;
  const running = `${input.held} native build${input.held === 1 ? " is" : "s are"} running or starting`;
  if (cause.kind === "floor") {
    return `${running}, and the limit is ${config.maxConcurrent} at a time.`;
  }
  if (cause.kind === "ceiling") {
    return (
      `${running}, and both the guaranteed limit (${config.maxConcurrent}) and the burst ` +
      `ceiling (${config.burst.maxConcurrent}) are reached.`
    );
  }
  if (cause.kind === "disk-reserve") {
    return (
      `${running}, and the disk has no room for another beside them: ${cause.detail}. One ` +
      "native build writes 10 to 34 GB."
    );
  }
  return (
    `${running}. The guaranteed limit is ${config.maxConcurrent}; a build above it is a burst ` +
    `build (up to ${config.burst.maxConcurrent}), and burst needs headroom: the ` +
    `${CHECK_LABELS[cause.check]} check failed: ${cause.detail}.`
  );
}

function buildCapDenial(input: {
  intent: NativeBuildIntent;
  holders: readonly string[];
  config: ResolvedBuildGateConfig;
  cause: CapCause;
}): string {
  return [
    `Bozeo build gate: \`${input.intent.command}\` was not run: ` +
      describeCapCause({ held: input.holders.length, cause: input.cause, config: input.config }),
    ...input.holders.map((holder) => `- ${holder}`),
    "Wait for one to finish, then run the command again. Run `sleep 120` on its own first (not " +
      "chained in front of the build, which the gate sees at once), then retry, and repeat until " +
      "it goes through. A build stops holding a slot after " +
      `${Math.round(input.config.maxBuildMs / 60_000)} minutes. Do not work around the gate ` +
      "with another wrapper, a background job or a different shell: two native builds at once " +
      "filled this machine's disk and forced a reboot on 2026-10-08.",
  ].join("\n");
}

function buildDiskDenial(input: {
  intent: NativeBuildIntent;
  freeBytes: number;
  minFreeBytes: number;
}): string {
  return (
    `Bozeo build gate: \`${input.intent.command}\` was not run because free disk is ` +
    `${formatGigabytes(input.freeBytes)}, under the ${formatGigabytes(input.minFreeBytes)} line. ` +
    "One native build writes 10 to 34 GB, and a full volume takes down every agent on this " +
    "machine. The daemon's disk remedies are already working on it. Wait for space: run " +
    "`sleep 300` on its own, then run the command again. Do not delete DerivedData, caches or " +
    "simulators to get past this; other agents may be using them. If it stays low, tell your " +
    "parent agent or the person at the keyboard."
  );
}

/** Whether a process in the agent's tree still runs the command the grant allowed. */
function launcherAlive(sample: BuildGateSample, grant: BuildGrant): boolean {
  const tree = sample.agentTrees.find((candidate) => candidate.agentId === grant.agentId);
  if (!tree) return false;
  const pids = new Set(tree.pids);
  return sample.rows.some((row) => {
    if (!pids.has(row.pid)) return false;
    const words = tokenizeProcessRow(row).map((token) => token.replace(WORD_EDGES, ""));
    return (
      words.some((word) => basename(word) === grant.launcher.program) &&
      (grant.launcher.argument === undefined || words.includes(grant.launcher.argument))
    );
  });
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createNativeBuildGate(options: NativeBuildGateOptions): NativeBuildGate {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const slotDefaults = deriveBuildGateDefaults((options.readHardware ?? defaultHardware)());
  const sampleTimeoutMs = options.sampleTimeoutMs ?? BUILD_GATE_SAMPLE_TIMEOUT_MS;
  let grants: BuildGrant[] = [];
  let latest: { sample: BuildGateSample; scan: NativeBuildScan } | undefined;
  let inFlight: Promise<BuildGateSample | undefined> | undefined;
  /** Runners whose native build has been seen: they hold nothing once it ends. */
  let runnersSeenBuilding = new Set<number>();
  /** Builds already logged as past maxBuildMinutes. */
  let agedOut = new Set<number>();
  /** The last refusal this gate gave each agent, so it explains its own and no other gate's. */
  const refusals = new Map<string, string>();
  let diskReadFailing = false;
  let sampleFailing = false;
  /** The monitor's newest reading of the machine, and the swap it has shown lately. */
  let machine: BuildGateMachineReading | undefined;
  let swapHistory: SwapUseReading[] = [];
  /** When this gate last allowed a build, floor or burst: a reading older than it has not seen it. */
  let lastGrantAtMs: number | undefined;

  /** Takes a sample as the newest, and learns what it says about runners. */
  function adopt(sample: BuildGateSample): void {
    if (latest && latest.sample.takenAtMs > sample.takenAtMs) return;
    const scan = scanNativeBuilds(sample);
    const present = new Set(scan.runners.map((runner) => runner.pid));
    runnersSeenBuilding = new Set([...runnersSeenBuilding].filter((pid) => present.has(pid)));
    for (const runner of scan.runners) {
      if (runner.building) runnersSeenBuilding.add(runner.pid);
    }
    latest = { sample, scan };
  }

  function heldSlots(scan: NativeBuildScan, config: ResolvedBuildGateConfig): HeldSlots {
    const buildPids = new Set(scan.builds.map((build) => build.pid));
    agedOut = new Set([...agedOut].filter((pid) => buildPids.has(pid)));
    const builds = scan.builds.filter((build) => {
      const ms = runningMs(build);
      if (ms === undefined || ms < config.maxBuildMs) return true;
      if (!agedOut.has(build.pid)) {
        agedOut.add(build.pid);
        options.logger.info(
          { pid: build.pid, command: build.command, agentId: build.agentId, etime: build.etime },
          "Build gate stopped counting a build past maxBuildMinutes",
        );
      }
      return false;
    });
    const runners = scan.runners.filter((runner) => {
      if (runner.building || runnersSeenBuilding.has(runner.pid)) return false;
      const ms = runningMs(runner);
      return ms === undefined || ms < BUILD_GATE_RUNNER_SETUP_MS;
    });
    return { builds, runners };
  }

  /**
   * Drops allowances a sample can judge: the build appeared (the scan counts it now), nothing in
   * the agent's tree runs the command any more (it finished, failed or never started), or the
   * backstop passed. One the sample is too early to judge is kept.
   */
  function judgeGrants(sample: BuildGateSample, held: HeldSlots, nowMs: number): void {
    grants = grants.filter((grant) => {
      if (nowMs - grant.atMs >= BUILD_GATE_GRANT_BACKSTOP_MS) return false;
      if (sample.takenAtMs < grant.atMs + BUILD_GATE_GRANT_GRACE_MS) return true;
      if (countOf(held, grant.agentId) > grant.baseline) return false;
      return launcherAlive(sample, grant);
    });
  }

  async function takeSample(): Promise<BuildGateSample | undefined> {
    const takenAtMs = now();
    const table = await options.processSampler.sampleProcessTable();
    if (table.status !== "ok") return undefined;
    const { agentTrees } = attributeProcessTrees(
      table.rows,
      options.listAgents().map((agent) => agent.agentId),
      { extraRoots: options.readAgentSideProcesses?.() ?? new Map() },
    );
    const sample = { rows: table.rows, agentTrees, takenAtMs };
    adopt(sample);
    return sample;
  }

  /**
   * The sample a decision at `nowMs` uses: the latest when it is young enough and late enough to
   * judge every allowance that is due, else one `ps` shared by everybody waiting, bounded. When
   * that is late, the monitor's last sample if it is recent; undefined when there is nothing.
   */
  async function sampleFor(nowMs: number): Promise<BuildGateSample | undefined> {
    const dueGrants = grants
      .map((grant) => grant.atMs + BUILD_GATE_GRANT_GRACE_MS)
      .filter((dueAtMs) => dueAtMs <= nowMs);
    const neededAfterMs = Math.max(nowMs - BUILD_GATE_SAMPLE_MAX_AGE_MS, ...dueGrants);
    if (latest && latest.sample.takenAtMs >= neededAfterMs) return latest.sample;
    inFlight ??= takeSample()
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
      });
    const fresh = await withTimeout(inFlight, sampleTimeoutMs);
    if (fresh) return fresh;
    if (latest && nowMs - latest.sample.takenAtMs <= STALE_SAMPLE_MAX_AGE_MS) {
      return latest.sample;
    }
    return undefined;
  }

  async function readFreeBytes(): Promise<number | undefined> {
    try {
      const freeBytes = await withTimeout(options.readFreeDiskBytes(), sampleTimeoutMs);
      diskReadFailing = false;
      return freeBytes;
    } catch (error) {
      if (!diskReadFailing) {
        diskReadFailing = true;
        options.logger.warn({ err: error }, "Build gate could not read free disk; not checking it");
      }
      return undefined;
    }
  }

  function refuse(input: {
    agentId: string;
    intent: NativeBuildIntent;
    config: ResolvedBuildGateConfig;
    message: string;
    fields: object;
  }): GateVerdict {
    const fields = { agentId: input.agentId, command: input.intent.command, ...input.fields };
    if (input.config.dryRun) {
      options.logger.info(
        { ...fields, dryRun: true },
        "Build gate would have refused a native build",
      );
      return { kind: "allow" };
    }
    options.logger.info(fields, "Build gate refused a native build");
    return { kind: "deny", message: input.message };
  }

  /** Synchronous, so no other decision can run between reading the slots and taking one. */
  function decide(input: {
    agentId: string;
    intent: NativeBuildIntent;
    config: ResolvedBuildGateConfig;
    sample: BuildGateSample;
    freeBytes: number | undefined;
    lowFreeBytes: number;
    nowMs: number;
  }): GateVerdict {
    const { agentId, intent, config, sample, nowMs } = input;
    const scan = latest?.sample === sample ? latest.scan : scanNativeBuilds(sample);
    const held = heldSlots(scan, config);
    judgeGrants(sample, held, nowMs);
    const taken = held.builds.length + held.runners.length + grants.length;
    // Judged on every decision so the log shows the figures; only a build above the floor acts on it.
    const headroom = evaluateBurstHeadroom({
      platform,
      nowMs,
      reading: machine,
      swapHistory,
      taken,
      unseen: grants.length,
      freeDiskBytes: input.freeBytes,
      lowFreeBytes: input.lowFreeBytes,
      lastGrantAtMs,
      config: config.burst,
    });
    const slots = {
      running: held.builds.length,
      settingUp: held.runners.length,
      starting: grants.length,
      max: config.maxConcurrent,
      burstMax: config.burst.enabled ? config.burst.maxConcurrent : undefined,
      sampleAgeMs: nowMs - sample.takenAtMs,
      headroom: headroom.numbers,
    };
    const burst = taken >= config.maxConcurrent;
    const refusal = burst
      ? refuseAboveFloor({ headroom, taken, config })
      : refuseForDiskReserve({
          config,
          taken,
          freeBytes: input.freeBytes,
          lowFreeBytes: input.lowFreeBytes,
        });
    if (refusal) {
      return refuse({
        agentId,
        intent,
        config,
        message: buildCapDenial({
          intent,
          holders: describeHolders({ held, askingAgentId: agentId, nowMs }),
          config,
          cause: refusal.cause,
        }),
        fields: {
          reason: refusal.reason,
          ...(refusal.cause.kind === "headroom" ? { check: refusal.cause.check } : {}),
          ...(refusal.cause.kind === "disk-reserve"
            ? { freeBytes: input.freeBytes, requiredBytes: refusal.cause.requiredBytes }
            : {}),
          burst: false,
          ...slots,
          holders: [...held.builds, ...held.runners].map((entry) => ({
            pid: entry.pid,
            command: entry.command,
            agentId: entry.agentId,
          })),
        },
      });
    }
    const grant: BuildGrant = {
      agentId,
      command: intent.command,
      launcher: intent.launcher,
      atMs: nowMs,
      baseline: countOf(held, agentId),
      priorGrantAtMs: lastGrantAtMs,
    };
    grants.push(grant);
    lastGrantAtMs = nowMs;
    options.logger.info(
      {
        agentId,
        command: intent.command,
        ...slots,
        burst,
        dryRun: config.dryRun,
      },
      "Build gate allowed a native build",
    );
    return { kind: "allow", grant };
  }

  function describeHolders(input: {
    held: HeldSlots;
    askingAgentId: string;
    nowMs: number;
  }): string[] {
    const { held, askingAgentId, nowMs } = input;
    const titles = new Map(
      options
        .listAgents()
        .flatMap((agent) => (agent.title ? [[agent.agentId, agent.title] as const] : [])),
    );
    return [
      ...held.builds.map((entry) => describeHolder({ entry, state: "", askingAgentId, titles })),
      ...held.runners.map((entry) =>
        describeHolder({ entry, state: ", setting up", askingAgentId, titles }),
      ),
      ...grants.map((grant) => describeGrant(grant, askingAgentId, titles, nowMs)),
    ];
  }

  async function evaluate(
    agentId: string,
    intent: NativeBuildIntent,
    config: ResolvedBuildGateConfig,
  ): Promise<GateVerdict> {
    const { lowFreeBytes: minFreeBytes } = resolveDiskRemediationConfig(
      options.readConfig().remediation,
    );
    const freeBytes = await readFreeBytes();
    if (freeBytes !== undefined && freeBytes < minFreeBytes) {
      return refuse({
        agentId,
        intent,
        config,
        message: buildDiskDenial({ intent, freeBytes, minFreeBytes }),
        fields: { reason: "disk-low", freeBytes, minFreeBytes },
      });
    }
    const sample = await sampleFor(now());
    if (!sample) {
      if (!sampleFailing) {
        sampleFailing = true;
        options.logger.warn(
          { agentId, command: intent.command, timeoutMs: sampleTimeoutMs },
          "Build gate had no process sample in time; allowing",
        );
      }
      return { kind: "allow" };
    }
    sampleFailing = false;
    return decide({
      agentId,
      intent,
      config,
      sample,
      freeBytes,
      lowFreeBytes: minFreeBytes,
      nowMs: now(),
    });
  }

  return {
    async gateLaunch(input): Promise<DeviceLaunchGateDecision> {
      // A chained command runs its builds one after another, so it needs one slot.
      const intent = detectNativeBuildIntents(input.command)[0];
      const config = resolveConfig(options.readConfig().buildGate, slotDefaults);
      if (!intent || !config.enabled) return await options.inner.gateLaunch(input);

      const verdict = await evaluate(input.agentId, intent, config);
      if (verdict.kind === "deny") {
        refusals.set(input.agentId, verdict.message);
        return { decision: "deny", message: verdict.message };
      }
      const decision = await options.inner.gateLaunch(input);
      if (decision.decision === "deny" && verdict.grant) {
        // The device cap said no, so the build never starts: give its slot back.
        grants = grants.filter((grant) => grant !== verdict.grant);
        if (lastGrantAtMs === verdict.grant.atMs) lastGrantAtMs = verdict.grant.priorGrantAtMs;
      }
      return decision;
    },
    async explainRefusalToAgent(input) {
      if (refusals.get(input.agentId) === input.message) {
        refusals.delete(input.agentId);
        await options.sendSystemMessageToAgent?.(input.agentId, input.message);
        return;
      }
      await options.inner.explainRefusalToAgent?.(input);
    },
    observeSample(sample) {
      const nowMs = now();
      adopt({ ...sample, takenAtMs: nowMs });
      if (!latest) return;
      const config = resolveConfig(options.readConfig().buildGate, slotDefaults);
      judgeGrants(latest.sample, heldSlots(latest.scan, config), nowMs);
    },
    observeMachine(reading) {
      if (machine && machine.takenAtMs > reading.takenAtMs) return;
      machine = reading;
      if (reading.systemMemory) {
        swapHistory = recordSwapUse(swapHistory, {
          atMs: reading.takenAtMs,
          usedBytes: reading.systemMemory.swapUsedBytes,
        });
      }
    },
  };
}
