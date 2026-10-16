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
 */

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
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_BUILD_MINUTES = 120;
/** Characters a shell wraps a word in: `eval './gradlew assembleDebug'`. */
const WORD_EDGES = /^['"`(){}[\];&|]+|['"`(){}[\];&|]+$/g;

export interface BuildGateConfig {
  enabled?: boolean;
  dryRun?: boolean;
  maxConcurrent?: number;
  maxBuildMinutes?: number;
}

interface ResolvedBuildGateConfig {
  enabled: boolean;
  dryRun: boolean;
  maxConcurrent: number;
  maxBuildMs: number;
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
}

export interface NativeBuildGate extends DeviceLaunchGate {
  /** The resource monitor's attributed sample, each sweep: the count's usual source. */
  observeSample(sample: {
    rows: readonly ProcessSampleRow[];
    agentTrees: readonly AgentProcessTree[];
  }): void;
}

/** A build this gate allowed that the scan has not yet seen running. */
interface BuildGrant {
  agentId: string;
  command: string;
  launcher: BuildLauncher;
  atMs: number;
  /** How many counted builds the agent had when this was allowed. */
  baseline: number;
}

/** What holds slots in one sample. */
interface HeldSlots {
  builds: RunningNativeBuild[];
  /** Runners still setting up: no native build of theirs seen yet. */
  runners: RunningBuildRunner[];
}

type GateVerdict = { kind: "allow"; grant?: BuildGrant } | { kind: "deny"; message: string };

function resolveConfig(config: BuildGateConfig | undefined): ResolvedBuildGateConfig {
  return {
    enabled: config?.enabled ?? true,
    dryRun: config?.dryRun ?? false,
    maxConcurrent: Math.max(1, Math.floor(config?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)),
    maxBuildMs: (config?.maxBuildMinutes ?? DEFAULT_MAX_BUILD_MINUTES) * 60_000,
  };
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

function buildCapDenial(input: {
  intent: NativeBuildIntent;
  holders: readonly string[];
  config: ResolvedBuildGateConfig;
}): string {
  const held = input.holders.length;
  return [
    `Bozeo build gate: \`${input.intent.command}\` was not run: ${held} native ` +
      `build${held === 1 ? " is" : "s are"} running or starting, and the limit is ` +
      `${input.config.maxConcurrent} at a time.`,
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
    nowMs: number;
  }): GateVerdict {
    const { agentId, intent, config, sample, nowMs } = input;
    const scan = latest?.sample === sample ? latest.scan : scanNativeBuilds(sample);
    const held = heldSlots(scan, config);
    judgeGrants(sample, held, nowMs);
    const taken = held.builds.length + held.runners.length + grants.length;
    if (taken >= config.maxConcurrent) {
      return refuse({
        agentId,
        intent,
        config,
        message: buildCapDenial({
          intent,
          holders: describeHolders({ held, askingAgentId: agentId, nowMs }),
          config,
        }),
        fields: {
          reason: "at-cap",
          running: held.builds.length,
          settingUp: held.runners.length,
          starting: grants.length,
          max: config.maxConcurrent,
          sampleAgeMs: nowMs - sample.takenAtMs,
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
    };
    grants.push(grant);
    options.logger.info(
      {
        agentId,
        command: intent.command,
        running: held.builds.length,
        settingUp: held.runners.length,
        starting: grants.length - 1,
        max: config.maxConcurrent,
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
    return decide({ agentId, intent, config, sample, nowMs: now() });
  }

  return {
    async gateLaunch(input): Promise<DeviceLaunchGateDecision> {
      // A chained command runs its builds one after another, so it needs one slot.
      const intent = detectNativeBuildIntents(input.command)[0];
      const config = resolveConfig(options.readConfig().buildGate);
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
      const config = resolveConfig(options.readConfig().buildGate);
      judgeGrants(latest.sample, heldSlots(latest.scan, config), nowMs);
    },
  };
}
