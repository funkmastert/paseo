/**
 * `agents.remediation`: the settings for the remediation ladder (docs/remediation.md) and for the
 * self-heal sweeps that plug into it. Every field is optional; the resolvers below own the
 * defaults, so a daemon with no `remediation` block runs the ladder as designed: remedies on,
 * escalation on, a person told only when both fail.
 */

import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

/** Inferred from the wire schema (`MutableRemediationConfigSchema`), the one definition. */
export type RemediationConfig = NonNullable<MutableDaemonConfig["remediation"]>;
export type RemediationEscalationConfig = NonNullable<RemediationConfig["escalation"]>;
export type RemediationConditionOverride = NonNullable<RemediationConfig["conditions"]>[string];
export type StalledAgentSweepConfig = NonNullable<RemediationConfig["stalledAgents"]>;
export type DiskRemediationConfig = NonNullable<RemediationConfig["disk"]>;
export type WorkSnapshotsConfig = NonNullable<RemediationConfig["workSnapshots"]>;
export type RemediationTaskClass = NonNullable<RemediationEscalationConfig["taskClass"]>;

const GIBIBYTE = 1024 ** 3;

export interface ResolvedRemediationEscalationConfig {
  enabled: boolean;
  /** Provider a remediation agent is created with. The classifier still decides the account. */
  provider: string;
  taskClass: RemediationTaskClass;
  /** The `paseo.budget` label, and the token ceiling the ladder cancels an agent at. */
  budgetTokens: number;
  /** Per condition key: after an escalation, how long before the same key may escalate again. */
  cooldownMinutes: number;
  /** An agent that has not reported by then is cancelled and counted as not fixed. */
  timeoutMinutes: number;
  maxConcurrent: number;
  maxPerDay: number;
}

export function resolveRemediationEscalationConfig(
  config: RemediationConfig | undefined,
): ResolvedRemediationEscalationConfig {
  const escalation = config?.escalation;
  return {
    enabled: escalation?.enabled ?? true,
    provider: escalation?.provider ?? "claude",
    taskClass: escalation?.taskClass ?? "standard",
    budgetTokens: escalation?.budgetTokens ?? 2_000_000,
    cooldownMinutes: escalation?.cooldownMinutes ?? 240,
    timeoutMinutes: escalation?.timeoutMinutes ?? 45,
    maxConcurrent: escalation?.maxConcurrent ?? 2,
    maxPerDay: escalation?.maxPerDay ?? 12,
  };
}

export function isRemediesRungEnabled(config: RemediationConfig | undefined): boolean {
  return config?.remedies?.enabled ?? true;
}

export function isNotifyRungEnabled(config: RemediationConfig | undefined): boolean {
  return config?.notify?.enabled ?? true;
}

export interface ResolvedStalledAgentSweepConfig {
  enabled: boolean;
  dryRun: boolean;
  /** No timeline, usage or process-tree activity for this long while `running` is a stall. */
  stallMinutes: number;
  /** The same, for an agent whose account is at its cap: the cause is already known. */
  deadAccountStallMinutes: number;
  /** After a nudge, how long the agent has to show activity before the ladder escalates. */
  recheckMinutes: number;
  /** Process-tree CPU at or below this counts as idle. */
  idleCpuPercent: number;
  maxNudgesPerSweep: number;
  /** Snapshot the agent's worktree before nudging it. */
  snapshot: boolean;
}

export function resolveStalledAgentSweepConfig(
  config: RemediationConfig | undefined,
): ResolvedStalledAgentSweepConfig {
  const stalled = config?.stalledAgents;
  return {
    enabled: (stalled?.enabled ?? true) && isRemediesRungEnabled(config),
    dryRun: stalled?.dryRun ?? false,
    stallMinutes: stalled?.stallMinutes ?? 30,
    deadAccountStallMinutes: stalled?.deadAccountStallMinutes ?? 5,
    recheckMinutes: stalled?.recheckMinutes ?? 20,
    idleCpuPercent: stalled?.idleCpuPercent ?? 5,
    maxNudgesPerSweep: stalled?.maxNudgesPerSweep ?? 4,
    snapshot: stalled?.snapshot ?? true,
  };
}

export interface ResolvedDiskRemediationConfig {
  enabled: boolean;
  /** Free space below this is low. The disk sweeper's `minFreeGB` stays the critical floor. */
  lowFreeBytes: number;
  /** Free space falling by this much within `fallWindowMinutes` is falling fast. */
  fallBytes: number;
  fallWindowMinutes: number;
  /** Directories sampled for growth evidence. Undefined: the built-in list. */
  growthRoots: readonly string[] | undefined;
  sampleTimeoutMs: number;
  /** Minimum time between two growth samples. */
  sampleIntervalMinutes: number;
}

export function resolveDiskRemediationConfig(
  config: RemediationConfig | undefined,
): ResolvedDiskRemediationConfig {
  const disk = config?.disk;
  return {
    enabled: (disk?.enabled ?? true) && isRemediesRungEnabled(config),
    lowFreeBytes: (disk?.lowFreeGB ?? 20) * GIBIBYTE,
    fallBytes: (disk?.fallGB ?? 20) * GIBIBYTE,
    fallWindowMinutes: disk?.fallWindowMinutes ?? 60,
    growthRoots: disk?.growthRoots,
    sampleTimeoutMs: disk?.sampleTimeoutMs ?? 120_000,
    sampleIntervalMinutes: disk?.sampleIntervalMinutes ?? 15,
  };
}

export interface ResolvedWorkSnapshotsConfig {
  enabled: boolean;
  dryRun: boolean;
  sweepMinutes: number;
  /** GitHub owners whose repos get the snapshot pushed as a `backup/...` branch. */
  personalOwners: readonly string[];
  /** Where bundles go for every other repo. Undefined: `$PASEO_HOME/backups`. */
  bundleDir: string | undefined;
  maxUntrackedFileBytes: number;
  maxPerSweep: number;
}

export function resolveWorkSnapshotsConfig(
  config: RemediationConfig | undefined,
): ResolvedWorkSnapshotsConfig {
  const snapshots = config?.workSnapshots;
  return {
    enabled: (snapshots?.enabled ?? true) && isRemediesRungEnabled(config),
    dryRun: snapshots?.dryRun ?? false,
    sweepMinutes: snapshots?.sweepMinutes ?? 60,
    personalOwners: snapshots?.personalOwners ?? ["funkmastert"],
    bundleDir: snapshots?.bundleDir,
    maxUntrackedFileBytes: snapshots?.maxUntrackedFileBytes ?? 20 * 1024 * 1024,
    maxPerSweep: snapshots?.maxPerSweep ?? 10,
  };
}
