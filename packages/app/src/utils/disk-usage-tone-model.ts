/**
 * Absolute disk-usage severity for a workspace's sampled worktree size.
 *
 * Unlike `token-burn-tone-model.ts`, this is not relative to siblings — a byte count has fixed
 * meaning regardless of what else is in the sidebar, so the thresholds are flat constants rather
 * than something derived from the visible pool. There is no "no chip" tone in the return type:
 * `undefined` is that state, for a workspace that hasn't been sampled yet or that sits below the
 * floor and isn't worth a row's attention.
 */
export type DiskUsageTone = "muted" | "warning" | "danger";

/** Binary (1024-based) GiB, matching the server's `du -sk` sampling. */
const GIB_BYTES = 1024 ** 3;

/** Below this, a workspace's disk footprint isn't worth surfacing on every row. */
export const DISK_USAGE_FLOOR_BYTES = GIB_BYTES;

/** At or above this, a workspace is worth a second look. */
export const DISK_USAGE_WARN_BYTES = 2 * GIB_BYTES;

/** At or above this, a workspace is worth archiving. */
export const DISK_USAGE_DANGER_BYTES = 10 * GIB_BYTES;

/**
 * The tone for a sampled byte count, or `undefined` when nothing should be shown at all —
 * unsampled (`bytes` is `undefined`) or below the floor. Never a fabricated "calm" tone for the
 * common case: most workspaces simply don't earn a chip.
 */
export function resolveDiskUsageTone(bytes: number | undefined): DiskUsageTone | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < DISK_USAGE_FLOOR_BYTES) return undefined;
  if (bytes >= DISK_USAGE_DANGER_BYTES) return "danger";
  if (bytes >= DISK_USAGE_WARN_BYTES) return "warning";
  return "muted";
}

/**
 * A byte count as the size chip reads it: binary GiB, one decimal place, always labeled "GB" —
 * "GiB" is correct but is jargon nobody outside storage engineering asks for.
 */
export function formatDiskUsageSize(bytes: number): string {
  const gib = bytes / GIB_BYTES;
  return `${gib.toFixed(1)} GB`;
}
