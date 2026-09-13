/**
 * Push-notification `data.reason` values for the worktree disk sweeper. Untyped JSON on the
 * wire, mirroring token-burn-notification.ts's shape: these payloads never cross the app i18n
 * pipeline, they're built server-side and sent verbatim to the push provider. Unlike a
 * token-burn breach, none of these carry an `agentId` — a swept worktree may back zero, one, or
 * several archived workspace records, so there is no single agent to deep-link into. Old apps
 * fall back to opening the workspaces list.
 */
export type DiskSweepNotificationReason =
  | "disk_sweep_reclaimed"
  | "disk_sweep_unsafe_orphan"
  | "disk_space_critical";

export interface DiskSweepNotificationData {
  [key: string]: unknown;
  serverId: string;
  reason: DiskSweepNotificationReason;
}

export interface DiskSweepNotificationPayload {
  title: string;
  body: string;
  data: DiskSweepNotificationData;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

interface BuildDiskSweepReclaimedNotificationPayloadInput {
  serverId: string;
  /** Directories deleted since the last notification of this kind. */
  count: number;
  /** Total bytes freed, sampled just before each directory was deleted. */
  bytes: number;
}

/**
 * One push per batch of reclaims rather than one per directory — the sweeper runs every
 * `sweepIntervalMs` (default 10 minutes) and caps itself at `maxDeletionsPerTick`, so a backlog
 * sweep could otherwise page the user repeatedly for routine cleanup.
 */
export function buildDiskSweepReclaimedNotificationPayload(
  input: BuildDiskSweepReclaimedNotificationPayloadInput,
): DiskSweepNotificationPayload {
  const title = "Reclaimed disk space";
  const body =
    input.count === 1
      ? `Deleted 1 abandoned worktree, freeing ${formatGigabytes(input.bytes)}.`
      : `Deleted ${input.count} abandoned worktrees, freeing ${formatGigabytes(input.bytes)}.`;

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      reason: "disk_sweep_reclaimed",
    },
  };
}

interface BuildDiskSweepUnsafeOrphanNotificationPayloadInput {
  serverId: string;
  /** On-disk path the sweeper won't touch (dirty checkout, ahead of origin, or unresolvable git status). */
  path: string;
}

/**
 * Re-armed once/day per path by the caller (see worktree-disk-monitor.ts) rather than firing
 * every tick — an unsafe orphan usually stays unsafe for a while, and the fix is a human
 * decision (commit/push/discard), not something a repeated push accelerates.
 */
export function buildDiskSweepUnsafeOrphanNotificationPayload(
  input: BuildDiskSweepUnsafeOrphanNotificationPayloadInput,
): DiskSweepNotificationPayload {
  return {
    title: "Worktree needs attention",
    body: `${input.path} has uncommitted or unpushed work and won't be auto-deleted.`,
    data: {
      serverId: input.serverId,
      reason: "disk_sweep_unsafe_orphan",
    },
  };
}

interface BuildDiskSpaceCriticalNotificationPayloadInput {
  serverId: string;
  freeBytes: number;
  minFreeGB: number;
}

/**
 * Fires once per crossing below `minFreeGB` and clears on recovery (see worktree-disk-monitor.ts's
 * emergency check) rather than once per tick while low — the state, not the notification, is
 * what matters between the two edges.
 */
export function buildDiskSpaceCriticalNotificationPayload(
  input: BuildDiskSpaceCriticalNotificationPayloadInput,
): DiskSweepNotificationPayload {
  return {
    title: "Disk space critically low",
    body: `Only ${formatGigabytes(input.freeBytes)} free, below the ${input.minFreeGB} GB threshold. An emergency sweep is running.`,
    data: {
      serverId: input.serverId,
      reason: "disk_space_critical",
    },
  };
}
