import type { ResourceAlert } from "@getpaseo/protocol/agent-types";
import {
  buildBatchedResourceNotificationPayload,
  buildResourceAgentNotificationPayload,
  buildArtifactJanitorNotificationPayload,
  buildResourceBuildDaemonReapNotificationPayload,
  buildResourceOrphanBuildDaemonsNotificationPayload,
  buildResourceSystemMemoryNotificationPayload,
  type ReapedBuildDaemon,
} from "@getpaseo/protocol/resource-monitor-notification";
import type { AgentManager, ResourceMonitorAgentSummary } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  evaluateAgentResourceBreach,
  evaluateMachineResourceBreach,
  type MachineResourceMonitorState,
  type MachineResourceTrigger,
  type ResourceMonitorDetectorConfig,
} from "./agent/resource-monitor-detector.js";
import {
  type BuildDaemonReapCandidate,
  type BuildDaemonReaperConfig,
  type BuildDaemonReaperMemory,
  type BuildDaemonSighting,
  createSystemProcessSignaller,
  evaluateBuildDaemonReapCandidates,
  markBuildDaemonHandled,
  type ProcessSignaller,
} from "./agent/build-daemon-reaper.js";
import { attributeProcessTrees, type AgentProcessTree } from "./agent/process-attribution.js";
import { detectRunningDevices, type RunningDevice } from "./agent/device-detection.js";
import type { TestArtifactSweepResult } from "./agent/test-artifact-janitor.js";
import { withRecentCpuPercent, type CpuRateMemory } from "./agent/process-cpu-rate.js";
import type { OrphanBuildDaemonSummary } from "./agent/process-attribution.js";
import type {
  ProcessSampleRow,
  ProcessSampler,
  SystemMemorySample,
} from "./agent/process-sampler.js";
import type { PushNotificationSender } from "./push/index.js";
import { MonitorModeLog } from "./monitor-mode-log.js";

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

export interface ResourceMonitorReaperConfig {
  enabled?: boolean;
  dryRun?: boolean;
  idleCpuPercent?: number;
  idleMinutes?: number;
  minIdleSweeps?: number;
  maxPerSweep?: number;
  graceMs?: number;
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
}

interface AgentResourceMonitorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AgentResourceMonitorOptions {
  agentManager: Pick<
    AgentManager,
    | "listAgentsForResourceMonitor"
    | "getResourceMonitorState"
    | "setResourceMonitorState"
    | "setResourceAlert"
    | "clearResourceAlert"
  >;
  agentStorage: Pick<AgentStorage, "get">;
  pushNotificationSender: PushNotificationSender;
  serverId: string;
  processSampler: ProcessSampler;
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
}

interface ResolvedReaperConfig extends BuildDaemonReaperConfig {
  enabled: boolean;
  dryRun: boolean;
  graceMs: number;
}

interface ResolvedResourceMonitorConfig extends ResourceMonitorDetectorConfig {
  notifyAgent: boolean;
  reaper: ResolvedReaperConfig;
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
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

function toReapedBuildDaemon(candidate: BuildDaemonReapCandidate): ReapedBuildDaemon {
  return {
    pid: candidate.pid,
    label: candidate.label,
    rssBytes: candidate.rssBytes,
    idleMs: candidate.idleMs,
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
  private readonly agentStorage: Pick<AgentStorage, "get">;
  private readonly pushNotificationSender: PushNotificationSender;
  private readonly serverId: string;
  private readonly processSampler: ProcessSampler;
  private readonly sendSystemMessageToAgent: AgentResourceMonitorOptions["sendSystemMessageToAgent"];
  private readonly readDaemonConfig: () => { resourceMonitor?: ResourceMonitorConfig };
  private readonly logger: AgentResourceMonitorLogger;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly processSignaller: ProcessSignaller;
  private readonly ownerUid: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly reportDeviceSample: AgentResourceMonitorOptions["reportDeviceSample"];
  private readonly sweepTestArtifacts: AgentResourceMonitorOptions["sweepTestArtifacts"];
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
  private sweepInFlight = false;
  private readonly modeLog: MonitorModeLog;

  constructor(options: AgentResourceMonitorOptions) {
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.pushNotificationSender = options.pushNotificationSender;
    this.serverId = options.serverId;
    this.processSampler = options.processSampler;
    this.sendSystemMessageToAgent = options.sendSystemMessageToAgent;
    this.readDaemonConfig = options.readDaemonConfig;
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.processSignaller = options.processSignaller ?? createSystemProcessSignaller();
    this.ownerUid = "ownerUid" in options ? options.ownerUid : process.getuid?.();
    this.sleep = options.sleep ?? defaultSleep;
    this.reportDeviceSample = options.reportDeviceSample;
    this.modeLog = new MonitorModeLog(options.logger);
    this.sweepTestArtifacts = options.sweepTestArtifacts;
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
    const [sampledRows, systemMemory] = await Promise.all([
      this.processSampler.sampleProcesses(),
      this.processSampler.sampleSystemMemory(),
    ]);
    const cpu = withRecentCpuPercent(sampledRows, this.cpuRateMemory, nowMs);
    this.cpuRateMemory = cpu.memory;
    const attribution = attributeProcessTrees(
      cpu.rows,
      agents.map((agent) => agent.id),
    );

    const agentBreaches = this.evaluateAgentBreaches(agents, attribution.agentTrees, config, nowMs);
    const machineTriggers = this.evaluateMachineBreaches(
      systemMemory,
      attribution.orphanBuildDaemons,
      config,
    );

    await this.reportDevices(cpu.rows, attribution.agentTrees, systemMemory);

    await this.sendAgentBreaches(agentBreaches, config);
    await this.sendMachineBreaches(machineTriggers, systemMemory, attribution.orphanBuildDaemons);
    // Runs on its own criteria, not off the orphan alert's threshold: an abandoned daemon sitting
    // on 800 MB is worth reclaiming even though the machine-level leg only fires at 2 GiB.
    await this.reapAbandonedBuildDaemons(cpu.rows, attribution.agentTrees, config.reaper, nowMs);
    await this.reclaimTestArtifacts(cpu.rows);
  }

  /**
   * Never lets the janitor's bookkeeping break a sweep, for the same reason the device cap
   * cannot: this monitor's own legs have already run by here, and a failed disk scan must not
   * cost the next one.
   */
  private async reclaimTestArtifacts(rows: readonly ProcessSampleRow[]): Promise<void> {
    if (!this.sweepTestArtifacts) return;
    let result: TestArtifactSweepResult;
    try {
      result = await this.sweepTestArtifacts({ rows });
    } catch (error) {
      this.logger.warn({ err: error }, "Artifact janitor sweep failed");
      return;
    }
    if (result.reclaimed.length === 0) return;
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
    );
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

  private evaluateMachineBreaches(
    systemMemory: SystemMemorySample | undefined,
    orphanBuildDaemons: OrphanBuildDaemonSummary,
    config: ResolvedResourceMonitorConfig,
  ): MachineResourceTrigger[] {
    const result = evaluateMachineResourceBreach({
      swapUsedRatio: systemMemory ? computeSwapUsedRatio(systemMemory) : undefined,
      orphanBuildDaemonBytes: orphanBuildDaemons.rssBytes,
      config,
      previousState: this.machineState,
    });
    this.machineState = result.nextState;
    return result.triggers;
  }

  private async sendAgentBreaches(
    breaches: AgentBreach[],
    config: ResolvedResourceMonitorConfig,
  ): Promise<void> {
    if (breaches.length === 0) {
      return;
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
      );
    } else {
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
        );
      }
    }

    if (!config.notifyAgent) {
      return;
    }
    for (const breach of breaches) {
      // The steer path only steers into an active turn; for an idle agent it falls back to
      // starting a new turn (agent-prompt.ts), which would spend tokens on an agent nobody is
      // driving — the most likely breach shape, too: a heavy child left behind after the agent
      // stopped. Idle agents get the push and the live alert only.
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
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: breach.agentId },
          "Failed to steer resource-monitor message into agent",
        );
      }
    }
  }

  private async sendMachineBreaches(
    triggers: MachineResourceTrigger[],
    systemMemory: SystemMemorySample | undefined,
    orphanBuildDaemons: OrphanBuildDaemonSummary,
  ): Promise<void> {
    if (triggers.includes("systemMemory") && systemMemory) {
      await this.sendPush(
        buildResourceSystemMemoryNotificationPayload({
          serverId: this.serverId,
          swapUsedBytes: systemMemory.swapUsedBytes,
          swapTotalBytes: systemMemory.swapTotalBytes,
          swapUsedRatio: computeSwapUsedRatio(systemMemory),
        }),
      );
    }
    if (triggers.includes("orphanBuildDaemons")) {
      await this.sendPush(
        buildResourceOrphanBuildDaemonsNotificationPayload({
          serverId: this.serverId,
          count: orphanBuildDaemons.count,
          rssBytes: orphanBuildDaemons.rssBytes,
        }),
      );
    }
  }

  private async reapAbandonedBuildDaemons(
    rows: readonly ProcessSampleRow[],
    agentTrees: readonly AgentProcessTree[],
    reaper: ResolvedReaperConfig,
    nowMs: number,
  ): Promise<void> {
    if (!reaper.enabled) {
      // Turning the reaper on starts the evidence over. Sweeps observed while it was off were
      // never checked against the abandonment rules, and acting on them would skip the wait.
      this.reapMemory = undefined;
      this.lastReaperWatch = "";
      return;
    }

    const attributedPids = new Set(agentTrees.flatMap((tree) => tree.pids));
    const { candidates, memory, sightings } = evaluateBuildDaemonReapCandidates({
      rows,
      attributedPids,
      ownerUid: this.ownerUid,
      config: reaper,
      previous: this.reapMemory,
      nowMs,
    });
    this.reapMemory = memory;
    this.reportReaperSightings(sightings);
    if (candidates.length === 0) {
      return;
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
      );
      return;
    }

    const reaped = await this.terminateBuildDaemons(candidates, reaper, memory);
    if (reaped.length === 0) {
      return;
    }
    await this.sendPush(
      buildResourceBuildDaemonReapNotificationPayload({
        serverId: this.serverId,
        dryRun: false,
        daemons: reaped,
      }),
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

  private async sendPush(payload: {
    title: string;
    body: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.pushNotificationSender.send(payload);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to send resource-monitor push notification");
    }
  }
}
