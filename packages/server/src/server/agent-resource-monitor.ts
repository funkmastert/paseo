import type { ResourceAlert } from "@getpaseo/protocol/agent-types";
import {
  buildBatchedResourceNotificationPayload,
  buildResourceAgentNotificationPayload,
  buildResourceOrphanBuildDaemonsNotificationPayload,
  buildResourceSystemMemoryNotificationPayload,
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
import { attributeProcessTrees, type AgentProcessTree } from "./agent/process-attribution.js";
import type { OrphanBuildDaemonSummary } from "./agent/process-attribution.js";
import type { ProcessSampler, SystemMemorySample } from "./agent/process-sampler.js";
import type { PushNotificationSender } from "./push/index.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const GIBIBYTE = 1024 ** 3;
const DEFAULT_MEMORY_BYTES_PER_AGENT = 6 * GIBIBYTE;
const DEFAULT_CPU_PERCENT_PER_AGENT = 400;
const DEFAULT_SUSTAINED_MINUTES = 3;
const DEFAULT_SYSTEM_SWAP_USED_RATIO = 0.9;
const DEFAULT_ORPHAN_BUILD_DAEMON_BYTES = 2 * GIBIBYTE;
const DEFAULT_BREACH_BATCH_THRESHOLD = 3;

export interface ResourceMonitorConfig {
  enabled?: boolean;
  memoryBytesPerAgent?: number;
  cpuPercentPerAgent?: number;
  sustainedMinutes?: number;
  systemSwapUsedRatio?: number;
  orphanBuildDaemonBytes?: number;
  notifyAgent?: boolean;
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
}

interface ResolvedResourceMonitorConfig extends ResourceMonitorDetectorConfig {
  notifyAgent: boolean;
}

function resolveConfig(config: ResourceMonitorConfig | undefined): ResolvedResourceMonitorConfig {
  return {
    memoryBytesPerAgent: config?.memoryBytesPerAgent ?? DEFAULT_MEMORY_BYTES_PER_AGENT,
    cpuPercentPerAgent: config?.cpuPercentPerAgent ?? DEFAULT_CPU_PERCENT_PER_AGENT,
    sustainedMinutes: config?.sustainedMinutes ?? DEFAULT_SUSTAINED_MINUTES,
    systemSwapUsedRatio: config?.systemSwapUsedRatio ?? DEFAULT_SYSTEM_SWAP_USED_RATIO,
    orphanBuildDaemonBytes: config?.orphanBuildDaemonBytes ?? DEFAULT_ORPHAN_BUILD_DAEMON_BYTES,
    notifyAgent: config?.notifyAgent ?? true,
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
    `${Math.round(input.cpuPercent)}% CPU (limits ${limitGb} GB / ${input.cpuPercentLimit}%). ` +
    "Stop or trim heavy child processes before continuing; if you launched Gradle, run " +
    "`./gradlew --stop`. Prefer sequential builds."
  );
}

interface AgentBreach {
  agentId: string;
  workspaceId: string | undefined;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Machine-level legs have no agent to attach state to, so this monitor instance — a
   * bootstrap-time singleton — owns it directly instead of round-tripping through AgentManager. */
  private machineState: MachineResourceMonitorState | undefined;

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
  }

  start(): void {
    if (this.timer) {
      return;
    }
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
    const [processRows, systemMemory] = await Promise.all([
      this.processSampler.sampleProcesses(),
      this.processSampler.sampleSystemMemory(),
    ]);
    const attribution = attributeProcessTrees(
      processRows,
      agents.map((agent) => agent.id),
    );

    const agentBreaches = this.evaluateAgentBreaches(agents, attribution.agentTrees, config, nowMs);
    const machineTriggers = this.evaluateMachineBreaches(
      systemMemory,
      attribution.orphanBuildDaemons,
      config,
    );

    await this.sendAgentBreaches(agentBreaches, config);
    await this.sendMachineBreaches(machineTriggers, systemMemory, attribution.orphanBuildDaemons);
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
