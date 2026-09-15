import type { ResourceAlert } from "./agent-types.js";

/**
 * Push-notification `data.reason` values for the resource monitor. Untyped JSON on the wire
 * (not part of the closed `attentionReason` enum — see agent-types.ts's ResourceAlert),
 * so adding a value here is safe for old apps: they fall back to opening by `agentId`.
 */
export type ResourceMonitorNotificationReason =
  | "resource_memory"
  | "resource_cpu"
  | "resource_system_memory"
  | "resource_orphan_daemons"
  | "resource_multi";

export interface ResourceMonitorNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  agentId?: string;
  /** Present only on the batched (storm) variant, alongside the single `agentId` fallback. */
  agentIds?: string[];
  reason: ResourceMonitorNotificationReason;
}

export interface ResourceMonitorNotificationPayload {
  title: string;
  body: string;
  data: ResourceMonitorNotificationData;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function resolveAgentLabel(agentTitle: string | null | undefined): string {
  const trimmed = agentTitle?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "An agent";
}

interface BuildResourceAgentNotificationPayloadInput {
  serverId: string;
  workspaceId?: string;
  agentId: string;
  agentTitle?: string | null;
  trigger: ResourceAlert["trigger"];
  memoryBytes: number;
  cpuPercent: number;
  memoryBytesLimit: number;
  cpuPercentLimit: number;
}

/**
 * Single-agent breach notification. `title`/`body` are hardcoded English here, matching
 * token-burn-notification.ts's precedent — this payload never crosses the app i18n pipeline,
 * it's built server-side and sent verbatim to the push provider. The body always reports both
 * numbers regardless of which leg triggered, since a runaway process tree that trips memory is
 * usually pinning CPU too.
 */
export function buildResourceAgentNotificationPayload(
  input: BuildResourceAgentNotificationPayloadInput,
): ResourceMonitorNotificationPayload {
  const label = resolveAgentLabel(input.agentTitle);
  const title =
    input.trigger === "memory" ? "Agent is using a lot of memory" : "Agent is using a lot of CPU";
  const body = `${label}'s processes are using ${formatBytes(input.memoryBytes)} / ${Math.round(input.cpuPercent)}% CPU (limits ${formatBytes(input.memoryBytesLimit)} / ${input.cpuPercentLimit}%).`;

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agentId: input.agentId,
      reason: input.trigger === "memory" ? "resource_memory" : "resource_cpu",
    },
  };
}

interface BatchedResourceBreach {
  agentId: string;
  workspaceId?: string;
}

interface BuildBatchedResourceNotificationPayloadInput {
  serverId: string;
  breaches: readonly BatchedResourceBreach[];
}

/**
 * Combined notification for a sweep that breaches more than the monitor's batch threshold at
 * once — one push instead of one per agent. Individual agents still get their own
 * `resourceAlert` set (see agent-manager.ts's setResourceAlert), so per-agent UI state is
 * unaffected by batching; only the push is collapsed. Mirrors
 * buildBatchedTokenBurnNotificationPayload.
 */
export function buildBatchedResourceNotificationPayload(
  input: BuildBatchedResourceNotificationPayloadInput,
): ResourceMonitorNotificationPayload {
  const first = input.breaches[0];
  if (!first) {
    throw new Error("buildBatchedResourceNotificationPayload requires at least one breach");
  }

  return {
    title: "Multiple agents are using a lot of resources",
    body: `${input.breaches.length} agents crossed their resource threshold.`,
    data: {
      serverId: input.serverId,
      ...(first.workspaceId ? { workspaceId: first.workspaceId } : {}),
      agentId: first.agentId,
      agentIds: input.breaches.map((breach) => breach.agentId),
      reason: "resource_multi",
    },
  };
}

interface BuildResourceSystemMemoryNotificationPayloadInput {
  serverId: string;
  swapUsedBytes: number;
  swapTotalBytes: number;
  swapUsedRatio: number;
}

/**
 * Machine-level breach: no single agent to attribute it to, so `data` carries no `agentId` —
 * the app opens the server's agent list instead of a specific agent.
 */
export function buildResourceSystemMemoryNotificationPayload(
  input: BuildResourceSystemMemoryNotificationPayloadInput,
): ResourceMonitorNotificationPayload {
  return {
    title: "System is low on memory",
    body: `Swap is ${Math.round(input.swapUsedRatio * 100)}% used (${formatBytes(input.swapUsedBytes)} / ${formatBytes(input.swapTotalBytes)}).`,
    data: {
      serverId: input.serverId,
      reason: "resource_system_memory",
    },
  };
}

interface BuildResourceOrphanBuildDaemonsNotificationPayloadInput {
  serverId: string;
  count: number;
  rssBytes: number;
}

/**
 * Machine-level breach for detached build daemons (Gradle/Kotlin) that outlived the agent that
 * spawned them — ppid 1, so no agent's process tree owns them (see
 * process-attribution.ts). Push only; there's no agent to steer a message into.
 */
export function buildResourceOrphanBuildDaemonsNotificationPayload(
  input: BuildResourceOrphanBuildDaemonsNotificationPayloadInput,
): ResourceMonitorNotificationPayload {
  const noun = input.count === 1 ? "daemon is" : "daemons are";
  return {
    title: "Orphaned build daemons are eating memory",
    body: `${input.count} orphaned build ${noun} using ${formatBytes(input.rssBytes)}. Run \`./gradlew --stop\` to clear them.`,
    data: {
      serverId: input.serverId,
      reason: "resource_orphan_daemons",
    },
  };
}
