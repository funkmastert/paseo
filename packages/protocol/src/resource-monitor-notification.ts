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
  // Reported by the opt-in reaper leg (server/agent/build-daemon-reaper.ts). Additive: the
  // union is untyped JSON on the wire, and a client that doesn't know this value falls back to
  // opening the server — no shim, nothing to remove later.
  | "resource_daemons_reaped"
  // COMPAT(artifactJanitor): added in v0.8.2, remove nothing — the union is untyped JSON on the
  // wire, so a client that doesn't know this value falls back to opening the server.
  // Reported by the artifact janitor (server/agent/test-artifact-janitor.ts).
  | "artifacts_reclaimed"
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

const GIBIBYTE = 1_073_741_824;

// GB for anything daemon-sized, MB below that: a reaped Kotlin daemon holding 450 MB reads as
// "450 MB", not "0.4 GB". Every other body in this file is already above a gigabyte, so the
// switch only affects the new per-daemon entries.
function formatBytes(bytes: number): string {
  return bytes >= GIBIBYTE
    ? `${(bytes / GIBIBYTE).toFixed(1)} GB`
    : `${Math.round(bytes / 1_048_576)} MB`;
}

function formatIdleDuration(idleMs: number): string {
  const totalMinutes = Math.round(idleMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
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

/** One daemon the reaper killed (or, in dry-run, would have killed) this sweep. */
export interface ReapedBuildDaemon {
  pid: number;
  /** Human-readable kind, e.g. "Gradle daemon" — from the reaper's allowlist, never free text. */
  label: string;
  rssBytes: number;
  /** How long it had been continuously idle when the reaper picked it. */
  idleMs: number;
}

interface BuildResourceBuildDaemonReapNotificationPayloadInput {
  serverId: string;
  dryRun: boolean;
  daemons: readonly ReapedBuildDaemon[];
}

const MAX_LISTED_DAEMONS = 3;

/**
 * What the reaper did, or — in dry-run — what it would have done. Sent through the same push
 * path as the alert it replaces, because an automatic kill that nobody can see is worse than the
 * notification it's meant to retire: every reap names the pid, the kind, the memory reclaimed and
 * how long the daemon sat idle. Push only; like the orphan-daemon alert there's no agent to steer
 * a message into (that's the definition of an orphan).
 */
export function buildResourceBuildDaemonReapNotificationPayload(
  input: BuildResourceBuildDaemonReapNotificationPayloadInput,
): ResourceMonitorNotificationPayload {
  if (input.daemons.length === 0) {
    throw new Error("buildResourceBuildDaemonReapNotificationPayload requires at least one daemon");
  }
  const totalBytes = input.daemons.reduce((sum, daemon) => sum + daemon.rssBytes, 0);
  const noun = input.daemons.length === 1 ? "daemon" : "daemons";
  const listed = input.daemons
    .slice(0, MAX_LISTED_DAEMONS)
    .map(
      (daemon) =>
        `${daemon.label} pid ${daemon.pid} (${formatBytes(daemon.rssBytes)}, idle ${formatIdleDuration(daemon.idleMs)})`,
    )
    .join(", ");
  const overflow = input.daemons.length - MAX_LISTED_DAEMONS;
  const detail = overflow > 0 ? `${listed}, and ${overflow} more` : listed;
  const verb = input.dryRun ? "Would reap" : "Reaped";
  const suffix = input.dryRun ? " Dry run — nothing was killed." : "";

  return {
    title: input.dryRun
      ? "Orphaned build daemons would be reaped"
      : "Reclaimed memory from orphaned build daemons",
    body: `${verb} ${input.daemons.length} orphaned build ${noun} holding ${formatBytes(totalBytes)}: ${detail}.${suffix}`,
    data: {
      serverId: input.serverId,
      reason: "resource_daemons_reaped",
      dryRun: input.dryRun,
      pids: input.daemons.map((daemon) => daemon.pid),
    },
  };
}

/** One directory the artifact janitor reclaimed, or — in dry run — would have. */
export interface ReclaimedArtifactDirectory {
  /** Human-readable kind, from the janitor's artifact-set allowlist. Never free text. */
  label: string;
  /** The directory's own name — a simulator UDID. Short enough for a notification body. */
  name: string;
  /**
   * The absolute path. Carried in `data` rather than the body, which cannot hold three of them,
   * but carried: an automatic delete nobody can audit is worse than none.
   */
  path: string;
  sizeBytes: number;
  /** How long it had sat untouched when the janitor picked it. */
  ageMs: number;
  /** "obligation" — the run that made it died. "unowned" — nothing on the machine claims it. */
  claim: "obligation" | "unowned";
}

interface BuildArtifactJanitorNotificationPayloadInput {
  serverId: string;
  dryRun: boolean;
  artifacts: readonly ReclaimedArtifactDirectory[];
}

const MAX_LISTED_ARTIFACTS = 3;

/**
 * What the janitor deleted, or would have. Sent through the same push path as the build-daemon
 * reaper's report, for the same reason: a feature that removes things on its own has to say so
 * where somebody will see it, with the path, the size and the reason for every entry.
 */
export function buildArtifactJanitorNotificationPayload(
  input: BuildArtifactJanitorNotificationPayloadInput,
): ResourceMonitorNotificationPayload {
  if (input.artifacts.length === 0) {
    throw new Error("buildArtifactJanitorNotificationPayload requires at least one artifact");
  }
  const totalBytes = input.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const noun = input.artifacts.length === 1 ? "directory" : "directories";
  const kinds = [...new Set(input.artifacts.map((artifact) => artifact.label))].join(", ");
  const listed = input.artifacts
    .slice(0, MAX_LISTED_ARTIFACTS)
    .map(
      (artifact) =>
        `${artifact.name} (${formatBytes(artifact.sizeBytes)}, idle ${formatIdleDuration(artifact.ageMs)})`,
    )
    .join(", ");
  const overflow = input.artifacts.length - MAX_LISTED_ARTIFACTS;
  const detail = overflow > 0 ? `${listed}, and ${overflow} more` : listed;
  const verb = input.dryRun ? "Would reclaim" : "Reclaimed";
  const suffix = input.dryRun ? " Dry run — nothing was deleted." : "";

  return {
    title: input.dryRun
      ? "Leftover test artifacts would be reclaimed"
      : "Reclaimed disk from leftover test artifacts",
    body: `${verb} ${input.artifacts.length} leftover ${noun} holding ${formatBytes(totalBytes)} (${kinds}): ${detail}.${suffix}`,
    data: {
      serverId: input.serverId,
      reason: "artifacts_reclaimed",
      dryRun: input.dryRun,
      paths: input.artifacts.map((artifact) => artifact.path),
    },
  };
}
